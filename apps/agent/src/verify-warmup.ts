/* 0.17 传感器预热框架自检（docs/气体传感器预热方案.md v2）。
 *
 *   pnpm warmup:verify                  只跑不需要环境的（判定逻辑、参数、规则开关、配置哈希、转换程序 q 的新鲜度）
 *   pnpm warmup:verify -- --live        另连一套在跑的 agent + 仿真器 + 总线（约 4 分钟）：启动即发、总线抖动、断电再来电、型号自报
 *
 * --live 的前提：一套与开发样机隔离的 agent / 仿真器 / 总线（不要连 AH03 那套 lsa-eg-*）。eg.yaml 里要有一台 attrs.warmupS: 40 的 pm 设备
 * （「虚拟气体设备」，PM6 代用 —— 气体点表等 T08）。agent 要刚起（30 s 内）才能查「启动即发」。地址用环境变量：
 *   EG_CONFIG_DIR（agent 的配置目录，取本地口令）、EG_AGENT_URL、EMU_URL、EG_BUS_MQTT */
import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mqtt from 'mqtt'
import { BUS_TOPIC, loadConfig, type EgConfig } from '@lsa-eg/config'
import { agent, AGENT, BUS, check, done, EMU, post, sleep } from './verify/lib.js'
import { configHash, filterRules, warmupTypeOf } from './apply/apply.service.js'
import { CapsService } from './caps/caps.service.js'
import { QualityService } from './quality/quality.service.js'
import type { BusService } from './bus/bus.service.js'
import { bootTrigger, DEFAULT_GAS, deviceWarmupS, parseGas, warmupDevice, WarmupTracker } from './warmup/warmup.js'
import { WarmupService } from './warmup/warmup.service.js'

const LIVE = process.argv.includes('--live')
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
  check(warmupDevice({ kind: 'pm', attrs: { warmup: true } }) && warmupDevice({ kind: 'pm', attrs: { warmupS: 40 } }) && !warmupDevice({ kind: 'pm', attrs: {} }), 'eg.yaml 属性 warmup: true / warmupS 是数 → 要；没写 → 不要（T08 前没有缺省要预热的种类）')
  check(!warmupDevice({ kind: 'pm', attrs: { warmupS: 0 } }) && deviceWarmupS({ warmupS: 1000 }, DEFAULT_GAS) === 900 && deviceWarmupS({}, { ...DEFAULT_GAS, warmupS: 120 }) === 120, 'warmupS: 0 = 这台不做；按设备覆盖限在 0–900；没写用站级')

  console.log('4. 规则开关连带降级那支「预热期读数越限（原类型）」')
  const def = (alarmType: string, sev: string[]) => ({ id: alarmType, alarmType, createRules: Object.fromEntries(sev.map(s => [s, {}])) })
  const alarms = [def('烟气', ['MAJOR']), def(warmupTypeOf('烟气'), ['WARNING']), def('过温', ['MAJOR', 'CRITICAL']), def(warmupTypeOf('过温'), ['WARNING'])]
  const types = (rs: { id: string; on: boolean }[]) =>
    filterRules(alarms, rs)
      .map(a => `${a.alarmType}:${Object.keys(a.createRules).join('+')}`)
      .join(' ')
  check(types([{ id: 'EG-pm', on: false }]) === `过温:MAJOR+CRITICAL ${warmupTypeOf('过温')}:WARNING`, '停 EG-pm：烟气与它的降级那支一起去掉', types([{ id: 'EG-pm', on: false }]))
  check(types([{ id: 'EG-rise', on: false }]).includes(`${warmupTypeOf('过温')}:WARNING`) && types([{ id: 'EG-rise', on: false }]).includes('过温:CRITICAL '), '只停 EG-rise（过温一级）：过温剩 CRITICAL，降级那支还在')
  check(!types([{ id: 'EG-rise', on: false }, { id: 'EG-rise2', on: false }]).includes('过温'), '过温两级都停：降级那支也去掉')
  check(types([]) === alarms.map(a => `${a.alarmType}:${Object.keys(a.createRules).join('+')}`).join(' '), '都开着：原样')

  console.log('5. 配置哈希：没带预热参数时与老哈希一致')
  const base = { thresholds: [{ key: 'rise', mv: 50 }], rules: [{ id: 'EG-rise', on: true }], extras: { pdCnt: 20, pm25Abs: 75, commPeriods: 5 }, caps: null, devComm: null, meters: null }
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
      devices: [{ name: 'PM6-AH99', kind: 'pm', label: '', attrs: { warmupS: 40 } }],
    } as unknown as EgConfig
    let listener: ((dev: string, entries: { ts: number; values: Record<string, unknown> }[], own: boolean) => void) | null = null
    const bus = { onTelemetry: (fn: typeof listener) => (listener = fn), publish: () => undefined, live: new Map() } as unknown as BusService
    const caps = new CapsService()
    const warm = new WarmupService(cfg, caps)
    const q = new QualityService(cfg, bus, caps, warm)
    q.onModuleInit()
    try {
      const now = Date.now()
      listener!('PM6-AH99', [{ ts: now, values: { q: JSON.stringify({ 'pm.2.5': 'warmup' }) } }], false)
      check(q.warmupOf('PM6-AH99') === 1 && q.qualityOf('PM6-AH99')['pm.2.5'] === 'warmup', '转换程序标了 warmup（T1）：dev.warmup_s 报 1、q 里 pm.2.5 = warmup')
      // PM6 周期 10 s → 窗口 max(30 s, 5 × 10 s) × 2 = 100 s（只发了 q、没发读数：不会因读数中断提前报满额，单测新鲜度）
      check(q.warmupOf('PM6-AH99', now + 99_000) === 1, '99 s 后（窗口内）：还算数')
      check(q.warmupOf('PM6-AH99', now + 101_000) === 0 && q.qualityOf('PM6-AH99', now + 101_000)['pm.2.5'] !== 'warmup', '101 s 后（转换程序挂了、没再发）：不再算数，不会永远停在「预热」')
      listener!('PM6-AH99', [{ ts: now, values: { q: '{}' } }], false)
      check(q.warmupOf('PM6-AH99') === 0, '转换程序发 "{}"：清掉')
      check(q.warmupOf('SAM-AH99-A') === null, '不是需要预热的设备：null（不发 dev.warmup_s）')
    } finally {
      q.onModuleDestroy()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
  const gas = cfg.devices.find(d => d.kind === 'pm' && typeof d.attrs['warmupS'] === 'number')
  if (!gas) throw new Error('eg.yaml 里没有 attrs.warmupS 的 pm 设备（虚拟气体设备）')
  const S = gas.attrs['warmupS'] as number
  const name = gas.name
  console.log(`\n7. 联机（agent ${AGENT}、仿真器 ${EMU}、总线 ${BUS}；虚拟气体设备 ${name}，预热 ${S} s）`)
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

    console.log(`   场景二：断电再来电（断 70 s，来电后 30 s 内 pm.2.5 偏高 300）`)
    const t0 = Date.now()
    await post(`${EMU}/emu/dev/${name}/powercycle?off=70&spikeKey=pm.2.5&spikeValue=300&spikeS=30`)
    await sleep(64_000)
    const pre = await dev()
    check(pre.warmupS === S, `断满 60 s、还没来电：提前报满额 ${S}（实际 ${pre.warmupS}）`)
    // 来电后各量陆续到（pm.2.5 每秒、其余按 10 s 档）：没到的还是 invalid（优先级高于 warmup），等都到了再看
    let back: Dev | null = null
    let lastSeen: Dev | null = null
    for (let i = 0; i < 25 && !back; i++) {
      await sleep(1000)
      const d = (lastSeen = await dev())
      const pmQ = Object.entries(d.q).filter(([k]) => k.startsWith('pm.'))
      if (Date.now() - t0 > 71_000 && (d.warmupS ?? 0) > 0 && pmQ.length && pmQ.every(([, v]) => v === 'warmup')) back = d
    }
    check(!!back && back.comm.comm === 'DEGRADED', `来电后各量到齐：预热中，pm.* 都标 warmup、dev.comm = DEGRADED（剩 ${back?.warmupS} s）`, JSON.stringify(lastSeen?.q))
    // 竞态：来电后的第一条测量值之前，dev.warmup_s > 0 已经在总线上了
    const firstMeas = log.find(m => !m.own && m.at > t0 + 65_000 && Object.keys(m.values).some(k => k.startsWith('pm.')))
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
    await post(`${EMU}/emu/dev/${name}/powercycle?off=10&spikeKey=pm.2.5&spikeValue=300&spikeS=20&selfq=1`)
    let selfW: Dev | null = null
    for (let i = 0; i < 20 && !selfW; i++) {
      await sleep(1000)
      const d = await dev()
      if (d.q['pm.2.5'] === 'warmup' && (d.warmupS ?? 0) >= 1) selfW = d
    }
    check(!!selfW, `转换程序标了 warmup：dev.warmup_s 至少 1（${selfW?.warmupS}）`)
    let clear: Dev | null = null
    for (let i = 0; i < 30 && !clear; i++) {
      await sleep(1000)
      const d = await dev()
      if (d.warmupS === 0 && !Object.values(d.q).includes('warmup')) clear = d
    }
    check(!!clear, '转换程序发 "{}" 之后：回到 0')
  } finally {
    await bus.endAsync()
  }
}

async function main() {
  console.log(`传感器预热框架自检${LIVE ? '（含联机）' : '（加 --live 连隔离的 agent + 仿真器）'}\n`)
  logic()
  quality()
  if (LIVE) await live()
  done()
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
