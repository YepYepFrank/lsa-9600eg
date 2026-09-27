/* eg-video 的主体（G4：docs/G4视频接口约定.md §8.5、docs/G4摄像机测温约定.md §8.6）：
 *   1. 四路流地址：local.yaml 手填的优先，其余由摄像机驱动给（sim / ONVIF），启动时与每 10 分钟刷新；
 *   2. 生成本机 mediamtx 配置（两级按需拉的 EG 这一级）；
 *   3. 测温（驱动能测温时）：每 2 s 取全画面与 R1–R3 的温度发到本机总线 lsa/CAM-<柜号>/telemetry，
 *      区域配置作为 CAM 的客户端属性 ir.regions / ir.regionsVer，原生报警 cam.alarm 变化时与每 60 s 发；
 *   4. 每 60 s 对各路做 RTSP DESCRIBE，发 cam.online / cam.fps / cam.bitrate；
 *   5. 抓帧：驱动给了抓图地址就用，否则经本机 mediamtx 拉主码流用 ffmpeg 解一帧（G5 告警抓拍用）。 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Logger } from '@nestjs/common'
import mqtt, { type MqttClient } from 'mqtt'
import { BUS_TOPIC, loadConfig, type EgConfig } from '@lsa-eg/config'
import { fetchAuth } from './digest.js'
import { driverOf, type CameraDriver, type Measurement, type StreamInfo } from './drivers.js'
import { CHANNELS, maskUri, mtxPaths, pathOf, renderMtxConfig, withCreds, type MtxPath } from './mtx.js'
import type { ChannelKey } from './onvif.js'
import { describe, type Probe } from './rtsp.js'

const PROBE_MS = 60_000
const MEASURE_MS = 2_000
const STREAMS_MS = 10 * 60_000
const ALARM_REPEAT_MS = 60_000
export const SELF_SRC = 'eg-video'

export interface RegionMeta {
  id: string
  name: string
  label: string
  type: string
  coords: Record<string, unknown>
  frame: { w: number; h: number }
}

export class VideoService {
  private readonly log = new Logger('视频')
  cfg: EgConfig
  private driver!: CameraDriver
  private sources: Partial<Record<ChannelKey, StreamInfo & { from: 'manual' | 'driver' }>> = {}
  private probes: Partial<Record<ChannelKey, Probe>> = {}
  private streamsInfo: { driver: string; ok: boolean; error: string | null; note: string | null; at: number | null } | null = null
  private mtx: { file: string; changed: boolean; at: number; readFrom: string[] } | null = null
  private mtxError: string | null = null
  private paths: MtxPath[] = []
  private lastBytes: { at: number; bytes: number } | null = null
  private metrics: Record<string, number> = {}
  // 测温
  private measure: { ok: boolean; error: string | null; at: number | null; count: number } = { ok: false, error: null, at: null, count: 0 }
  private lastTemps: Record<string, number> = {}
  private regions: RegionMeta[] = []
  private regionsVer = ''
  private publishedVer = ''
  private alarm: { state: string; sentAt: number } | null = null
  private bus: MqttClient | null = null
  private timers: NodeJS.Timeout[] = []
  private measuring = false

  constructor() {
    this.cfg = loadConfig()
  }

  get camera(): string | null {
    return this.cfg.devices.find(d => d.kind === 'camera')?.name ?? null
  }

  async start(): Promise<void> {
    this.bus = mqtt.connect(this.cfg.conn.bus, { clientId: `eg-video-${this.cfg.cabinet.code}`, protocolVersion: 5, reconnectPeriod: 3000 })
    this.bus.on('error', e => this.log.warn(`本机总线：${e.message}`))
    // 连上（含重连）后把区域配置再报一次
    this.bus.on('connect', () => (this.publishedVer = ''))
    await this.refresh()
    this.timers.push(setInterval(() => void this.refresh(), STREAMS_MS))
    this.timers.push(setInterval(() => void this.probe(), PROBE_MS))
    this.timers.push(setInterval(() => void this.measureOnce(), MEASURE_MS))
    setTimeout(() => void this.probe(), 3000)
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.bus?.end(true)
  }

  private pub(values: Record<string, unknown>, ts: number): void {
    const cam = this.camera
    if (!cam || !this.bus?.connected) return
    this.bus.publish(BUS_TOPIC.telemetry(cam), JSON.stringify({ ts, values }), { qos: 1, properties: { userProperties: { src: SELF_SRC } } })
  }

  /** 重读 local.yaml、重取流地址、重写 mediamtx 配置（本地页改了摄像机后调） */
  async refresh(): Promise<void> {
    this.cfg = loadConfig(this.cfg.dir)
    const cam = this.cfg.local.camera
    const next: typeof this.sources = {}
    const manual: Partial<Record<ChannelKey, string>> = { visible: cam.rtsp.visible, visibleSub: cam.rtsp.visibleSub, thermal: cam.rtsp.thermal, thermalSub: cam.rtsp.thermalSub }
    for (const c of CHANNELS) if (manual[c.key]) next[c.key] = { uri: withCreds(manual[c.key]!, cam.user, cam.password), snapshot: null, from: 'manual' }

    try {
      this.driver = driverOf(this.cfg)
      if (CHANNELS.some(c => !next[c.key])) {
        const r = await this.driver.streams()
        for (const c of CHANNELS) {
          const s = r.map[c.key]
          if (s && !next[c.key]) next[c.key] = { uri: withCreds(s.uri, cam.user, cam.password), snapshot: s.snapshot ?? null, from: 'driver' }
        }
        this.streamsInfo = { driver: this.driver.name, ok: true, error: null, note: r.note, at: Date.now() }
      } else this.streamsInfo = { driver: this.driver.name, ok: true, error: null, note: '四路都是手填的', at: Date.now() }
    } catch (e) {
      this.streamsInfo = { driver: this.driver?.name ?? cam.driver, ok: false, error: (e as Error).message, note: null, at: Date.now() }
      this.log.warn(`取流地址失败：${(e as Error).message}${Object.keys(next).length ? '（手填的几路照用）' : ''}`)
      // 摄像机临时不响应不该把流断掉：保留上次取到的
      for (const c of CHANNELS) if (!next[c.key] && this.sources[c.key]?.from === 'driver') next[c.key] = this.sources[c.key]
    }
    this.sources = next

    try {
      const r = await renderMtxConfig(this.cfg, Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v!.uri])))
      this.mtx = { ...r, at: Date.now() }
      this.mtxError = null
      if (r.changed) this.log.log(`mediamtx 配置已更新：${CHANNELS.filter(c => next[c.key]).map(c => pathOf(this.cfg.cabinet.code, c.key)).join('、') || '（没有可用的流地址）'} → ${r.file}`)
    } catch (e) {
      this.mtxError = (e as Error).message
      this.log.error(`写 mediamtx 配置失败：${this.mtxError}`)
    }
  }

  /** 测温一次（驱动能测温时）：温度发遥测，区域配置变了发属性，原生报警变了（或满 60 s）发 cam.alarm */
  async measureOnce(): Promise<void> {
    if (this.measuring || !this.driver?.measure) return
    this.measuring = true
    try {
      const m = await this.driver.measure()
      this.measure = { ok: true, error: null, at: Date.now(), count: this.measure.count + 1 }
      this.takeRegions(m)
      if (m.temps) {
        const values = this.telemetryOf(m)
        this.lastTemps = values
        this.pub(values, m.temps.ts)
      }
      const now = Date.now()
      if (!this.alarm || this.alarm.state !== m.alarm || now - this.alarm.sentAt >= ALARM_REPEAT_MS) {
        if (this.alarm && this.alarm.state !== m.alarm) this.log.log(`摄像机原生报警：${m.alarm || '（无）'}`)
        this.pub({ 'cam.alarm': m.alarm }, now)
        this.alarm = { state: m.alarm, sentAt: now }
      }
    } catch (e) {
      if (this.measure.ok || this.measure.error !== (e as Error).message) this.log.warn(`测温失败：${(e as Error).message}`)
      this.measure = { ...this.measure, ok: false, error: (e as Error).message }
    } finally {
      this.measuring = false
    }
  }

  /** 摄像机上的区域 → R1–R3：区域名就是 R1–R3 的按名对应，否则取前 3 个启用区域按顺序编（约定 §2） */
  private numbered(m: Measurement): { id: string; def: Measurement['regions'][number] }[] {
    const enabled = m.regions.filter(r => r.enabled)
    const byName = enabled.filter(r => /^R[1-3]$/.test(r.name))
    if (byName.length) return byName.map(r => ({ id: r.name, def: r }))
    return enabled.slice(0, 3).map((r, i) => ({ id: `R${i + 1}`, def: r }))
  }

  private takeRegions(m: Measurement): void {
    const camAttrs = this.cfg.devices.find(d => d.kind === 'camera')?.attrs ?? {}
    const labels = (camAttrs['regions'] ?? {}) as Record<string, { label?: string } | undefined>
    this.regions = this.numbered(m).map(({ id, def }) => ({ id, name: def.name, label: labels[id]?.label ?? `测温区 ${id}`, type: def.type, coords: def.coords, frame: m.frame }))
    this.regionsVer = createHash('sha1').update(JSON.stringify(this.regions)).digest('hex').slice(0, 8)
    const cam = this.camera
    if (cam && this.bus?.connected && this.regionsVer !== this.publishedVer) {
      this.bus.publish(BUS_TOPIC.attributes(cam), JSON.stringify({ 'ir.regions': this.regions, 'ir.regionsVer': this.regionsVer }), { qos: 1, properties: { userProperties: { src: SELF_SRC } } })
      if (this.publishedVer) this.log.log(`区域配置变了（${this.regions.length} 个，版本 ${this.regionsVer}）`)
      this.publishedVer = this.regionsVer
    }
  }

  /** 温度 → CAM 的遥测（约定 §2：不报 avg / center；point 区域只报 .pt） */
  private telemetryOf(m: Measurement): Record<string, number> {
    const t = m.temps!
    const out: Record<string, number> = { 'ir.max': t.glob.max, 'ir.min': t.glob.min, 'ir.max_x': t.glob.maxX, 'ir.max_y': t.glob.maxY }
    const byName = new Map(t.regions.map(r => [r.name, r]))
    for (const { id, def } of this.numbered(m)) {
      const r = byName.get(def.name)
      if (!r) continue
      if (def.type === 'point') {
        if (r.pt !== undefined) out[`ir.${id}.pt`] = r.pt
        continue
      }
      for (const [k, v] of [['max', r.max], ['min', r.min], ['max_x', r.maxX], ['max_y', r.maxY]] as const) if (v !== undefined) out[`ir.${id}.${k}`] = v
    }
    return out
  }

  /** 对各路 DESCRIBE、读 mediamtx 状态，发 cam.online / fps / bitrate */
  async probe(): Promise<void> {
    const results = await Promise.all(CHANNELS.map(async c => [c.key, this.sources[c.key] ? await describe(this.sources[c.key]!.uri, this.cfg.conn.camHost) : null] as const))
    this.probes = Object.fromEntries(results.filter(([, p]) => p).map(([k, p]) => [k, p!])) as typeof this.probes
    try {
      this.paths = await mtxPaths(this.cfg.conn.mtxApi)
      this.mtxError = null
    } catch (e) {
      this.paths = []
      this.mtxError = `mediamtx API：${(e as Error).message}`
    }
    const now = Date.now()
    const bytes = this.paths.reduce((a, p) => a + p.bytesReceived, 0)
    let bitrate: number | null = null
    if (this.lastBytes && now > this.lastBytes.at && bytes >= this.lastBytes.bytes) bitrate = Math.round(((bytes - this.lastBytes.bytes) * 8) / (now - this.lastBytes.at))
    else if (this.paths.length && this.paths.every(p => !p.ready)) bitrate = 0
    this.lastBytes = { at: now, bytes }
    const fps = this.probes.visible?.fps
    this.metrics = { 'cam.online': results.filter(([, p]) => p?.ok).length, ...(fps !== undefined ? { 'cam.fps': fps } : {}), ...(bitrate !== null ? { 'cam.bitrate': bitrate } : {}) }
    this.pub(this.metrics, now)
  }

  status() {
    const cab = this.cfg.cabinet.code
    const channels = CHANNELS.map(c => {
      const s = this.sources[c.key]
      const path = pathOf(cab, c.key)
      return {
        key: c.key,
        label: c.label,
        path,
        from: s?.from ?? null,
        uri: s ? maskUri(s.uri) : null,
        snapshot: s?.snapshot ? maskUri(s.snapshot) : null,
        probe: this.probes[c.key] ?? null,
        mtx: this.paths.find(p => p.name === path) ?? null,
      }
    })
    return {
      cabinet: cab,
      camera: this.camera,
      driver: this.streamsInfo,
      configured: channels.some(c => c.from),
      mediamtx: {
        file: this.mtx?.file ?? null,
        updatedAt: this.mtx?.at ?? null,
        rtspPort: this.cfg.local.video.rtspPort,
        readFrom: this.mtx?.readFrom ?? [],
        api: this.cfg.conn.mtxApi,
        error: this.mtxError,
      },
      channels,
      metrics: this.metrics,
      measure: { ...this.measure, supported: !!this.driver?.measure, temps: this.lastTemps, regions: this.regions, regionsVer: this.regionsVer, alarm: this.alarm?.state ?? null },
      bus: { url: this.cfg.conn.bus, connected: !!this.bus?.connected },
    }
  }

  /** 抓一帧（JPEG）：抓图地址优先，否则经本机 mediamtx 拉主码流解一帧 */
  async snapshot(ch: 'visible' | 'ir'): Promise<{ jpeg: Buffer; via: 'camera' | 'rtsp'; ts: number }> {
    const key: ChannelKey = ch === 'ir' ? 'thermal' : 'visible'
    const s = this.sources[key]
    if (!s) throw new Error(`${ch === 'ir' ? '热像' : '可见光'}主码流没有地址（驱动没给、也没手填）`)
    const ts = Date.now()
    if (s.snapshot) {
      try {
        const u = new URL(s.snapshot)
        const user = decodeURIComponent(u.username) || this.cfg.local.camera.user
        const pass = decodeURIComponent(u.password) || this.cfg.local.camera.password
        u.username = ''
        u.password = ''
        const r = await fetchAuth(u.toString(), { user, pass, timeoutMs: 5000 })
        const type = r.headers.get('content-type') ?? ''
        if (r.ok && /image/.test(type)) return { jpeg: Buffer.from(await r.arrayBuffer()), via: 'camera', ts }
        this.log.warn(`摄像机抓图失败（HTTP ${r.status} ${type}），改从视频流解一帧`)
      } catch (e) {
        this.log.warn(`摄像机抓图失败：${(e as Error).message}，改从视频流解一帧`)
      }
    }
    const url = `rtsp://127.0.0.1:${this.cfg.local.video.rtspPort}/${pathOf(this.cfg.cabinet.code, key)}`
    return { jpeg: await ffmpegFrame(url), via: 'rtsp', ts }
  }
}

/** ffmpeg 从 RTSP 解一帧 JPEG（15 s 超时） */
function ffmpegFrame(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env['FFMPEG'] || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-q:v', '3', '-f', 'image2', 'pipe:1'])
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), 15_000)
    p.stdout.on('data', d => out.push(d as Buffer))
    p.stderr.on('data', d => (err += String(d)))
    p.on('error', e => {
      clearTimeout(timer)
      reject(new Error(`起不了 ffmpeg：${e.message}`))
    })
    p.on('close', code => {
      clearTimeout(timer)
      const buf = Buffer.concat(out)
      if (code === 0 && buf.length) resolve(buf)
      else reject(new Error(`ffmpeg 没解出画面（${code}）${err.trim().split('\n').pop() ?? ''}`))
    })
  })
}
