/* 单柜界面（eg-ui-v2）用到的接口自检：
 *
 *   pnpm ui:verify                                       对 EG_AGENT_URL（缺省 http://127.0.0.1:9100）
 *   EG_AGENT_URL=http://127.0.0.1:9101 EG_LAN1_URL=http://169.254.62.188:9101 pnpm ui:verify
 *
 * 查：历史接口（数据、降采样、参数校验）、事件与证据接口、流反代（WHEP / HLS）的鉴权与路径白名单，都要会话（没有 → 401）；
 * 给了 EG_LAN1_URL（经 LAN1 网口地址访问同一个 agent，agent 的 denyOn 里有这个网口）时查 LAN1 一律 403、连登录都不行。
 * 流反代到 mediamtx 通不通（WebRTC / HLS 没开时 502）只记录、不判，由 g4:verify 管视频。 */
import { loadConfig } from '@lsa-eg/config'
import { AGENT, agentLogin, check, done, env } from './verify/lib.js'

const LAN1 = env('EG_LAN1_URL', '')

async function raw(path: string, init: RequestInit = {}, base = AGENT) {
  const r = await fetch(`${base}${path}`, init)
  const text = await r.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* 不是 JSON */
  }
  return { status: r.status, body, headers: r.headers }
}

async function main() {
  console.log(`单柜界面接口自检（${AGENT}）\n`)
  const cfg = loadConfig()
  const cab = cfg.cabinet.code
  const sam = cfg.devices.find(d => d.kind === 'sam')!.name
  const cam = cfg.devices.find(d => d.kind === 'camera')?.name
  const meter = cfg.devices.find(d => d.kind === 'meter')?.name
  const token = await agentLogin(cfg.dir)
  const auth = { Authorization: `Bearer ${token}` }

  console.log('1. 历史 /api/history')
  const q = `device=${sam}&keys=env.t,env.rh,us.amp&hours=24&points=288`
  check((await raw(`/api/history?${q}`)).status === 401, '没有会话 → 401')
  const h = await raw(`/api/history?${q}`, { headers: auth })
  const hb = h.body as { series: Record<string, [number, number][]>; intervalMs: number; from: number; to: number }
  const n = hb.series?.['env.t']?.length ?? 0
  check(h.status === 200 && n > 0 && n <= 300 && hb.intervalMs >= 300_000 - 1000, `${sam} 近 24 h env.t：按 5 min 一桶降采样`, `${n} 点，桶 ${Math.round((hb.intervalMs ?? 0) / 1000)} s`)
  const pts = hb.series?.['env.t'] ?? []
  check(pts.every((p, i) => typeof p[1] === 'number' && (i === 0 || p[0] > pts[i - 1]![0])), '数值型、按时间升序')
  if (cam) {
    const c = await raw(`/api/history?device=${cam}&keys=ir.R1.max,ir.rise&hours=1&points=60`, { headers: auth })
    check(c.status === 200 && ((c.body as typeof hb).series['ir.R1.max']?.length ?? 0) > 0, `${cam} 近 1 h ir.R1.max 有数`, `${(c.body as typeof hb).series?.['ir.R1.max']?.length ?? 0} 点`)
  }
  const p = await raw(`/api/history?device=${sam}&keys=uv.pulse&hours=24&agg=NONE`, { headers: auth })
  check(p.status === 200 && Array.isArray((p.body as typeof hb).series['uv.pulse']), 'agg=NONE 原样取事件型量（uv.pulse）', `${(p.body as typeof hb).series?.['uv.pulse']?.length ?? 0} 条`)
  if (meter) {
    const e = await raw(`/api/history?device=${meter}&keys=el.Ia,el.Ib,el.Ic&hours=24`, { headers: auth })
    check(e.status === 200 && ((e.body as typeof hb).series['el.Ia']?.length ?? 0) > 0, `${meter} 三相电流趋势有数`)
  }
  check((await raw(`/api/history?device=NOPE&keys=env.t`, { headers: auth })).status === 404, '不在本机清单的设备 → 404')
  check((await raw(`/api/history?device=${sam}&keys=env.t;drop`, { headers: auth })).status === 400, 'key 带非法字符 → 400')
  check((await raw(`/api/history?device=${sam}&keys=env.t&agg=BOGUS`, { headers: auth })).status === 400, 'agg 不认识 → 400')

  console.log('\n2. 事件与证据')
  check((await raw('/api/alarms')).status === 401, '事件 /api/alarms 没有会话 → 401')
  const a = await raw('/api/alarms?limit=50', { headers: auth })
  check(a.status === 200 && Array.isArray((a.body as { alarms: unknown[] }).alarms), '事件列表可取', `${(a.body as { alarms: unknown[] }).alarms?.length ?? 0} 条`)
  check((await raw('/api/evidence')).status === 401, '证据 /api/evidence 没有会话 → 401')
  const ev = await raw('/api/evidence?limit=50', { headers: auth })
  const items = (ev.body as { items: { evidenceId: string; hasFile: boolean }[] }).items ?? []
  check(ev.status === 200, '证据列表可取', `${items.length} 条`)
  const f = items.find(i => i.hasFile)
  if (f) {
    check((await raw(`/api/evidence/${f.evidenceId}/file`)).status === 401, '证据文件没有会话 → 401')
    const g = await fetch(`${AGENT}/api/evidence/${f.evidenceId}/file`, { headers: auth })
    check(g.status === 200 && Number(g.headers.get('content-length') ?? 0) > 0, '证据文件带会话可取（录像回放）', `${g.headers.get('content-type')} ${g.headers.get('content-length')} B`)
    await g.arrayBuffer()
  } else console.log('  · 本机还没有带文件的证据，文件项跳过')

  console.log('\n3. 实时画面反代 /api/stream')
  const sdp = 'v=0\r\n'
  check((await raw(`/api/stream/${cab}-sub/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: sdp })).status === 401, 'WHEP 没有会话 → 401（不能绕开登录）')
  check((await raw(`/api/stream/${cab}-sub/index.m3u8`)).status === 401, 'HLS 没有会话 → 401')
  check((await raw(`/api/stream/OTHER/whep`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/sdp' }, body: sdp })).status === 404, '不是本柜四路的路径 → 404')
  check((await raw(`/api/stream/${cab}/whep`, { method: 'GET', headers: auth })).status === 405, 'WHEP 用 GET → 405')
  check((await raw(`/api/stream/${cab}/../../api/status`, { headers: auth })).status !== 200, '路径穿越拿不到别的接口')
  const w = await raw(`/api/stream/${cab}-sub/whep`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/sdp' }, body: sdp })
  console.log(`  · 带会话的 WHEP（假 SDP）：${w.status}${w.status === 502 ? '（mediamtx 的 WebRTC 没开 / 连不上）' : w.status === 400 ? '（mediamtx 收到、SDP 不对，链路通）' : ''}`)
  const hls = await raw(`/api/stream/${cab}-sub/index.m3u8`, { headers: auth })
  console.log(`  · 带会话的 HLS 播放列表：${hls.status}${hls.status === 200 ? '（' + String(hls.headers.get('content-type')) + '）' : ''}`)

  if (LAN1) {
    console.log(`\n4. LAN1（${LAN1}）一律拒绝`)
    check((await raw('/', {}, LAN1)).status === 403, '管理页首页 → 403')
    check((await raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, LAN1)).status === 403, '登录接口 → 403（连登录都不给）')
    check((await raw(`/api/history?${q}`, { headers: auth }, LAN1)).status === 403, '带着合法会话也 → 403（历史）')
    check((await raw(`/api/stream/${cab}-sub/whep`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/sdp' }, body: sdp }, LAN1)).status === 403, '带着合法会话也 → 403（流反代）')
  } else console.log('\n（没给 EG_LAN1_URL：LAN1 拒绝跳过）')

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
