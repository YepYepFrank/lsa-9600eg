/* 0.17 传感器预热框架自检（docs/气体传感器预热方案.md v2）。
 *
 *   pnpm warmup:verify                  只跑不需要环境的（判定逻辑、参数、规则开关、配置哈希、转换程序 q 的新鲜度）
 *   pnpm warmup:verify -- --live        另连一套在跑的 agent + 仿真器 + 总线（约 4 分钟）：启动即发、总线抖动、断电再来电、型号自报、读数与 dev.warmup_s 同行上送
 *   pnpm warmup:verify -- --tb <URL>    另在一个一次性 TB 上验安全兜底（约 1 分钟；租户 tenant@thingsboard.org / tenant，LOAD_DEMO 建的库）：
 *                                       dev.warmup_s 从没上送、读数越限 → 正式告警必须触发（seedWarmupKey 预置 0）；正在预热的不能被预置覆盖
 *
 * --live 的前提：一套与开发样机隔离的 agent / 仿真器 / 总线（不要连 AH03 那套 lsa-eg-*）。eg.yaml 里要有一台 attrs.warmupS: 40 的 SAM
 * （0.7.1 起烟雾是 SAM 气体传感器的 smoke.ppm，PM6 取消；预热只管 SAM 的 smoke.*）。agent 要刚起（30 s 内）才能查「启动即发」。地址用环境变量：
 *   EG_CONFIG_DIR（agent 的配置目录，取本地口令）、EG_AGENT_URL、EMU_URL、EG_BUS_MQTT */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mqtt from 'mqtt'
import Database from 'better-sqlite3'
import { toTbAlarms, warmupTypeOf, WARMUP_KEY, type RuleSpec } from '@lsa/model'
import { BUS_TOPIC, loadConfig, type EgConfig } from '@lsa-eg/config'
import { agent, AGENT, BUS, check, done, EMU, post, sleep } from './verify/lib.js'
import { configHash, filterRules, seedWarmupKey } from './apply/apply.service.js'
import { CapsService } from './caps/caps.service.js'
import { QualityService } from './quality/quality.service.js'
import type { BusService } from './bus/bus.service.js'
import { bootTrigger, DEFAULT_GAS, deviceWarmupS, parseGas, warmupDevice, warmupScope, WarmupTracker } from './warmup/warmup.js'
import { WarmupService } from './warmup/warmup.service.js'

const LIVE = process.argv.includes('--live')
const TB_URL = process.argv.includes('--tb') ? process.argv[process.argv.indexOf('--tb') + 1] : undefined
const throws = (fn: () => unknown) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

function logic(): void {
  console.log('1. 参数（extras.gasWarmupS / gasGapS / gasBootWarmupOffCabs）')
  check(parseGas({ pdCnt: 20 }) === null, '一个都没带：null（用缺省、不计哈希）')
  check(JSON.stringify(parseGas({ gasWarmupS: 120 })) === JSON.stringify({ warmupS: 120, gapS: 60, bootOffCabs: [] }), '只带一个：其余取缺省 60 / []')
  check(JSON.stringify(parseGas({ gasWarmupS: 0, gasGapS: 600, gasBootWarmupOffCabs: ['AH05', 'AH02', 'AH05'] })) === JSON.stringify({ warmupS: 0, gapS: 600, bootOffCabs: ['AH02', 'AH05'] }), '边界值 0 / 600 收下；柜号去重排序')
  check(
    [{ gasWarmupS: 901 }, { gasWarmupS: -1 }, { gasWarmupS: 1.5 }, { gasWarmupS: '180' }, { gasGapS: 29 }, { gasGapS: 601 }, { gasBootWarmupOffCabs: 'AH01' }, { gasBootWarmupOffCabs: [1] }].every(e => throws(() => parseGas(e))),
    '超范围 / 非整数 / 类型不对：报错（ApplyService 回 BAD_REQUEST）',
  )

  console.log('2. 判定（T2 读数中断后恢复、T3 主机刚开机）')
  const t = new WarmupTracker()
  const S = 40
  const G = 60
  check(t.read(0, S, G) === null && t.remaining(0, S, G) === 0, '第一次读到（agent 刚起）：不算')
  check(t.read(15_000, S, G) === null && t.remaining(15_000, S, G) === 0, '中断 15 s（总线抖动）：不进预热')
  check(t.remaining(15_000 + 59_000, S, G) === 0 && t.remaining(15_000 + 60_000, S, G) === S, '中断满 60 s 还没读到：提前报满额（读数回来前 TB 就已在预热）')
  check(t.read(15_000 + 70_000, S, G) === 'T2' && t.remaining(85_000, S, G) === 40, '中断 70 s 后读到：T2，进预热 40 s')
  check(t.remaining(85_000 + 39_500, S, G) === 1 && t.remaining(85_000 + 40_000, S, G) === 0 && t.until === null, '到点就绪（剩 1 s → 0），状态清掉')
  t.read(130_000, S, G)
  check(t.read(130_000 + 61_000, S, G) === 'T2' && t.read(130_000 + 61_000 + 10_000, S, G) === null && t.remaining(130_000 + 61_000 + 10_000, S, G) === 30, '预热中再读到不重新计时（只有新的触发才重新计时）')
  const b = new WarmupTracker()
  b.bootArmed = true
  check(b.remaining(0, S, G) === S && b.read(5_000, S, G) === 'T3' && b.remaining(5_000, S, G) === S && !b.bootArmed, 'T3 武装：读到数前报满额，第一次读到时开始计时')
  const z = new WarmupTracker()
  z.read(0, 0, G)
  check(z.read(100_000, 0, G) === null && z.remaining(100_000, 0, G) === 0, '预热时长 0 = 关：不进预热、一直报 0')
  check(bootTrigger({ uptimeS: 90, warmupS: 180, hostBootId: null, lastHostBootId: null }), 'T3：开机 90 s < 180 s')
  check(bootTrigger({ uptimeS: 900, warmupS: 180, hostBootId: 'b', lastHostBootId: 'a' }), 'T3：开机已久但 hostBootId 变了（agent 起得晚）')
  check(!bootTrigger({ uptimeS: 900, warmupS: 180, hostBootId: 'a', lastHostBootId: 'a' }) && !bootTrigger({ uptimeS: 900, warmupS: 180, hostBootId: null, lastHostBootId: 'a' }), '只是 agent 重启（hostBootId 没变 / 读不到）：不算')
  check(!bootTrigger({ uptimeS: 10, warmupS: 0, hostBootId: 'b', lastHostBootId: 'a' }), '预热时长 0：不算')

  console.log('3. 哪些设备要预热')
  check(warmupDevice({ kind: 'sam', attrs: { warmup: true } }) && warmupDevice({ kind: 'sam', attrs: { warmupS: 40 } }) && !warmupDevice({ kind: 'sam', attrs: {} }), 'eg.yaml 属性 warmup: true / warmupS 是数 → 要；没写 → 不要（子站按规则里带预热的设备标 warmup: true）')
  const sc = warmupScope('sam')
  check(sc('smoke.ppm') && !sc('us.amp') && !sc('env.t') && warmupScope('meter')('el.Ia'), 'SAM 只有 smoke.* 归预热管（局放、温湿度不管）；别的种类整台')
  check(!warmupDevice({ kind: 'sam', attrs: { warmupS: 0 } }) && deviceWarmupS({ warmupS: 1000 }, DEFAULT_GAS) === 900 && deviceWarmupS({}, { ...DEFAULT_GAS, warmupS: 120 }) === 120, 'warmupS: 0 = 这台不做；按设备覆盖限在 0–900；没写用站级')

  console.log('4. 规则开关连带降级那支「预热期读数越限（原类型）」')
  const def = (alarmType: string, sev: string[]) => ({ id: alarmType, alarmType, createRules: Object.fromEntries(sev.map(s => [s, {}])) })
  const alarms = [def('烟气', ['MAJOR']), def(warmupTypeOf('烟气'), ['WARNING']), def('过温', ['MAJOR', 'CRITICAL']), def(warmupTypeOf('过温'), ['WARNING'])]
  const types = (rs: { id: string; on: boolean }[]) =>
    filterRules(alarms, rs)
      .map(a => `${a.alarmType}:${Object.keys(a.createRules).join('+')}`)
      .join(' ')
  check(types([{ id: 'EG-smoke', on: false }]) === `过温:MAJOR+CRITICAL ${warmupTypeOf('过温')}:WARNING`, '停 EG-smoke：烟气两级与它的降级那支一起去掉', types([{ id: 'EG-smoke', on: false }]))
  check(types([{ id: 'EG-rise', on: false }]).includes(`${warmupTypeOf('过温')}:WARNING`) && types([{ id: 'EG-rise', on: false }]).includes('过温:CRITICAL '), '只停 EG-rise（过温一级）：过温剩 CRITICAL，降级那支还在')
  check(!types([{ id: 'EG-rise', on: false }, { id: 'EG-rise2', on: false }]).includes('过温'), '过温两级都停：降级那支也去掉')
  check(types([]) === alarms.map(a => `${a.alarmType}:${Object.keys(a.createRules).join('+')}`).join(' '), '都开着：原样')

  console.log('5. 配置哈希：没带预热参数时与老哈希一致')
  const base = { thresholds: [{ key: 'rise', mv: 50 }], rules: [{ id: 'EG-rise', on: true }], extras: { pdCnt: 20, commPeriods: 5 }, caps: null, devComm: null, meters: null }
  const legacy = configHash({ ...base, gas: undefined })
  check(configHash({ ...base, gas: null }) === legacy, '不带预热参数：哈希不变（升级后同一份配置不会被当成新内容）')
  check(configHash({ ...base, gas: { warmupS: 180, gapS: 60, bootOffCabs: [] } }) !== legacy, '带了：计进哈希（改参数会重新应用）')
}

/** 转换程序 q 的新鲜度、型号自报（T1）时 dev.warmup_s 至少 1 —— 拿真的 QualityService / WarmupService，假总线 */
function quality(): void {
  console.log('6. 转换程序发的 q：新鲜度窗口（同 dev.*）')
  const dir = mkdtempSync(join(tmpdir(), 'lsa-warmup-'))
  try {
    const cfg = {
      dir,
      cabinet: { code: 'AH99', group: 'mv' },
      eg: { name: 'EG-AH99', attrs: {} },
      devices: [{ name: 'SAM-AH99-A', kind: 'sam', label: '', attrs: { warmupS: 40 } }],
    } as unknown as EgConfig
    let listener: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
    const sent: { dev: string; values: Record<string, unknown>; ts: number }[] = []
    const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: (dev: string, values: Record<string, unknown>, ts: number) => sent.push({ dev, values, ts }), live: new Map() } as unknown as BusService
    const caps = new CapsService()
    const warm = new WarmupService(cfg, caps)
    const q = new QualityService(cfg, bus, caps, warm)
    q.onModuleInit()
    try {
      const now = Date.now()
      const D = 'SAM-AH99-A'
      listener!(D, [{ ts: now, values: { q: JSON.stringify({ 'smoke.ppm': 'warmup' }) } }], false)
      check(q.warmupOf(D) === 1 && q.qualityOf(D)['smoke.ppm'] === 'warmup', '转换程序标了 warmup（T1）：dev.warmup_s 报 1、q 里 smoke.ppm = warmup')
      // SAM 最快的量 2 s，但 devComm 缺省 minMs 30 s → 窗口 max(30 s, 5 × 2 s) × 2 = 60 s（只发了 q、没发读数：单测新鲜度）
      check(q.warmupOf(D, now + 59_000) === 1, '59 s 后（窗口内）：还算数')
      check(q.warmupOf(D, now + 61_000) === 0 && q.qualityOf(D, now + 61_000)['smoke.ppm'] !== 'warmup', '61 s 后（转换程序挂了、没再发）：不再算数，不会永远停在「预热」')
      listener!(D, [{ ts: now, values: { q: '{}' } }], false)
      check(q.warmupOf(D) === 0, '转换程序发 "{}"：清掉')
      check(q.warmupOf('SAM-AH99-B') === null, '不是需要预热的设备：null（不发 dev.warmup_s）')
      sent.length = 0
      const ts = now - 1234
      listener!(D, [{ ts, values: { 'smoke.ppm': 31, 'us.amp': 5 } }], false)
      const w = sent.find(x => x.dev === D && WARMUP_KEY in x.values)
      check(!!w && w.ts === ts && w.values[WARMUP_KEY] === 0, `每条读数后马上补发一条同一时刻的 dev.warmup_s（ts 与读数相同：${w?.ts === ts}，值 ${String(w?.values[WARMUP_KEY])}）`)
    } finally {
      q.onModuleDestroy()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 0.7.1：SAM 的预热只管气体那路 —— 局放的读数不驱动预热计时、预热中只有 smoke.* 标 warmup */
function samScope(): void {
  console.log('7. SAM 的预热只管气体那路（0.7.1）')
  const dir = mkdtempSync(join(tmpdir(), 'lsa-warmup-'))
  try {
    const cfg = {
      dir,
      cabinet: { code: 'AH99', group: 'mv' },
      unit: { id: 'A', code: 'AH99-A', at: '', index: 0 },
      eg: { name: 'EG-AH99-A', attrs: {} },
      devices: [{ name: 'SAM-AH99-A', kind: 'sam', label: '', attrs: { warmupS: 40 } }],
    } as unknown as EgConfig
    let listener: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
    const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: () => undefined, live: new Map() } as unknown as BusService
    const caps = new CapsService()
    const warm = new WarmupService(cfg, caps)
    // 主机刚开机（10 s < 预热 180 s）：武装，下一次读到「气体」时开始计时
    warm.uptimeS = () => 10
    warm.onModuleInit()
    const q = new QualityService(cfg, bus, caps, warm)
    q.onModuleInit()
    try {
      const D = 'SAM-AH99-A'
      listener!(D, [{ ts: Date.now(), values: { 'us.amp': 5, 'env.t': 26 } }], false)
      check(warm.waiting(D), '只来了局放 / 温湿度：还在等气体的第一次读数（局放不驱动预热计时）')
      const q1 = q.qualityOf(D)
      check(q1['smoke.ppm'] === 'warmup' && q1['us.amp'] !== 'warmup' && q1['env.t'] !== 'warmup', `预热中只有 smoke.ppm 标 warmup，局放、温湿度不标（q：${JSON.stringify(q1)}）`)
      listener!(D, [{ ts: Date.now(), values: { 'smoke.ppm': 12 } }], false)
      const r = warm.remaining(D)
      check(!warm.waiting(D) && r > 35 && r <= 40, `气体读到了：开始计时（剩 ${r} s，预热 40 s）`)
    } finally {
      q.onModuleDestroy()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 安全兜底（协调要求）：dev.warmup_s 从没上送、读数越限，正式告警必须触发 —— 一次性 TB 实测 seedWarmupKey */
async function tbSafety(url: string): Promise<void> {
  console.log(`\n9. 安全兜底：dev.warmup_s 从没上送时正式告警照常（一次性 TB ${url}）`)
  const login = async () => ((await (await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tenant@thingsboard.org', password: 'tenant' }) })).json()) as { token: string }).token
  const jwt = await login()
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', 'X-Authorization': `Bearer ${jwt}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
    const t = await r.text()
    return (t ? JSON.parse(t) : null) as T
  }
  const tb = { get: <T>(p: string) => call<T>('GET', p), req: <T>(m: string, p: string, b?: unknown) => call<T>(m, p, b) }
  const SPEC: RuleSpec = { type: '自检气体越限', rule: '气体浓度越限', cls: 'dev', levels: [{ severity: 'MAJOR', when: [{ key: 'gas.ppm', op: 'GREATER', value: 50 }], forSeconds: 10 }], clearWhen: [{ key: 'gas.ppm', op: 'LESS_OR_EQUAL', value: 40 }], warmup: true }
  const name = `eg-warmup-safety-${Date.now()}`
  const prof = await call<{ id: { id: string }; name: string; profileData: { alarms: unknown } }>('POST', '/api/deviceProfile', {
    name, type: 'DEFAULT', transportType: 'DEFAULT',
    profileData: { configuration: { type: 'DEFAULT' }, transportConfiguration: { type: 'DEFAULT' }, provisionConfiguration: { type: 'DISABLED' }, alarms: toTbAlarms(SPEC) },
  })
  const mk = async (n: string) => {
    const d = await call<{ id: { id: string } }>('POST', '/api/device', { name: `${name}-${n}`, deviceProfileId: { id: prof.id.id, entityType: 'DEVICE_PROFILE' } })
    const c = await call<{ credentialsId: string }>('GET', `/api/device/${d.id.id}/credentials`)
    return { id: d.id.id, name: `${name}-${n}`, token: c.credentialsId }
  }
  const send = (d: { token: string }, v: Record<string, number>) => fetch(`${url}/api/v1/${d.token}/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })
  const hold = async (ds: { token: string }[], v: Record<string, number>, sec: number) => {
    for (let t = 0; t < sec; t += 2) {
      await Promise.all(ds.map(d => send(d, v)))
      await sleep(2000)
    }
  }
  const act = async (d: { id: string }) => (await call<{ data: { type: string; severity: string }[] }>('GET', `/api/alarm/DEVICE/${d.id}?searchStatus=ACTIVE&pageSize=20&page=0`)).data
  const fmt = (as: { type: string; severity: string }[]) => as.map(a => `${a.type}/${a.severity}`).join('、') || '无'
  // 不预置时正式那支永远不报（TB 条件里 key 没值判假）的基线：后端 tb-provision verify:warmup 的 f 项已实测
  const ds = await Promise.all(['never-flowing', 'never-before', 'warming'].map(mk))
  const [flowing, before, warming] = ds as [typeof ds[0], typeof ds[0], typeof ds[0]]
  try {
    // 已在发读数、从没发过 dev.warmup_s（TB 里告警状态已建）
    await hold([flowing], { 'gas.ppm': 30 }, 4)
    await send(warming, { [WARMUP_KEY]: 150 })
    await sleep(1000)
    const seeded = await seedWarmupKey(tb, [prof])
    check(seeded.length === 2 && seeded.includes(flowing.name) && seeded.includes(before.name) && !seeded.includes(warming.name),
      `只预置 TB 里没有 dev.warmup_s 的设备，正在预热（150）的不碰（预置了 ${seeded.length} 台）`)
    await hold([flowing, before, warming], { 'gas.ppm': 80 }, 16)
    type Al = { type: string; severity: string }[]
    const [a1, a2, a3] = (await Promise.all([flowing, before, warming].map(act))) as [Al, Al, Al]
    check(a1.length === 1 && a1[0]!.type === SPEC.type && a1[0]!.severity === 'MAJOR', `已在发读数、dev.warmup_s 从没上送，预置后越限 16 s：正式告警触发（${fmt(a1)}）`)
    check(a2.length === 1 && a2[0]!.type === SPEC.type && a2[0]!.severity === 'MAJOR', `先预置、之后才开始发读数，越限 16 s：正式告警触发（${fmt(a2)}）`)
    check(a3.length === 1 && a3[0]!.type === warmupTypeOf(SPEC.type) && a3[0]!.severity === 'WARNING', `正在预热（150）的：没被预置覆盖，只出降级告警（${fmt(a3)}）`)
    const again = await seedWarmupKey(tb, [prof])
    check(again.length === 0, `再跑一次（开机清扫）：都已有值，一台都不再预置（${again.length} 台）`)
  } finally {
    for (const d of ds) await call('DELETE', `/api/device/${d.id}`).catch(() => undefined)
    await call('DELETE', `/api/deviceProfile/${prof.id.id}`).catch(() => undefined)
  }
}

interface Dev {
  name: string
  q: Record<string, string>
  warmupS: number | null
  comm: { comm: string }
}

async function live(): Promise<void> {
  const cfg = loadConfig()
  const gas = cfg.devices.find(d => d.kind === 'sam' && typeof d.attrs['warmupS'] === 'number')
  if (!gas) throw new Error('eg.yaml 里没有 attrs.warmupS 的 SAM（气体传感器在 SAM 里，0.7.1）')
  const S = gas.attrs['warmupS'] as number
  const name = gas.name
  console.log(`\n8. 联机（agent ${AGENT}、仿真器 ${EMU}、总线 ${BUS}；气体在 ${name}，预热 ${S} s）`)
  const status = async () => (await agent<{ uptimeSec: number; devices: Dev[] }>(cfg.dir, '/api/status'))
  const dev = async () => (await status()).devices.find(d => d.name === name)!
  // 总线上记 dev.warmup_s（agent 发的）与测量值（仿真器发的）的到达时刻
  const log: { at: number; own: boolean; values: Record<string, unknown> }[] = []
  const bus = await mqtt.connectAsync(BUS, { protocolVersion: 5, clientId: `warmup-verify-${process.pid}` })
  await bus.subscribeAsync(BUS_TOPIC.telemetry(name))
  bus.on('message', (_t, buf, pkt) => {
    try {
      const m = JSON.parse(buf.toString()) as { values: Record<string, unknown> }
      log.push({ at: Date.now(), own: pkt.properties?.userProperties?.['src'] === 'eg-agent', values: m.values })
    } catch {
      /* 不是 JSON 不管 */
    }
  })
  try {
    const s0 = await status()
    const d0 = s0.devices.find(d => d.name === name)!
    const raw = await agent<{ telemetry: Record<string, { v: unknown; at: number }> }>(cfg.dir, `/api/live/${name}`).catch(() => null)
    check(s0.uptimeSec > 60 || (raw?.telemetry['dev.warmup_s'] !== undefined && d0.warmupS === 0), `启动即发：agent 起来 ${s0.uptimeSec} s，已发过 dev.warmup_s = ${String(raw?.telemetry['dev.warmup_s']?.v)}${s0.uptimeSec > 60 ? '（起来超过 60 s，这项不算数：重启 agent 后马上跑）' : ''}`)
    check(d0.warmupS === 0 && !Object.values(d0.q).includes('warmup'), `开始时就绪（dev.warmup_s ${d0.warmupS}）`)

    console.log('   场景一：总线抖动（断 15 s）')
    await post(`${EMU}/emu/dev/${name}/powercycle?off=15`)
    let maxW = 0
    for (let i = 0; i < 14; i++) {
      await sleep(2000)
      maxW = Math.max(maxW, (await dev()).warmupS ?? 0)
    }
    check(maxW === 0, `断 15 s 再恢复（等 28 s）：一直没进预热（dev.warmup_s 最大 ${maxW}）`)

    console.log(`   场景二：断电再来电（断 70 s，来电后 30 s 内 smoke.ppm 偏高 300）`)
    const t0 = Date.now()
    await post(`${EMU}/emu/dev/${name}/powercycle?off=70&spikeKey=smoke.ppm&spikeValue=300&spikeS=30`)
    await sleep(64_000)
    const pre = await dev()
    check(pre.warmupS === S, `断满 60 s、还没来电：提前报满额 ${S}（实际 ${pre.warmupS}）`)
    // 来电后各量陆续到（smoke.ppm 每秒、其余按各自的档）：没到的还是 invalid（优先级高于 warmup），等都到了再看
    let back: Dev | null = null
    let lastSeen: Dev | null = null
    for (let i = 0; i < 25 && !back; i++) {
      await sleep(1000)
      const d = (lastSeen = await dev())
      const gasQ = Object.entries(d.q).filter(([k]) => k.startsWith('smoke.'))
      if (Date.now() - t0 > 71_000 && (d.warmupS ?? 0) > 0 && gasQ.length && gasQ.every(([, v]) => v === 'warmup') && !Object.entries(d.q).some(([k, v]) => !k.startsWith('smoke.') && v === 'warmup')) back = d
    }
    check(!!back && back.comm.comm === 'DEGRADED', `来电后各量到齐：预热中，smoke.* 标 warmup（局放、温湿度不标）、dev.comm = DEGRADED（剩 ${back?.warmupS} s）`, JSON.stringify(lastSeen?.q))
    // 竞态：来电后的第一条测量值之前，dev.warmup_s > 0 已经在总线上了
    const firstMeas = log.find(m => !m.own && m.at > t0 + 65_000 && Object.keys(m.values).some(k => k.startsWith('smoke.')))
    const warmBefore = log.filter(m => m.own && m.at > t0 + 55_000 && typeof m.values['dev.warmup_s'] === 'number' && (m.values['dev.warmup_s'] as number) > 0)
    check(!!firstMeas && warmBefore.some(m => m.at < firstMeas.at), `来电后的第一条读数之前，dev.warmup_s > 0 已经发出（读数与它走两条路到 TB，防正式规则误判）`)
    const waitEnd = Date.now()
    let ready: Dev | null = null
    for (let i = 0; i < S + 15 && !ready; i++) {
      await sleep(1000)
      const d = await dev()
      if (d.warmupS === 0) ready = d
    }
    const took = Math.round((Date.now() - waitEnd) / 1000)
    check(!!ready && !Object.values(ready.q).includes('warmup'), `约 ${S} s 后就绪：dev.warmup_s = 0、q 不再有 warmup（再等了 ${took} s）`, JSON.stringify(ready?.q))
    // 接口读到 0 时，总线上那条 0 要到下一次评估（≤ 2 s）才发：等 3 s 再看序列
    await sleep(3000)
    // 评估每 2 s 一次、预热中满 10 s 重发 → 间隔 ≤ 12 s，留 1 s 余量
    const warmMsgs = log.filter(m => m.own && m.at > t0 && typeof m.values['dev.warmup_s'] === 'number')
    const seq = warmMsgs.map(m => `+${Math.round((m.at - t0) / 1000)}s=${String(m.values['dev.warmup_s'])}`).join(' ')
    const gaps = warmMsgs.slice(1).map((m, i) => ({ g: m.at - warmMsgs[i]!.at, prev: warmMsgs[i]!.values['dev.warmup_s'] as number }))
    const firstZero = warmMsgs.find(m => m.values['dev.warmup_s'] === 0 && m.at > t0 + 100_000)
    check(!!firstZero && gaps.filter(x => x.prev > 0).every(x => x.g <= 13_000), `dev.warmup_s：预热中 ≤ 12 s 发一次、结束马上发 0（共 ${warmMsgs.length} 条）`, seq)

    console.log('   场景三：型号自报（断 10 s 不触发 T2，来电后 20 s 内转换程序发 q:warmup）')
    await post(`${EMU}/emu/dev/${name}/powercycle?off=10&spikeKey=smoke.ppm&spikeValue=300&spikeS=20&selfq=1`)
    let selfW: Dev | null = null
    for (let i = 0; i < 20 && !selfW; i++) {
      await sleep(1000)
      const d = await dev()
      if (d.q['smoke.ppm'] === 'warmup' && (d.warmupS ?? 0) >= 1) selfW = d
    }
    check(!!selfW, `转换程序标了 warmup：dev.warmup_s 至少 1（${selfW?.warmupS}）`)
    let clear: Dev | null = null
    for (let i = 0; i < 30 && !clear; i++) {
      await sleep(1000)
      const d = await dev()
      if (d.warmupS === 0 && !Object.values(d.q).includes('warmup')) clear = d
    }
    check(!!clear, '转换程序发 "{}" 之后：回到 0')

    console.log('   读数与 dev.warmup_s：本机总线上同一时刻补发，上送子站并进同一行')
    const meas = log.filter(m => !m.own && Object.keys(m.values).some(k => k.startsWith('smoke.')))
    const pairs = meas.slice(-20).filter(m => log.some(o => o.own && WARMUP_KEY in o.values && Math.abs(o.at - m.at) < 1000))
    check(meas.length >= 5 && pairs.length === Math.min(20, meas.length), `总线：最近 ${Math.min(20, meas.length)} 条读数，每条 1 s 内都有 agent 补发的 dev.warmup_s（${pairs.length} 条）`)
    // 上送：隔离环境的子站地址是死的，行都积在 outbox 里 —— 只读打开看读数行
    const db = new Database(join(cfg.dir, 'outbox.db'), { readonly: true, fileMustExist: true })
    try {
      const rows = db.prepare("select body from outbox where dev = ? and kind = 't' order by seq desc limit 200").all(name) as { body: string }[]
      const withGas = rows.map(r => JSON.parse(r.body) as Record<string, unknown>).filter(v => Object.keys(v).some(k => k.startsWith('smoke.')))
      check(withGas.length > 0 && withGas.every(v => typeof v[WARMUP_KEY] === 'number'), `上送：outbox 里 ${name} 的气体读数行 ${withGas.length} 条，全都带 dev.warmup_s`)
    } finally {
      db.close()
    }
  } finally {
    await bus.endAsync()
  }
}

async function main() {
  console.log(`传感器预热框架自检${LIVE ? '（含联机）' : '（加 --live 连隔离的 agent + 仿真器）'}\n`)
  logic()
  quality()
  samScope()
  if (LIVE) await live()
  if (TB_URL) await tbSafety(TB_URL)
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
