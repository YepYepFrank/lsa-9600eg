/* G4 自检：视频两级按需拉（EG 这一级）与摄像机区域测温（docs/G4视频接口约定.md §8.5、docs/G4摄像机测温约定.md §8.6）。
 *
 *   pnpm g4:verify
 *
 * 前提：开发样机带 camera（测试源）与 mediamtx 容器（pnpm dev:up）；dev:emu（含仿真摄像机）、dev:video、dev:agent 在跑，都是 G4 的代码；
 * local.yaml camera.driver = sim（pnpm dev:config 写的）。只动仿真器与 EG 样机，不碰子站。约 4 分钟。 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from '@lsa-eg/config'
import { agent, agentLogin, check, done, EMU, env, post, Tb, until } from './verify/lib.js'

const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const CAM_API = env('EG_CAM_API', 'http://127.0.0.1:19998')

interface VideoStatus {
  available: boolean
  error?: string
  driver: { driver: string; ok: boolean; error: string | null } | null
  channels: { key: string; path: string; from: string | null; probe: { ok: boolean; error?: string } | null; mtx: { ready: boolean; readers: number } | null }[]
  mediamtx: { rtspPort: number; error: string | null }
  metrics: Record<string, number>
  measure: { supported: boolean; ok: boolean; error: string | null; regions: { id: string; type: string }[]; regionsVer: string }
}
type Live = { telemetry: Record<string, { v: unknown; ts: number }>; attributes: Record<string, unknown> }

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v))

async function main() {
  console.log('G4 自检：视频按需拉（EG 这一级）与摄像机区域测温\n')
  const cfg = loadConfig()
  const code = cfg.cabinet.code
  const camDev = cfg.devices.find(d => d.kind === 'camera')!.name
  const firstSam = cfg.devices.find(d => d.kind === 'sam')!.name
  const vs = () => agent<VideoStatus>(cfg.dir, '/api/video/status')
  const live = (dev: string) => agent<Live>(cfg.dir, `/api/live/${dev}`)
  const camPaths = async () =>
    ((await (await fetch(`${CAM_API}/v3/paths/list`)).json()) as { items: { name: string; ready: boolean }[] }).items

  console.log('1. 配置与驱动')
  const s0 = await vs()
  if (!check(s0.available, 'eg-video 在跑（经 agent 转）', s0.error)) done()
  check(s0.driver?.driver === 'sim' && s0.driver.ok, '仿真摄像机驱动取到流地址', `${s0.driver?.driver} ${s0.driver?.error ?? ''}`)
  check(s0.channels.every(c => c.from), '四路都有地址', s0.channels.map(c => `${c.path}:${c.from ?? '无'}`).join(' '))
  check(s0.channels.map(c => c.path).join(',') === [code, `${code}-sub`, `${code}-ir`, `${code}-ir-sub`].join(','), '路径按柜号：<柜号>、-sub、-ir、-ir-sub')
  const yml = readFileSync(resolve(cfg.dir, 'mediamtx/mediamtx.yml'), 'utf8')
  check((yml.match(/sourceOnDemand: true/g) ?? []).length === 4 && /rtspTransport: tcp/.test(yml) && /webrtc: false/.test(yml), 'EG mediamtx 配置：四路按需拉、TCP、只开 RTSP')
  check(!s0.mediamtx.error, 'EG mediamtx API 可达', s0.mediamtx.error ?? '')

  console.log('\n2. 探测与 cam.*')
  const s1 = await until(async () => {
    const s = await agent<VideoStatus>(cfg.dir, '/api/video/refresh', { method: 'POST' })
    return s.channels.every(c => c.probe?.ok) ? s : null
  }, 30_000, 5000)
  check(!!s1, '四路 DESCRIBE 都可用（带摘要认证）', s1 ? '' : JSON.stringify((await vs()).channels.map(c => c.probe)))
  const cam1 = await until(async () => {
    const t = (await live(camDev)).telemetry['cam.online']
    return t && Date.now() - t.ts < 70_000 && n(t.v) === 4 ? t : null
  }, 70_000, 3000)
  check(!!cam1, `${camDev} 的 cam.online = 4（本机总线）`)

  console.log('\n3. 按需拉：没人看不拉，看完 20 s 内断到摄像机')
  const idle = (await vs()).channels.every(c => !c.mtx?.ready) && (await camPaths()).every(p => !p.ready)
  check(idle, '没人看时 EG 与摄像机两级都不拉流')
  const t0 = Date.now()
  const ff = spawn(process.env['FFMPEG'] || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${s0.mediamtx.rtspPort}/${code}`, '-t', '6', '-f', 'null', '-'])
  const up = await until(async () => ((await vs()).channels.find(c => c.path === code)?.mtx?.ready && (await camPaths()).find(p => p.name === 'visible')?.ready ? true : null), 15_000, 500)
  check(!!up, '有人拉 <柜号> 时两级都拉起来', up ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : '15 s 内没拉起')
  await new Promise(r => ff.on('close', r))
  const tEnd = Date.now()
  const down = await until(async () => (!(await camPaths()).find(p => p.name === 'visible')?.ready ? true : null), 35_000, 1000)
  check(!!down, '看完后摄像机侧断开（约定 ≤ 20 s）', down ? `${((Date.now() - tEnd) / 1000).toFixed(0)} s` : '35 s 内没断')

  console.log('\n4. 抓帧')
  const snap = await fetch(`http://127.0.0.1:${cfg.conn.httpPort}/api/video/snapshot?ch=ir`, { method: 'POST', headers: { Authorization: `Bearer ${await agentLogin(cfg.dir)}` } })
  const buf = Buffer.from(await snap.arrayBuffer())
  check(snap.ok && buf[0] === 0xff && buf[1] === 0xd8, '热像抓一帧 JPEG', `${snap.status} ${buf.length} 字节，${snap.headers.get('x-snapshot-via')}`)

  console.log('\n5. 区域测温上报')
  const cam = await until(async () => {
    const l = await live(camDev)
    const t = l.telemetry['ir.R1.max']
    return t && Date.now() - t.ts < 6000 ? l : null
  }, 15_000, 1000)
  check(!!cam, '每 2 s 有区域温度（ir.R1.max 新鲜）')
  if (cam) {
    const keys = ['ir.max', 'ir.min', 'ir.max_x', 'ir.max_y', ...[1, 2, 3].flatMap(i => ['max', 'min', 'max_x', 'max_y'].map(k => `ir.R${i}.${k}`))]
    const miss = keys.filter(k => !(k in cam.telemetry))
    check(!miss.length, '全画面与 R1–R3 的 max / min / 坐标都有', miss.join(' '))
    check(!Object.keys(cam.telemetry).some(k => /avg|center/.test(k)), '不报 avg / center')
    const regions = cam.attributes['ir.regions'] as { id: string; label: string; frame: { w: number } }[] | undefined
    check(Array.isArray(regions) && regions.length === 3 && regions[0]!.frame.w > 0 && !!cam.attributes['ir.regionsVer'], '区域配置作属性 ir.regions / ir.regionsVer', regions?.map(r => `${r.id}:${r.label}`).join(' '))
    // 温升 = max − env.t
    const sam = await live(firstSam)
    const env1 = sam.telemetry['env.t']
    const r = await until(async () => {
      const l = await live(camDev)
      return l.telemetry['ir.R1.rise'] && Date.now() - l.telemetry['ir.R1.rise'].ts < 6000 ? l : null
    }, 15_000, 1000)
    const rise = r?.telemetry['ir.R1.rise']
    const max = r?.telemetry['ir.R1.max']
    check(!!rise && !!max && rise.ts === max.ts && !!env1 && Math.abs(n(rise.v) - (n(max.v) - n(env1.v))) < 0.25, 'ir.R1.rise = ir.R1.max − env.t，时间戳与 max 相同', rise ? `${n(rise.v)} = ${n(max!.v)} − ${n(env1?.v)}` : '没有')
    const dm = r?.telemetry['ir.dmax']
    const maxes = [1, 2, 3].map(i => n(r?.telemetry[`ir.R${i}.max`]?.v))
    check(!!dm && Math.abs(n(dm.v) - (Math.max(...maxes) - Math.min(...maxes))) < 0.15, 'ir.dmax = 各区域最高温的极差', dm ? String(n(dm.v)) : '没有')
  }
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const tbv = await tb.latest(camDev, ['ir.R2.max', 'ir.R2.rise'])
  check(!!tbv['ir.R2.max'] && Date.now() - tbv['ir.R2.max'].ts < 10_000 && !!tbv['ir.R2.rise'], '本地 TB 上 CAM 的区域温度与温升新鲜')

  console.log('\n6. 注入过温')
  await post(`${EMU}/emu/cam/overtemp?region=R2&max=95&s=20`)
  const hot = await until(async () => {
    const l = await live(camDev)
    return n(l.telemetry['ir.R2.max']?.v) === 95 ? l : null
  }, 8000, 500)
  check(!!hot, 'R2 最高温 95 ℃ 到了总线')
  if (hot) check(n(hot.telemetry['ir.max']?.v) >= 95, '全画面最高温跟着 ≥ 95 ℃', String(hot.telemetry['ir.max']?.v))

  console.log('\n7. 温升算不出来时标质量码')
  await post(`${EMU}/emu/dev/${firstSam}/drop?keys=env.t`)
  const qd = await until(async () => {
    const q = (await live(camDev)).telemetry['q']
    const o = q ? (JSON.parse(String(q.v)) as Record<string, string>) : {}
    return o['ir.R1.rise'] ? o : null
  }, 60_000, 2000)
  check(!!qd, '柜内空气温度停发 → CAM 质量码标 ir.R1.rise', qd ? JSON.stringify(qd) : '60 s 内没标')
  await post(`${EMU}/emu/dev/${firstSam}/drop?keys=`)
  const qok = await until(async () => {
    const q = (await live(camDev)).telemetry['q']
    const o = q ? (JSON.parse(String(q.v)) as Record<string, string>) : {}
    return !o['ir.R1.rise'] ? true : null
  }, 40_000, 2000)
  check(!!qok, '恢复后质量码清掉')

  console.log('\n8. 区域配置变化')
  const ver0 = String((await live(camDev)).attributes['ir.regionsVer'])
  await fetch(`${EMU}/emu/cam/regions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { name: 'R1', type: 'region', coords: { x: 60, y: 100, width: 200, height: 160 } },
      { name: 'R2', type: 'point', coords: { x: 400, y: 200 } },
    ]),
  })
  const v2 = await until(async () => {
    const l = await live(camDev)
    return String(l.attributes['ir.regionsVer']) !== ver0 && 'ir.R2.pt' in l.telemetry ? l : null
  }, 10_000, 1000)
  check(!!v2 && (v2.attributes['ir.regions'] as unknown[]).length === 2, '区域配置变了 → ir.regionsVer 变、point 区域报 ir.R2.pt', v2 ? String(v2.attributes['ir.regionsVer']) : '')
  await fetch(`${EMU}/emu/cam/regions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { name: 'R1', type: 'region', coords: { x: 50, y: 90, width: 160, height: 150 } },
      { name: 'R2', type: 'region', coords: { x: 240, y: 90, width: 160, height: 150 } },
      { name: 'R3', type: 'region', coords: { x: 430, y: 90, width: 160, height: 150 } },
    ]),
  })

  console.log('\n9. 断流、失联、原生报警')
  await post(`${EMU}/emu/cam/stream?ch=visible&on=0`)
  const s9 = await agent<VideoStatus>(cfg.dir, '/api/video/refresh', { method: 'POST' })
  const vis = s9.channels.find(c => c.key === 'visible')
  check(!!vis && vis.probe?.ok === false && s9.metrics['cam.online'] === 3, '可见光主码流断 → 探测失败、cam.online = 3', `${vis?.probe?.error ?? ''} online=${s9.metrics['cam.online']}`)
  await post(`${EMU}/emu/cam/stream?ch=visible&on=1`)
  await post(`${EMU}/emu/cam/alarm?state=${encodeURIComponent('{"regionTemp":[2]}')}`)
  const al = await until(async () => ((await live(camDev)).telemetry['cam.alarm']?.v === '{"regionTemp":[2]}' ? true : null), 8000, 500)
  check(!!al, '原生报警原样上报 cam.alarm')
  await post(`${EMU}/emu/cam/alarm?state=${encodeURIComponent('{}')}`)
  await post(`${EMU}/emu/cam/dead?on=1`)
  const dead = await until(async () => {
    const s = await vs()
    return s.measure.supported && !s.measure.ok ? s : null
  }, 8000, 500)
  check(!!dead, '摄像机失联 → 测温失败如实显示', dead?.measure.error ?? '')
  await post(`${EMU}/emu/cam/dead?on=0`)
  const back = await until(async () => ((await vs()).measure.ok ? true : null), 10_000, 1000)
  check(!!back, '恢复后测温照常')
  await agent(cfg.dir, '/api/video/refresh', { method: 'POST' })

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
