/* I2 自检：eg-agent 上送子站（后端库 docs/EG独立TB调整方案.md §5 I2、§8.1）。
 *
 *   pnpm i2:verify              剪断上行 10 分钟（验收口径）
 *   pnpm i2:verify -- --fast    剪断 2 分钟
 *
 * 前提：I1 的样机（本地 TB）在跑；eg.yaml 带 station.mqtt / station.token，子站上 EG-<柜号> 是网关设备（provision:eg）；
 * dev:emu、dev:agent（EG_DEBUG=1）在跑。断网用 agent 的调试接口模拟（/api/_debug/uplink?down=1）。 */
import { loadConfig } from '@lsa-eg/config'
import { AGENT, agent, check, docker, done, maxGap, sleep, Tb, until } from './verify/lib.js'
import { checkLostAccounting } from './verify/outbox-lost.js'

const FAST = process.argv.includes('--fast')
const CUT_MIN = FAST ? 2 : 10

interface Uplink {
  state: string
  text: string
  depth: number | null
  backfillPct?: number | null
}

async function main() {
  console.log(`I2 自检：上送子站（断网 ${CUT_MIN} 分钟）\n`)
  const cfg = loadConfig()
  const sp = await new Tb().login()
  const sam = cfg.devices.find(d => d.kind === 'sam')!.name
  const eg = cfg.eg.name
  const uplink = async () => (await agent<{ uplink: Uplink }>(cfg.dir, '/api/diag')).uplink
  const debug = (down: boolean) => fetch(`${AGENT}/api/_debug/uplink?down=${down ? 1 : 0}`, { method: 'POST' }).then(r => r.json() as Promise<Uplink>)

  console.log('0. 丢失记账（临时库，不碰正在用的 outbox）：eg.lost 累计、只增不减')
  checkLostAccounting(check)

  console.log('\n1. 连上子站、数据直达')
  const u0 = await until(async () => {
    const u = await uplink()
    return u.state === 'ok' ? u : null
  }, 60_000)
  check(!!u0, '上送状态正常', u0?.text)
  const now = Date.now()
  for (const d of cfg.devices.filter(x => x.kind !== 'camera')) {
    const keys = (await sp.get<string[]>(`/api/plugins/telemetry/DEVICE/${await sp.id(d.name)}/keys/timeseries`)).filter(k => !k.startsWith('dev.') && k !== 'q').slice(0, 30)
    const v = await sp.latest(d.name, keys)
    const newest = Math.max(0, ...Object.values(v).map(p => p?.ts ?? 0))
    check(now - newest < 10_000, `子站上 ${d.name} 数据新鲜`, `距今 ${((now - newest) / 1000).toFixed(1)} s`)
  }
  const m0 = await sp.latest(eg, ['eg.cpu', 'eg.uplink', 'eg.buf_depth', 'eg.outbox_full', 'eg.lost'])
  check(!!m0['eg.cpu'] && now - m0['eg.cpu'].ts < 15_000, `子站上 ${eg} 的自身指标新鲜（在线心跳）`)
  check(m0['eg.uplink']?.value === 'ok' && m0['eg.buf_depth'] !== undefined, '子站收到上送状态指标', `eg.uplink=${m0['eg.uplink']?.value}，eg.buf_depth=${m0['eg.buf_depth']?.value}，eg.outbox_full=${m0['eg.outbox_full']?.value}`)
  const egAttr = await sp.attr(eg, 'CLIENT_SCOPE', 'egAgentVersion')
  check(!!egAttr, '子站收到 EG 属性 egAgentVersion', String(egAttr))

  console.log(`\n2. 剪断上行 ${CUT_MIN} 分钟`)
  const cut = Date.now()
  await debug(true)
  await sleep(30_000)
  const mid = await uplink()
  check(mid.state === 'offline' && (mid.depth ?? 0) > 20, '断网时本地如实显示离线与积压', `${mid.text}`)
  const stale = (await sp.latest(sam, ['ir.t_max']))['ir.t_max']
  check(!!stale && Date.now() - stale.ts > 20_000, '断网期间子站收不到新数据（确实断了）')
  await sleep(CUT_MIN * 60_000 - 30_000)
  const before = await uplink()
  console.log(`  断网结束前本地积压 ${before.depth} 条`)

  console.log('\n3. 恢复：实时优先、补传限速、按原时间补齐')
  const restored = Date.now()
  await debug(false)
  // 补传按 backfillRate 限速（缺省 2000 条/s），10 分钟的积压（一千多条）一秒就送完，本地「补传中」一闪而过；
  // 所以「实时优先」看子站：恢复后多久出现恢复之后产生的新数据（实时排在补传后面的话要等补传完）
  let sawBackfill = false
  let firstRealtime: number | null = null
  const drained = await until(async () => {
    const u = await uplink()
    if (u.state === 'backfill') sawBackfill = true
    if (firstRealtime === null) {
      const p = (await sp.latest(sam, ['ir.t_max']))['ir.t_max']
      if (p && p.ts >= restored) firstRealtime = Date.now() - restored
    }
    return u.state === 'ok' && (u.depth ?? 1e9) < 100 && firstRealtime !== null ? u : null
  }, 15 * 60_000, 200)
  check(!!drained, '补传完、积压清掉', drained ? `${((Date.now() - restored) / 1000).toFixed(1)} s` : '15 分钟内没清')
  check(firstRealtime !== null && firstRealtime < 5_000, '恢复后实时数据马上到子站（不排在补传后面）', firstRealtime === null ? '没到' : `恢复后 ${(firstRealtime / 1000).toFixed(1)} s`)
  await sleep(5000)
  const pts = await sp.history(sam, 'ir.t_max', cut - 10_000, restored + 10_000)
  const span = (restored + 10_000 - (cut - 10_000)) / 2000
  check(maxGap(pts) <= 4_500, `断网期间 ${sam} 的数据补齐、无缺口`, `${pts.length} 点，最大间隔 ${(maxGap(pts) / 1000).toFixed(1)} s`)
  check(Math.abs(pts.length - span) / span < 0.03, '点数与 2 s 一个相符（没有重复、没有缺）', `应约 ${Math.round(span)}，实 ${pts.length}`)
  const selfPts = await sp.history(eg, 'eg.cpu', cut, restored)
  check(maxGap(selfPts) <= 10_000, 'EG 自身指标也补齐（子站能回看断网期间的 EG 状态）', `${selfPts.length} 点`)
  const bf = await sp.history(eg, 'eg.backfill_pct', restored - 5000, Date.now())
  // 积压要送 5 s 以上（一个上报周期）才一定看得到「补传中」；更短的一闪而过，只记不判
  const rate = cfg.local.outbox.backfillRate
  const seen = bf.length ? `eg.backfill_pct ${bf.map(p => p.value).slice(0, 6).join(' → ')}` : sawBackfill ? '本地看到' : '没看到'
  if ((before.depth ?? 0) > rate * 5) check(bf.length > 0 || sawBackfill, '经历了「补传中」（本地看到，或子站收到补传进度 eg.backfill_pct）', seen)
  else console.log(`  · 积压 ${before.depth} 条、限速 ${rate} 条/s，不到 1 s 送完，「补传中」只一闪（${seen}），不判`)

  console.log('\n4. 重启本机组件不丢')
  for (const [c, label] of [
    ['lsa-eg-mosquitto', 'Mosquitto'],
    ['lsa-eg-tb', '本地 TB'],
  ] as const) {
    const t0 = Date.now()
    docker('restart', c)
    await until(async () => {
      const p = (await sp.latest(sam, ['ir.t_max']))['ir.t_max']
      return p && p.ts > t0 + 5_000
    }, 180_000)
    await sleep(15_000)
    const h = await sp.history(sam, 'ir.t_max', t0 - 10_000, Date.now() - 5_000)
    check(maxGap(h) <= 4_500, `重启 ${label} 期间子站数据无断档`, `最大间隔 ${(maxGap(h) / 1000).toFixed(1)} s`)
  }

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
