/* G5 自检（EG 侧）：循环录像、证据锁定与生产（docs/G5证据约定.md §8.7）。
 *
 *   pnpm g5:verify
 *
 * 前提：G4 的样机（camera、mediamtx 容器，mediamtx 挂了 run/recordings 且配置是 G5 的：子码流常录、回放服务）；
 * dev:emu、dev:video、dev:agent（G5 代码）在跑。子站侧的证据接口（索引、文件）归后端，这里只报「等子站」。约 4 分钟。 */
import { checkEvidencePurge } from './verify/evidence-purge.js'
import { createHash, randomBytes } from 'node:crypto'
import { loadConfig, stationToken } from '@lsa-eg/config'
import { signTicket } from './auth/ticket.js'
import { AGENT, agent, agentLogin, check, done, EMU, post, sleep, until } from './verify/lib.js'
import { roundTimes, TIME_FIELDS } from './evidence/evidence.store.js'

interface Item {
  evidenceId: string
  eventId: string | null
  requestId: string | null
  channelId: string
  kind: string
  requestedStart: number
  requestedEnd: number
  actualStart: number | null
  actualEnd: number | null
  status: string
  sizeBytes: number | null
  sha256: string | null
  important: boolean
  pairOffsetMs: number | null
  missingReason: string | null
  hasFile: boolean
}
type List = { status: { recOk: boolean | null; indexPending: number; target: string | null }; items: Item[] }

async function main() {
  console.log('G5 自检（EG 侧）：循环录像、证据锁定与生产\n')
  const cfg = loadConfig()
  const code = cfg.cabinet.code
  const list = () => agent<List>(cfg.dir, '/api/evidence?limit=500')
  const ticket = () => {
    const now = Date.now()
    return signTicket(stationToken(cfg), { c: code, u: 'ext', n: '子站扩展服务', r: 'station', iat: now, exp: now + 60_000, j: randomBytes(8).toString('hex') })
  }
  const lock = async (body: Record<string, unknown>) =>
    (await (await fetch(`${AGENT}/api/evidence/lock`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-EG-Ticket': ticket() }, body: JSON.stringify(body) })).json()) as {
      status: string
      evidenceIds: string[]
      message?: string
    }
  const fileOf = async (id: string) => {
    const r = await fetch(`${AGENT}/api/evidence/${encodeURIComponent(id)}/file`, { headers: { Authorization: `Bearer ${await agentLogin(cfg.dir)}` } })
    return { status: r.status, sha: r.headers.get('x-sha256'), buf: Buffer.from(await r.arrayBuffer()) }
  }
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

  console.log('0. 盘满兜底与「归档前不删唯一副本」（临时库，不碰正在用的 evidence.db）')
  checkEvidencePurge(check)

  console.log('\n1. 循环录像（两路子码流常录）')
  const rec = (await (await fetch('http://127.0.0.1:9110/api/video/recording')).json()) as { ok: boolean; paths: { channel: string; segments: number; oldest: number | null; recording: boolean }[] }
  check(rec.ok && rec.paths.length === 2 && rec.paths.every(p => p.recording), '可见光 / 热像子码流都在录', rec.paths.map(p => `${p.channel}:${p.segments} 段`).join(' '))
  const oldest = Math.max(...rec.paths.map(p => p.oldest ?? Date.now()))
  check(Date.now() - oldest > 3 * 60_000, '循环录像已有 3 分钟以上（下面锁定过去的窗口要用）', `最早 ${new Date(oldest).toLocaleTimeString()}`)

  console.log('\n2. 本地告警触发：双光视频 + 抓图 + 录波')
  const t0 = Date.now()
  const arc = (await post(`${EMU}/emu/arc?intensity=85&ms=30`)) as { device: string }
  const group = await until(async () => {
    const items = (await list()).items.filter(i => i.eventId && i.requestedEnd > t0 - 5000 && i.kind === 'video')
    return items.length ? (await list()).items.filter(i => i.eventId === items[0]!.eventId) : null
  }, 20_000, 1000)
  check(!!group && group.length === 5, '告警发生即登记一组 5 条（视频×2、抓图×2、录波）', group?.map(i => `${i.kind}/${i.channelId}:${i.status}`).join(' '))
  if (!group) done()
  const eventId = group[0]!.eventId!
  check(group.every(i => i.important), '弧光异常算重要（自动上传）')
  const imgs = await until(async () => {
    const g = (await list()).items.filter(i => i.eventId === eventId && i.kind === 'image')
    return g.length === 2 && g.every(i => i.status === 'READY') ? g : null
  }, 30_000, 1000)
  check(!!imgs, '双光抓图就绪', imgs?.map(i => `${i.channelId} ${i.sizeBytes} 字节`).join(' '))
  if (imgs) {
    const f = await fileOf(imgs[0]!.evidenceId)
    check(f.status === 200 && f.buf[0] === 0xff && f.buf[1] === 0xd8 && sha(f.buf) === imgs[0]!.sha256 && f.sha === imgs[0]!.sha256, '抓图文件能取、sha256 与索引一致')
  }
  console.log(`  （等后窗 ${cfg.local.evidence.postS} s 录完再裁视频）`)
  const vids = await until(async () => {
    const g = (await list()).items.filter(i => i.eventId === eventId && (i.kind === 'video' || i.kind === 'wave'))
    return g.every(i => i.status !== 'RECORDING') ? g : null
  }, (cfg.local.evidence.postS + 60) * 1000, 3000)
  check(!!vids, '后窗过后视频与录波都做完')
  if (vids) {
    const vs = vids.filter(i => i.kind === 'video')
    check(vs.every(i => i.status === 'READY'), '双光视频就绪', vs.map(i => `${i.channelId}:${i.status}${i.missingReason ? `(${i.missingReason})` : ''}`).join(' '))
    const v = vs.find(i => i.status === 'READY')
    if (v) {
      const dur = (v.actualEnd! - v.actualStart!) / 1000
      const want = cfg.local.evidence.preS + cfg.local.evidence.postS
      check(Math.abs(dur - want) < 10 && Math.abs(v.actualStart! - v.requestedStart) < 10_000, `视频实际时长约 ${want} s、起点贴近请求（按关键帧可外扩）`, `${dur.toFixed(1)} s，起点差 ${((v.actualStart! - v.requestedStart) / 1000).toFixed(1)} s`)
      const f = await fileOf(v.evidenceId)
      check(f.status === 200 && f.buf.subarray(4, 8).toString() === 'ftyp' && sha(f.buf) === v.sha256, '视频文件是 MP4、sha256 与索引一致', `${(f.buf.length / 1024).toFixed(0)} KB`)
      check(vs.every(i => i.pairOffsetMs !== null), '双光配对记了实际起点差', vs.map(i => `${i.pairOffsetMs} ms`).join(' '))
    }
    const w = vids.find(i => i.kind === 'wave')
    if (w) {
      const f = await fileOf(w.evidenceId)
      const j = f.status === 200 ? (JSON.parse(f.buf.toString()) as { rateHz: number | null; series: Record<string, [number, number][]> }) : null
      check(!!j && Object.keys(j.series).some(k => k.endsWith('/uv.int')), '录波有数据、含弧光强度序列', j ? `${Object.keys(j.series).length} 个序列，${j.rateHz} Hz` : '')
    }
  }

  console.log('\n3. 子站请求锁定')
  const now = Date.now()
  const r1 = await lock({ requestId: `req-${randomBytes(3).toString('hex')}`, start: now - 150_000, end: now - 90_000, kinds: ['video', 'wave'], reason: '自检：锁过去 1 分钟' })
  check(r1.status === 'ACCEPTED' && r1.evidenceIds.length === 3, '锁过去的窗口：ACCEPTED，视频×2 + 录波', `${r1.status} ${r1.evidenceIds.length}`)
  const got = await until(async () => {
    const g = (await list()).items.filter(i => r1.evidenceIds.includes(i.evidenceId) && i.kind === 'video')
    return g.length === 2 && g.every(i => i.status !== 'RECORDING') ? g : null
  }, 60_000, 2000)
  check(!!got && got.every(i => i.status === 'READY'), '窗口在过去的：马上裁出来', got?.map(i => i.status).join(' '))
  const r2 = await lock({ requestId: 'req-old', start: now - 48 * 3_600_000, end: now - 47 * 3_600_000, kinds: ['video'] })
  check(r2.status === 'EXPIRED', '晚于循环覆盖的请求：EXPIRED', r2.message)
  const r3 = await lock({ requestId: 'req-part', start: oldest - 120_000, end: oldest + 60_000, kinds: ['video'] })
  check(r3.status === 'PARTIAL', '一部分早于循环覆盖：PARTIAL（能锁多少锁多少）', r3.message)
  const r4 = await lock({ requestId: 'req-dup', eventId, start: t0 - 30_000, end: t0 + 60_000 })
  check(r4.status === 'ACCEPTED' && group.every(i => r4.evidenceIds.includes(i.evidenceId)), '同一事件子站再来锁：共用本地那一组', `${r4.evidenceIds.length} 条`)
  const bad = await fetch(`${AGENT}/api/evidence/lock`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })
  check(bad.status === 401, '不带服务票据 → 401')

  console.log('\n4. 录像断流 → 缺证 / 缺口如实标')
  const tOff = Date.now()
  await post(`${EMU}/emu/cam/stream?ch=visibleSub&on=0`)
  await sleep(40_000)
  await post(`${EMU}/emu/cam/stream?ch=visibleSub&on=1`)
  await sleep(15_000)
  const r5 = await lock({ requestId: 'req-gap', start: tOff + 5_000, end: tOff + 35_000, kinds: ['video'] })
  const gap = await until(async () => {
    const g = (await list()).items.filter(i => r5.evidenceIds.includes(i.evidenceId))
    return g.length === 2 && g.every(i => i.status !== 'RECORDING') ? g : null
  }, 60_000, 2000)
  const vis = gap?.find(i => i.channelId === 'visible')
  const ir = gap?.find(i => i.channelId === 'ir')
  check(!!vis && (vis.status === 'MISSING' || vis.missingReason === 'gap'), '断流期间的可见光：MISSING 或标缺口', vis ? `${vis.status} ${vis.missingReason ?? ''}` : '')
  check(!!ir && ir.status === 'READY' && !ir.missingReason, '同一窗口的热像照常', ir ? `${ir.status}` : '')

  console.log('\n5. EG 自身指标')
  const eg = (await agent<{ telemetry: Record<string, { v: unknown }> }>(cfg.dir, `/api/live/${cfg.eg.name}`)).telemetry
  check('eg.evid_pending' in eg && 'eg.evid_full' in eg && 'eg.rec_ok' in eg, '报 eg.evid_pending / eg.evid_full / eg.rec_ok', `pending=${eg['eg.evid_pending']?.v} full=${eg['eg.evid_full']?.v} rec_ok=${eg['eg.rec_ok']?.v}`)

  console.log('\n5b. 索引里的时间一律整数毫秒（§8.7；子站按 bigint 入库）')
  check(Object.values(roundTimes({ actualStart: 1790527134005.925, actualEnd: 1790527224005.4, createdAt: 1 })).every(Number.isInteger), '取整：带小数的实际起止（回放服务 / ffprobe 给的）取成整数')
  const all = (await agent<{ items: Record<string, unknown>[] }>(cfg.dir, '/api/evidence?limit=500')).items
  const frac = all.filter(it => TIME_FIELDS.some(k => typeof it[k] === 'number' && !Number.isInteger(it[k])))
  check(!frac.length, `本机证据索引 ${all.length} 条的时间字段都是整数`, frac.length ? `${frac.length} 条带小数（agent 还是旧版？）` : '')

  console.log('\n6. 送子站（等子站：/ext/eg/<柜号>/evidence 与 …/file 归后端）')
  const st = (await list()).status
  console.log(`  · 待送索引 ${st.indexPending} 条（目标 ${st.target ?? '不送'}）；子站接口好了以后 g5:verify -- --real 查子站收到与重要文件校验`)

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
