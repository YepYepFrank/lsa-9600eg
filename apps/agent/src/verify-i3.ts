/* I3 自检（EG 侧）：本地告警 → 告警事件 → 子站扩展服务（后端库 docs/EG独立TB调整方案.md §2.3、§5 I3、§8.2）。
 *
 *   pnpm i3:verify              假子站：自检自己起一个 §8.2 的接收端（127.0.0.1:3199），不依赖后端进度、不碰子站
 *   pnpm i3:verify -- --real    真子站：事件送扩展服务，查子站 TB 上的告警（后端 /ext/eg/:code/events 做好以后）
 *
 * 前提：I1 的样机在跑，本地 TB 根规则链有告警钩子（后端库 pnpm provision:eg -- --cabinet AH03 --hook http://host.docker.internal:9100/hooks/alarm）；
 * dev:emu 在跑；dev:agent 带 EG_DEBUG=1，假子站时还要 EG_EVENTS=on EG_STATION_HTTP=http://127.0.0.1:3199 EG_EVENTS_DB=run/events-stub.db
 * （**独立的事件库**：与正式运行共用 events.db 时，假子站会把本该送真子站的活动告警收走 —— I 阶段复测踩过；遥测上送可以仍是 EG_UPLINK=off）。
 * 用仿真器打弧光造告警：弧光 60 s 无放电自动恢复，一轮约 1 分钟，全程约 5 分钟。 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadConfig, stationToken } from '@lsa-eg/config'
import { AGENT, agent, check, done, EMU, env, post, sleep, Tb, until } from './verify/lib.js'
import { checkEventTiming } from './verify/event-timing.js'

const REAL = process.argv.includes('--real')
const STUB_PORT = Number(env('EG_STUB_PORT', '3199'))
const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const ARC = '弧光异常'

interface Ev {
  eventId: string
  revision: number
  device: string
  type: string
  severity: string
  state: 'ACTIVE' | 'CLEARED'
  occurredAt: number
  clearedAt: number | null
  details: Record<string, unknown>
}
interface Got extends Ev {
  at: number
  status: string
}
interface EventsStatus {
  state: string
  text: string
  target: string | null
  pending: number
  hook: { count: number }
  db?: string
}

/** 假子站：按 §8.2 收事件、回执（revision 不大于已收的回 duplicate） */
function stub(token: string, code: string) {
  const got: Got[] = []
  const best = new Map<string, number>()
  const st = { mode: 'ok' as 'ok' | 'down', rejectCleared: new Set<string>(), badToken: 0, batches: 0 }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      const reply = (code: number, obj: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.method !== 'POST' || req.url !== `/ext/eg/${code}/events`) return reply(404, { message: 'no route' })
      if (req.headers['x-eg-token'] !== token) {
        st.badToken++
        return reply(401, { message: 'bad token' })
      }
      if (st.mode === 'down') return reply(503, { message: '假子站：暂停服务' })
      st.batches++
      const b = JSON.parse(body) as { bootId: string; batchId: string; events: Ev[] }
      const results = b.events.map(e => {
        if (e.state === 'CLEARED' && st.rejectCleared.delete(e.eventId)) {
          got.push({ ...e, at: Date.now(), status: 'rejected' })
          return { eventId: e.eventId, revision: e.revision, status: 'rejected', reason: '假子站：故意拒收', retryable: false }
        }
        const dup = (best.get(e.eventId) ?? 0) >= e.revision
        if (!dup) best.set(e.eventId, e.revision)
        got.push({ ...e, at: Date.now(), status: dup ? 'duplicate' : 'accepted' })
        return { eventId: e.eventId, revision: e.revision, status: dup ? 'duplicate' : 'accepted' }
      })
      reply(200, { batchId: b.batchId, results })
    })
  })
  return { server, got, st }
}

async function main() {
  console.log(`I3 自检（EG 侧）：告警事件${REAL ? '送真子站' : '送假子站'}\n`)
  console.log('0. 事件时延记账（临时库）')
  checkEventTiming(check)

  const cfg = loadConfig()
  const code = cfg.cabinet.code
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const events = async () => (await agent<{ events: EventsStatus }>(cfg.dir, '/api/diag')).events
  const debug = (q: string) => fetch(`${AGENT}/api/_debug/alarms?${q}`, { method: 'POST' }).then(r => r.json() as Promise<EventsStatus>)

  const s = REAL ? null : stub(stationToken(cfg), code)
  if (s) await new Promise<void>(r => s.server.listen(STUB_PORT, '127.0.0.1', r))
  const sp = REAL ? await new Tb().login() : null

  console.log('1. 准备')
  const e0 = await events()
  const want = REAL ? `${cfg.conn.stationHttp}/ext/eg/${code}/events` : `http://127.0.0.1:${STUB_PORT}/ext/eg/${code}/events`
  if (!check(e0.target === want, 'agent 的告警事件送往' + (REAL ? '子站扩展服务' : '假子站'), `${e0.target ?? '不送'}（${e0.text}）`)) {
    console.log(REAL ? '  要 EG_EVENTS=on 或打开上送' : `  agent 要带 EG_DEBUG=1 EG_EVENTS=on EG_STATION_HTTP=http://127.0.0.1:${STUB_PORT} 起`)
    done()
  }
  if (!REAL) {
    const shared = !e0.db || resolve(e0.db) === resolve(cfg.dir, 'events.db')
    if (!check(!shared, 'agent 用独立的事件库（假子站不收走正式的事件）', e0.db ?? '（agent 版本太旧，没报事件库）')) {
      console.log('  agent 要带 EG_EVENTS_DB=run/events-stub.db 起')
      done()
    }
  }
  const root = (await tb.get<{ data: { id: { id: string }; root: boolean }[] }>('/api/ruleChains?pageSize=50&page=0')).data.find(c => c.root)!
  const meta = await tb.get<{ nodes: { name: string; configuration: { restEndpointUrlPattern?: string } }[] }>(`/api/ruleChain/${root.id.id}/metadata`)
  const hookNode = meta.nodes.find(n => n.name === '推送告警到 eg-agent')
  check(!!hookNode, '本地 TB 根规则链有告警钩子（provision:eg --hook）', hookNode?.configuration.restEndpointUrlPattern ?? '没有 —— 只能靠 30 s 对账')

  // 仿真器把弧光打在「热点隔室」的 SAM 上，是哪台以它的回复为准
  const sams = cfg.devices.filter(d => d.kind === 'sam').map(d => d.name)
  let arcDev = sams[0]!
  const arc = async () => (arcDev = ((await post(`${EMU}/emu/arc?intensity=520&ms=30`)) as { device: string }).device)
  const localArc = async (since: number) => (await tb.alarms(arcDev)).find(a => a.type === ARC && a.createdTime >= since)
  const idle = await until(async () => {
    for (const d of sams) if ((await tb.alarms(d)).some(a => a.type === ARC && !a.status.startsWith('CLEARED'))) return false
    return true
  }, 130_000, 5000)
  check(!!idle, `${sams.join('、')} 上没有活动的「${ARC}」（上一轮已恢复）`)
  await debug('hooks=on')

  /** 收到的某条告警的事件（假子站：接收端记录；真子站：子站 TB 上同类型、同时刻的告警） */
  const receivedStub = (id: string) => s!.got.filter(g => g.eventId === id)
  const spAlarm = async (occurredAt: number) => (await sp!.alarms(arcDev)).find(a => a.type === ARC && Math.abs(((a as { startTs?: number }).startTs ?? a.createdTime) - occurredAt) < 1000)

  console.log('\n2. 钩子直达：放电 → 子站 5 s 内收到「发生」')
  let t0 = Date.now()
  await arc()
  const a1 = await until(() => localArc(t0 - 3000), 20_000, 500)
  check(!!a1, `本地 TB 建了「${ARC}」`, a1 ? `${((a1.createdTime - t0) / 1000).toFixed(1)} s` : '20 s 内没有')
  if (!a1) done()
  if (s) {
    const g = await until(async () => receivedStub(a1.id.id).find(x => x.state === 'ACTIVE'), 15_000, 200)
    check(!!g && g.at - t0 < 5000, '子站 5 s 内收到「发生」事件', g ? `${((g.at - t0) / 1000).toFixed(1)} s，第 ${g.revision} 版` : '15 s 内没收到')
    if (g) {
      check(g.eventId === a1.id.id && g.device === arcDev && g.severity === 'CRITICAL', 'eventId = 本地告警 id，设备、级别对', `${g.device} ${g.severity}`)
      const d = g.details
      check(typeof d['value'] === 'number' && typeof d['threshold'] === 'number' && typeof d['unit'] === 'string' && 'ruleVersion' in d, '明细带 value / threshold / unit / ruleVersion', JSON.stringify(d))
      check(g.occurredAt > 0 && g.clearedAt === null, 'occurredAt 有值、clearedAt 为 null')
    }
    check(s.st.badToken === 0, '请求头 X-EG-Token 与子站令牌一致', `${s.st.badToken} 次不对`)
  } else {
    const g = await until(() => spAlarm((a1 as { startTs?: number }).startTs ?? a1.createdTime), 15_000, 500)
    check(!!g && g.createdTime - t0 < 5000, '子站 TB 5 s 内出现同一条告警', g ? `${((g.createdTime - t0) / 1000).toFixed(1)} s` : '15 s 内没有')
  }

  console.log('\n3. 恢复（弧光 60 s 无放电）')
  const c1 = await until(async () => (s ? receivedStub(a1.id.id).find(x => x.state === 'CLEARED') : (await spAlarm((a1 as { startTs?: number }).startTs ?? a1.createdTime))?.status.startsWith('CLEARED')), 130_000, 1000)
  check(!!c1, '子站收到「恢复」', c1 ? `${Math.round((Date.now() - t0) / 1000)} s` : '2 分钟内没有')
  if (s && c1) {
    const g = c1 as Got
    const act = receivedStub(a1.id.id).find(x => x.state === 'ACTIVE')
    check(g.revision > (act?.revision ?? 0) && !!g.clearedAt && g.occurredAt === act?.occurredAt, '同一 eventId，revision 递增，带恢复时刻、发生时刻不变', `第 ${act?.revision}→${g.revision} 版`)
    await sleep(3000)
    check((await events()).pending === 0, 'agent 待送清零')
  }

  console.log('\n4. 伪造 / 残缺的钩子不进本地记录')
  const fake = randomUUID()
  const r1 = (await (await fetch(`${AGENT}/hooks/alarm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'created', device: arcDev, alarm: { id: { id: fake }, type: ARC, severity: 'CRITICAL' } }) })).json()) as { accepted: boolean }
  const r2 = (await (await fetch(`${AGENT}/hooks/alarm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { accepted: boolean }
  await sleep(2000)
  const list = await agent<{ alarms: { eventId: string }[] }>(cfg.dir, '/api/alarms?limit=500')
  check(!list.alarms.some(a => a.eventId === fake) && (!s || !receivedStub(fake).length), '伪造的告警 id：回本地 TB 查不到，不记、不发', `回 accepted=${r1.accepted}`)
  check(r2.accepted === false, '没有告警 id 的请求被拒')

  if (s) {
    console.log('\n5. 子站不在期间发生又恢复 → 恢复后只送一条、时间正确')
    s.st.mode = 'down'
    t0 = Date.now()
    await arc()
    const a2 = await until(() => localArc(t0 - 3000), 20_000, 500)
    check(!!a2, `本地 TB 建了「${ARC}」`)
    if (a2) {
      const cleared = await until(async () => (await tb.alarms(arcDev)).find(a => a.id.id === a2.id.id && a.status.startsWith('CLEARED')), 130_000, 2000)
      check(!!cleared, '本地告警已恢复（子站一直不在）')
      const st = await events()
      check(st.pending >= 1 && st.state === 'retrying', 'agent 留着待送、状态「重试中」', st.text)
      s.st.mode = 'ok'
      const tUp = Date.now()
      const g = await until(async () => receivedStub(a2.id.id).find(x => x.status === 'accepted'), 80_000, 500)
      check(!!g, '子站恢复后收到', g ? `${((g.at - tUp) / 1000).toFixed(1)} s（重试退避最长 60 s）` : '80 s 内没收到')
      const all = receivedStub(a2.id.id).filter(x => x.status === 'accepted')
      const full = cleared as { startTs?: number; clearTs?: number }
      check(all.length === 1 && all[0]!.state === 'CLEARED', '只收到一条「恢复」（带发生时刻），没有过时的「发生」', all.map(x => `${x.state}#${x.revision}`).join(' '))
      if (g) check(g.occurredAt === full.startTs && g.clearedAt === full.clearTs, '发生 / 恢复时刻与本地 TB 一致', `${new Date(g.occurredAt).toLocaleTimeString()} – ${g.clearedAt ? new Date(g.clearedAt).toLocaleTimeString() : '—'}`)
    }

    console.log('\n6. 钩子漏了靠对账补；子站明确拒收的记审计后丢弃')
    await debug('hooks=off')
    t0 = Date.now()
    await arc()
    const a3 = await until(() => localArc(t0 - 3000), 20_000, 500)
    if (a3) s.st.rejectCleared.add(a3.id.id)
    const g3 = a3 ? await until(async () => receivedStub(a3.id.id).find(x => x.state === 'ACTIVE'), 45_000, 500) : null
    check(!!g3, '不理钩子时 30 s 对账补上「发生」', g3 ? `${((g3.at - t0) / 1000).toFixed(1)} s` : '45 s 内没收到')
    await debug('hooks=on')
    if (a3) {
      const rej = await until(async () => receivedStub(a3.id.id).find(x => x.status === 'rejected'), 130_000, 1000)
      check(!!rej, '子站拒收了「恢复」')
      await sleep(3000)
      const audit = await agent<{ action: string; target: string }[]>(cfg.dir, '/api/audit?limit=50')
      check(audit.some(x => x.action === 'event.rejected' && x.target.includes(a3.id.id)), '拒收记进本地审计')
      check((await events()).pending === 0, '拒收（不可重试）的不再重发')
    }
  }

  s?.server.close()
  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
