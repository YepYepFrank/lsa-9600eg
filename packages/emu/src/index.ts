/* 同事的转换程序的仿真：把本柜各传感器的数据按《EG 内部 MQTT 格式》发到本机总线。
 *
 *   pnpm emu                      按 run/eg.yaml 的柜，mixed 场景（与子站模拟器同一套预埋异常）
 *   pnpm emu -- --scenario calm
 *
 * 数值来自 @lsa/points 的确定性发生器 —— 与子站模拟器（apps/sim）同一个函数，
 * 所以这面柜交给 EG 端以后，子站看到的曲线与模拟器跑时一样，前后接得上。
 *
 * 只发「传感器本来就有的量」：负荷率 el.load_pct、质量码 q、EG 自身指标、南向统计由 eg-agent 算（开发计划 §6.1），这里不发。
 *
 * 控制面（默认 127.0.0.1:3190，只给开发 / 自检用）：
 *   GET  /emu/status
 *   POST /emu/dev/<设备名>/dead?on=1|0   这台设备停发（模拟传感器掉线）/ 恢复
 *   POST /emu/dev/<设备名>/drop?keys=a,b  这台设备只停发这几个量（模拟单个传感器坏）；keys 为空 = 恢复
 *   POST /emu/arc?intensity=420&ms=22    热点隔室的 SAM 打一次弧光脉冲
 *
 * 仿真摄像机（G4 摄像机测温约定 §6，camera.ts）：eg-video 的 sim 驱动取 GET /emu/cam/state；
 *   POST /emu/cam/overtemp?region=R2&max=95&s=120   区域最高温保持 s 秒
 *   POST /emu/cam/stream?ch=visible|visibleSub|thermal|thermalSub|all&on=0|1   断 / 恢复视频流
 *   POST /emu/cam/dead?on=1|0                      整台摄像机失联
 *   POST /emu/cam/regions                          改区域配置（请求体 JSON 数组：{name,type,coords,enabled}）
 *   POST /emu/cam/alarm?state=…                    原生报警状态
 * 摄像机的 cam.* 由 eg-video 报，这里不再替摄像机发（它不是同事程序管的传感器）。 */
import { createServer } from 'node:http'
import mqtt from 'mqtt'
import { BUS_TOPIC, loadConfig, type EgConfig } from '@lsa-eg/config'
import { attributesOf, PERIOD, planCabinets, telemetryOf, type CabPlan, type Ctx, type Period, type Scenario } from '@lsa/points'
import type { CabinetSpec, SubDeviceSpec } from '@lsa/model'
import { CameraSim, type RegionDef } from './camera.js'

const argv = process.argv.slice(2)
const arg = (name: string, d: string) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d
}
const SCENARIO = arg('scenario', 'mixed') as Scenario
const CTL_PORT = Number(process.env['EMU_CTL_PORT'] ?? 3190)
const log = (...a: unknown[]) => console.log(new Date().toLocaleTimeString(), ...a)

/** 同事那边不算的量，由 eg-agent 算 */
const NOT_FROM_SENSORS = new Set(['el.load_pct'])

function cabinetOf(cfg: EgConfig): CabinetSpec {
  const sub = (d: EgConfig['devices'][number]): SubDeviceSpec => ({ name: d.name, kind: d.kind, profile: '', label: d.label, attrs: d.attrs })
  return {
    ...cfg.cabinet,
    // 后端 I5 起 CabinetSpec 必带 egMode，EG 一律独立 TB
    egMode: 'standalone',
    assetType: '',
    samProfile: '',
    camProfile: '',
    eg: { name: cfg.eg.name, kind: 'eg', profile: '', label: cfg.eg.name, attrs: cfg.eg.attrs },
    subs: cfg.devices.map(sub),
  }
}

/** SAM 名字以 -A/-B/-C 结尾，按隔室顺序；其余设备算第 0 个隔室（同子站模拟器） */
function roomIndexOf(s: SubDeviceSpec, cab: CabinetSpec): number {
  if (s.kind !== 'sam') return 0
  const i = 'ABC'.indexOf(s.name.slice(-1))
  return i >= 0 && i < cab.rooms.length ? i : 0
}

async function main() {
  const cfg = loadConfig()
  const cab = cabinetOf(cfg)
  const plan: CabPlan = planCabinets([cab], SCENARIO, Date.now()).get(cab.code)!
  const ctxOf = new Map<string, Ctx>()
  for (const s of cab.subs) {
    const room = roomIndexOf(s, cab)
    ctxOf.set(s.name, { plan, room, roomName: cab.rooms[room] ?? '', zones: false })
  }
  const cam = new CameraSim(
    plan,
    cab.rooms.length,
    process.env['EMU_CAM_RTSP'] ?? 'rtsp://admin:lsa-cam@camera:8554',
    process.env['EMU_CAM_API'] ?? 'http://127.0.0.1:19998',
  )
  const dead = new Set<string>()
  const drop = new Map<string, Set<string>>()
  let sent = 0

  const client = await mqtt.connectAsync(cfg.conn.bus, {
    clientId: `emu-${cab.code}-${Math.random().toString(16).slice(2, 6)}`,
    reconnectPeriod: 3000,
    keepalive: 30,
  })
  log(`已连本机总线 ${cfg.conn.bus}，仿真 ${cab.code} 的 ${cab.subs.length} 台传感器（场景 ${SCENARIO}）`)

  const pub = (dev: string, values: Record<string, unknown>, ts: number) => {
    client.publish(BUS_TOPIC.telemetry(dev), JSON.stringify({ ts, values }), { qos: 1 })
    sent += Object.keys(values).length
  }

  // 静态属性：上电发一次（同事的程序每次连上总线也要发）。只发同事那边知道的（固件版本、SAM 的分框）；
  // 隔室、端口、额定电流这些子站下发的由 eg-agent 按 eg.yaml 发
  const FROM_SENSORS = ['fw', 'ir.boxes']
  const sendAttrs = () => {
    for (const s of cab.subs) {
      const all = attributesOf(s, ctxOf.get(s.name)!)
      const mine = Object.fromEntries(FROM_SENSORS.filter(k => k in all).map(k => [k, all[k]]))
      if (Object.keys(mine).length) client.publish(BUS_TOPIC.attributes(s.name), JSON.stringify(mine), { qos: 1 })
    }
  }
  sendAttrs()
  client.on('connect', sendAttrs)

  const tick = (period: Period) => {
    const ts = Date.now()
    for (const s of cab.subs) {
      if (dead.has(s.name) || s.kind === 'camera') continue
      const kv = telemetryOf(s, ctxOf.get(s.name)!, period, ts)
      if (!kv) continue
      for (const k of NOT_FROM_SENSORS) delete kv[k]
      for (const k of drop.get(s.name) ?? []) delete kv[k]
      if (Object.keys(kv).length) pub(s.name, kv, ts)
    }
  }
  for (const p of ['fast', 'slow', 'minute'] as const) setInterval(() => tick(p), PERIOD[p])

  const arc = (intensity: number, ms: number) => {
    const sam = cab.subs.find(s => s.kind === 'sam' && roomIndexOf(s, cab) === plan.params.hotRoom) ?? cab.subs.find(s => s.kind === 'sam')
    if (!sam) return null
    pub(sam.name, { 'uv.int': intensity, 'uv.pulse': JSON.stringify({ peak: intensity, ms }) }, Date.now())
    log(`${sam.name} 弧光脉冲 强度 ${intensity} 持续 ${ms} ms`)
    return sam.name
  }
  // 预埋的周期性弧光（mixed 场景的 AH05）
  if (plan.arcEveryMs > 0) setInterval(() => arc(380 + Math.round(Math.random() * 200), 18 + Math.round(Math.random() * 25)), plan.arcEveryMs)

  createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const seg = url.pathname.split('/').filter(Boolean)
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body, null, 2))
    }
    const num = (k: string, d: number) => {
      const n = Number(url.searchParams.get(k) ?? d)
      return Number.isFinite(n) ? n : d
    }
    if (req.method === 'GET' && seg[1] === 'status') {
      return json(200, {
        cabinet: cab.code,
        scenario: SCENARIO,
        connected: client.connected,
        sentValues: sent,
        dead: [...dead],
        drop: Object.fromEntries([...drop].map(([d, ks]) => [d, [...ks]])),
      })
    }
    if (req.method === 'POST' && seg[1] === 'dev' && seg[2] && seg[3] === 'dead') {
      if (!cab.subs.some(s => s.name === seg[2])) return json(404, { error: `没有设备 ${seg[2]}` })
      if (url.searchParams.get('on') === '0') dead.delete(seg[2])
      else dead.add(seg[2])
      log(`${seg[2]} ${dead.has(seg[2]) ? '停发（仿真掉线）' : '恢复'}`)
      return json(200, { ok: true, dead: [...dead] })
    }
    if (req.method === 'POST' && seg[1] === 'dev' && seg[2] && seg[3] === 'drop') {
      if (!cab.subs.some(s => s.name === seg[2])) return json(404, { error: `没有设备 ${seg[2]}` })
      const keys = (url.searchParams.get('keys') ?? '').split(',').map(k => k.trim()).filter(Boolean)
      if (keys.length) drop.set(seg[2], new Set(keys))
      else drop.delete(seg[2])
      log(`${seg[2]} ${keys.length ? `停发 ${keys.join('、')}` : '各量恢复'}`)
      return json(200, { ok: true, drop: keys })
    }
    if (req.method === 'POST' && seg[1] === 'arc') return json(200, { ok: true, device: arc(num('intensity', 420), num('ms', 22)) })
    if (seg[1] === 'cam') {
      const q = (k: string) => url.searchParams.get(k) ?? ''
      if (req.method === 'GET' && seg[2] === 'state') {
        const st = cam.state()
        return st.online ? json(200, st) : json(503, { error: '摄像机失联（仿真）' })
      }
      if (req.method === 'POST' && seg[2] === 'overtemp') {
        cam.overtemp(q('region') || 'R1', num('max', 95), num('s', 120))
        log(`摄像机 ${q('region') || 'R1'} 注入过温 ${num('max', 95)} ℃ ${num('s', 120)} s`)
        return json(200, { ok: true })
      }
      if (req.method === 'POST' && seg[2] === 'stream') {
        const ch = (q('ch') || 'all') as Parameters<CameraSim['setStream']>[0]
        void cam.setStream(ch, q('on') !== '0').then(() => json(200, { ok: true, streams: cam.state().streams }))
        log(`摄像机视频 ${ch} ${q('on') !== '0' ? '恢复' : '断流'}`)
        return
      }
      if (req.method === 'POST' && seg[2] === 'dead') {
        void cam.setDead(q('on') !== '0').then(() => json(200, { ok: true }))
        log(`摄像机 ${q('on') !== '0' ? '失联（仿真）' : '恢复'}`)
        return
      }
      if (req.method === 'POST' && seg[2] === 'alarm') {
        cam.setAlarm(q('state'))
        return json(200, { ok: true })
      }
      if (req.method === 'POST' && seg[2] === 'regions') {
        let body = ''
        req.on('data', d => (body += d))
        req.on('end', () => {
          try {
            const r = JSON.parse(body) as RegionDef[]
            if (!Array.isArray(r)) throw new Error('要 JSON 数组')
            cam.setRegions(r.map(x => ({ ...x, enabled: x.enabled ?? true })))
            log(`摄像机区域配置改为 ${r.length} 个`)
            json(200, { ok: true, regions: cam.state().regions })
          } catch (e) {
            json(400, { error: (e as Error).message })
          }
        })
        return
      }
    }
    json(404, { error: '未知路径' })
  }).listen(CTL_PORT, '127.0.0.1', () => log(`控制面 http://127.0.0.1:${CTL_PORT}/emu/status`))

  setInterval(() => log(`累计发出 ${sent.toLocaleString()} 个值${dead.size ? `，停发 ${[...dead].join('、')}` : ''}`), 60_000)
}

main().catch(e => {
  console.error('仿真器启动失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
