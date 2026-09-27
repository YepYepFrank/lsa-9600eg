/* G1 自检：数据链路（派生量、质量码看护、EG 自身指标、南向统计、韧性）。
 *
 *   pnpm g1:verify              全部（约 5 分钟：含重启 Mosquitto / IoT Gateway）
 *   pnpm g1:verify -- --fast    只查不需要等的（约 3 分钟）
 *   pnpm g1:verify -- --tb      另外重启一次 EG 本地 TB（约 +2 分钟）
 *
 * 查的是 EG 本地 TB（开发计划 v0.4）。前提同 G0：dev:up、dev:emu、dev:agent（EG_DEBUG=1）在跑，本地 TB 已 provision:eg。
 * 断上行补传另见 i2:verify（上送 outbox）。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import mqtt from 'mqtt'
import { pointsOf } from '@lsa/points'
import { BUS_TOPIC, loadConfig, repoRoot } from '@lsa-eg/config'
import { agent, AGENT, BUS, check, containerMemMb, docker, done, EMU, env, maxGap, post, sleep, Tb, until, type Point } from './verify/lib.js'

const argv = process.argv.slice(2)
const FAST = argv.includes('--fast')
const RESTART_TB = argv.includes('--tb')
const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')

interface Dev {
  name: string
  kind: string
  dead: boolean
  ageSec: number | null
  q: Record<string, string>
  south: { req: number; timeout: number; rate: number | null } | null
}
interface Status {
  uptimeSec: number
  rssMb: number
  state: string
  devices: Dev[]
}
let cfgDir = ''
const status = () => agent<Status>(cfgDir, '/api/status')
const parseQ = (v: string | undefined) => {
  try {
    return (v ? JSON.parse(v) : null) as Record<string, string> | null
  } catch {
    return null
  }
}

async function main() {
  console.log(`G1 自检：数据链路${FAST ? '（--fast）' : ''}\n`)
  const cfg = loadConfig()
  cfgDir = cfg.dir
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const sam = cfg.devices.filter(d => d.kind === 'sam')
  const samA = sam[0]!.name
  const samB = (sam[1] ?? sam[0]!).name
  const meter = cfg.devices.find(d => d.kind === 'meter')!.name
  const pm = cfg.devices.find(d => d.kind === 'pm')!.name
  const sensors = cfg.devices.filter(d => d.kind !== 'camera').map(d => d.name)

  console.log('1. 《EG 内部 MQTT 格式》与点表目录一致')
  const doc = readFileSync(resolve(repoRoot()!, 'docs/EG内部MQTT格式.md'), 'utf8')
  const missing: string[] = []
  for (const kind of ['sam', 'meter', 'pm'] as const) {
    for (const p of pointsOf(kind, 'lv', true)) {
      // 分区测温文档里写成 ir.z01 … ir.z24
      const k = /^ir\.z\d\d$/.test(p.key) ? 'ir.z01' : p.key
      if (!doc.includes('`' + k + '`')) missing.push(p.key)
    }
  }
  check(!missing.length, '文档列出了点表目录里 SAM / 电表 / 颗粒物的每个量', missing.slice(0, 6).join(' '))
  check(/不要发的量[\s\S]*`el\.load_pct`/.test(doc), '文档写明负荷率由 eg-agent 算、同事不发')

  console.log('\n2. 初始状态：各设备质量有效')
  let st = await status()
  if (st.uptimeSec < 70) {
    console.log(`  （eg-agent 刚起 ${st.uptimeSec} s，等到 70 s 让南向统计出第一条）`)
    await sleep((70 - st.uptimeSec) * 1000)
    st = await status()
  }
  const badStart = st.devices.filter(d => d.kind !== 'camera' && Object.keys(d.q).length)
  check(!badStart.length, 'eg-agent 看各传感器质量全部有效', badStart.map(d => `${d.name}${JSON.stringify(d.q)}`).join(' '))
  for (const name of sensors) {
    const q = (await tb.latest(name, ['q']))['q']
    check(!!q && q.value === '{}' && Date.now() - q.ts < 90_000, `本地 TB 上 ${name} 的 q = "{}"（每分钟重发）`, q ? `${q.value}，${Math.round((Date.now() - q.ts) / 1000)} s 前` : '没有')
  }

  console.log('\n3. 派生量：负荷率')
  const rated = Number(cfg.devices.find(d => d.name === meter)!.attrs['rated'] ?? cfg.cabinet.rated)
  const now = Date.now()
  const hist = (k: string) => tb.history(meter, k, now - 30_000, now)
  const [ia, ib, ic, lp] = await Promise.all([hist('el.Ia'), hist('el.Ib'), hist('el.Ic'), hist('el.load_pct')])
  const at = (pts: Point[], ts: number) => pts.find(p => p.ts === ts)
  let same = 0
  const wrong: string[] = []
  for (const p of lp) {
    const a = at(ia, p.ts)
    const b = at(ib, p.ts)
    const c = at(ic, p.ts)
    if (!a || !b || !c) continue
    same++
    const want = Math.round((Math.max(+a.value, +b.value, +c.value) / rated) * 1000) / 10
    if (Math.abs(want - Number(p.value)) > 0.05) wrong.push(`${p.value}≠${want}`)
  }
  check(same >= 5 && !wrong.length, `el.load_pct = max(Ia,Ib,Ic) ÷ ${rated} A，与电流同一时刻`, `近 30 s 核对 ${same} 点${wrong.length ? `，不符：${wrong.slice(0, 3).join(' ')}` : ''}`)

  console.log('\n4. 设备属性（eg.yaml 里子站给的，由 eg-agent 发）')
  check(Number(await tb.attr(meter, 'CLIENT_SCOPE', 'rated')) === rated, `${meter} 的属性 rated = ${rated}（eg.yaml）`)
  check(!!(await tb.attr(samA, 'CLIENT_SCOPE', 'room')), `${samA} 有属性 room`)
  check(!!(await tb.attr(cfg.eg.name, 'CLIENT_SCOPE', 'agent')), `${cfg.eg.name} 有属性 agent（eg-agent 版本）`)

  console.log('\n5. EG 自身指标')
  const egKeys = ['eg.state', 'eg.lat', 'eg.loss', 'eg.cpu', 'eg.mem', 'eg.ssd', 'eg.clk_offset']
  const eg = await tb.latest(cfg.eg.name, egKeys)
  for (const k of egKeys) {
    const p = eg[k]
    const limit = k === 'eg.clk_offset' ? 90_000 : 15_000
    check(!!p && Date.now() - p.ts < limit, `${k} 新鲜`, p ? `${p.value}，${((Date.now() - p.ts) / 1000).toFixed(0)} s 前` : '没有（取不到时不发）')
  }
  check(eg['eg.state']?.value === 'online', 'eg.state = online')

  console.log('\n6. 南向统计')
  const south = await tb.latest(samA, ['dev.req_24h', 'dev.timeout_24h', 'dev.rate_24h'])
  const rate = Number(south['dev.rate_24h']?.value)
  check(!!south['dev.rate_24h'] && Date.now() - south['dev.rate_24h'].ts < 90_000 && rate >= 95, `${samA} dev.rate_24h ≥ 95 %`, `${south['dev.rate_24h']?.value ?? '—'}（req ${south['dev.req_24h']?.value ?? '—'}，timeout ${south['dev.timeout_24h']?.value ?? '—'}）`)

  console.log(`\n7. 质量码看护：${samA} 停发 env.t / env.rh，${pm} 整台停发`)
  await post(`${EMU}/emu/dev/${samA}/drop?keys=env.t,env.rh`)
  await post(`${EMU}/emu/dev/${pm}/dead?on=1`)
  let sawStale = false
  const hit = await until(
    async () => {
      const s = await status()
      const a = s.devices.find(d => d.name === samA)!
      if (a.q['env.t'] === 'stale') sawStale = true
      const qa = parseQ((await tb.latest(samA, ['q']))['q']?.value)
      const qp = parseQ((await tb.latest(pm, ['q']))['q']?.value)
      const egs = (await tb.latest(cfg.eg.name, ['eg.state']))['eg.state']?.value
      const pmKeys = pointsOf('pm', cfg.cabinet.group).map(p => p.key)
      return qa?.['env.t'] === 'invalid' && qa['env.rh'] === 'invalid' && !qa['us.amp'] && pmKeys.every(k => qp?.[k] === 'invalid') && egs === 'degraded'
        ? { qa, qp, s }
        : null
    },
    90_000,
  )
  check(sawStale, `${samA} 的 env.t 先标 stale（3 个周期）`)
  check(!!hit, `本地 TB：${samA} 的 env.t / env.rh = invalid、其余不受影响；${pm} 全部量 invalid；EG eg.state = degraded`, hit ? JSON.stringify(hit.qa) : '90 s 内没到')
  if (hit) {
    const p = hit.s.devices.find(d => d.name === pm)!
    check(p.dead && (p.south?.timeout ?? 0) > 0, `eg-agent：${pm} 整台失效、南向超时计数上涨`, `timeout ${p.south?.timeout}`)
  }
  await post(`${EMU}/emu/dev/${samA}/drop?keys=`)
  await post(`${EMU}/emu/dev/${pm}/dead?on=0`)
  const back = await until(
    async () => {
      const qa = (await tb.latest(samA, ['q']))['q']?.value
      const qp = (await tb.latest(pm, ['q']))['q']?.value
      const egs = (await tb.latest(cfg.eg.name, ['eg.state']))['eg.state']?.value
      return qa === '{}' && qp === '{}' && egs === 'online'
    },
    30_000,
  )
  check(!!back, '恢复后 30 s 内 q 回到 "{}"、eg.state 回到 online')

  console.log(`\n8. 同事自己发的 q 与看护结果合并（${samB}）`)
  const cli = await mqtt.connectAsync(BUS, { clientId: `g1-verify-${Date.now()}` })
  await cli.publishAsync(BUS_TOPIC.telemetry(samB), JSON.stringify({ ts: Date.now(), values: { q: JSON.stringify({ 'us.amp': 'invalid' }) } }), { qos: 1 })
  const merged = await until(async () => parseQ((await tb.latest(samB, ['q']))['q']?.value)?.['us.amp'] === 'invalid', 15_000, 1000)
  // 合并后 eg-agent 会紧接着发一条，最终留下的应是合并结果（不是被看护的 "{}" 冲掉）
  await sleep(4000)
  const still = parseQ((await tb.latest(samB, ['q']))['q']?.value)?.['us.amp'] === 'invalid'
  check(!!merged && still, '同事发 q {us.amp: invalid} → 保留（没被看护结果冲掉）')
  await cli.publishAsync(BUS_TOPIC.telemetry(samB), JSON.stringify({ ts: Date.now(), values: { q: '{}' } }), { qos: 1 })
  await cli.endAsync()
  check(!!(await until(async () => (await tb.latest(samB, ['q']))['q']?.value === '{}', 15_000, 1000)), '同事发 q "{}" → 清掉')

  console.log('\n9. eg-agent 停发时 IoT Gateway 维持 EG 在线')
  await post(`${AGENT}/api/_debug/self-pause?s=40`)
  const held = await until(async () => (await tb.latest(cfg.eg.name, ['eg.state']))['eg.state']?.value === 'degraded', 30_000, 1000)
  check(!!held, '12 s 后 LsaSelfConnector 代发 eg.state = degraded')
  await sleep(10_000)
  check((await tb.attr(cfg.eg.name, 'SERVER_SCOPE', 'active')) === true, `停发 25 s 时本地 TB 仍判 ${cfg.eg.name} 在线（active）`)
  check(!!(await until(async () => (await tb.latest(cfg.eg.name, ['eg.state']))['eg.state']?.value === 'online', 30_000, 1000)), 'eg-agent 恢复后 eg.state 回到 online')

  if (!FAST) {
    console.log('\n10. 韧性：重启本机组件，数据不断档')
    const restarts: [string, string][] = [
      ['lsa-eg-mosquitto', 'Mosquitto'],
      ['lsa-eg-gateway', 'IoT Gateway'],
    ]
    if (RESTART_TB) restarts.push(['lsa-eg-tb', 'EG 本地 TB'])
    for (const [c, label] of restarts) {
      const t0 = Date.now()
      docker('restart', c)
      const ok = await until(async () => {
        const p = (await tb.latest(samB, ['us.amp']))['us.amp']
        return p && p.ts > t0 + 5_000 && Date.now() - p.ts < 8_000
      }, label.includes('TB') ? 240_000 : 90_000)
      const took = Math.round((Date.now() - t0) / 1000)
      check(!!ok, `重启 ${label} 后数据恢复`, ok ? `${took} s` : '超时')
      // 断档：重启期间同事发的数据有没有丢（Mosquitto 持久会话 / IoT Gateway 内存队列替它排着）
      await sleep(10_000)
      const pts = await tb.history(samB, 'us.amp', t0 - 10_000, Date.now() - 5_000)
      const gap = maxGap(pts)
      check(pts.length > 10 && gap <= 4_500, `重启 ${label} 期间 ${samB} 的数据没有断档`, `最大间隔 ${(gap / 1000).toFixed(1)} s，${pts.length} 点`)
    }
  }

  console.log('\n11. 资源')
  st = await status()
  check(st.rssMb <= 256, `eg-agent 内存 ≤ 256 MB（EG 编排上限 384 MB；G5 起带证据与录波缓冲）`, `${st.rssMb} MB（开发机宿主进程）`)
  const gw = containerMemMb('lsa-eg-gateway')
  check(gw !== null && gw <= 250, 'IoT Gateway 内存 ≤ 250 MB', `${gw?.toFixed(0)} MB`)
  const mq = containerMemMb('lsa-eg-mosquitto')
  check(mq !== null && mq <= 30, 'Mosquitto 内存 ≤ 30 MB', `${mq?.toFixed(1)} MB`)

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.message : e)
  process.exit(1)
})
