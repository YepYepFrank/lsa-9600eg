/* eg-agent 本地 API 的返回形状（apps/agent/src/*.controller.ts） */

export interface Dev {
  name: string
  kind: 'sam' | 'meter' | 'pm' | 'camera' | 'eg'
  label: string
  keys: number
  msgs: number
  lastTs: number | null
  ageSec: number | null
  dead: boolean
  q: Record<string, string>
  south: { req: number; timeout: number; rate: number | null } | null
  southBySource: boolean
  rated: number | null
  epBackwards: number
  /** 阶段 A：通信状态（§13）；fromSource = 转换程序自报的项 */
  comm?: { comm: 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN'; lastOk: number | null; fails: number; err: string; fromSource: { lastOk: boolean; fails: boolean; err: boolean } }
  /** 阶段 A：能力全都不启用 = false（不上送子站） */
  capsEnabled?: boolean
  /** v1.2：能力全都是 unsupported = false（不进 EG 本地 TB） */
  capsLocal?: boolean
}

export interface Status {
  eg: string
  version: string
  cabinet: { code: string; name: string; group: string; kind: string; rated: number; rooms: string[] }
  station: { name: string; label: string }
  sp: { host: string }
  uptimeSec: number
  rssMb: number
  state: 'online' | 'degraded'
  bus: { url: string; connected: boolean; msgs: number }
  devices: Dev[]
  unknownDevices: string[]
}

export interface Comp {
  key: 'agent' | 'tb' | 'gateway' | 'mosquitto' | 'mediamtx'
  label: string
  container: string | null
  state: string
  startedAt: number | null
  restarts: number | null
  memMb: number | null
  cpuPct: number | null
  image: string | null
  restartable: boolean
}

export interface Diag {
  now: number
  bus: { url: string; connected: boolean }
  sp: { host: string; port: number; latMs: number | null; lossPct: number | null }
  clock: { server: string; offsetMs: number | null; measuredAt: number | null }
  /** 上送子站（I 阶段：eg-agent 的 outbox；I1 还没接上时 state = none） */
  uplink: {
    state: 'ok' | 'backfill' | 'paused' | 'offline' | 'stuck' | 'none' | 'unknown'
    text: string
    depth: number | null
    oldestUnsent: number | null
    lastAckAt: number | null
    target: string | null
  }
  /** 告警事件送子站（I3：本地 TB 告警 → /ext/eg/<柜号>/events） */
  events: {
    state: 'ok' | 'retrying' | 'off' | 'none'
    text: string
    target: string | null
    pending: number
    oldestQueuedAt: number | null
    lastAckAt: number | null
    lastError: string | null
    active: number
    hook: { count: number; lastAt: number | null; ignored: boolean }
    reconcile: { lastAt: number | null; lastError: string | null }
  }
  /** 视频与测温（G4，eg-video 转来；不在时 available=false） */
  video?: {
    available: boolean
    error?: string
    driver?: { driver: string; ok: boolean; error: string | null } | null
    metrics?: Record<string, number>
    measure?: { supported: boolean; ok: boolean; error: string | null; at: number | null }
    mediamtx?: { error: string | null }
  }
  host: { uptimeSec: number; memUsedPct: number; disk: { usedPct: number; freeGb: number } | null }
  devices: { dead: string[]; unknown: string[] }
}

export interface Latest {
  v: unknown
  ts: number
  at: number
  own: boolean
}

export interface Live {
  device: string
  telemetry: Record<string, Latest>
  attributes: Record<string, unknown>
  msgs: number
  lastAt: number
  q: Record<string, string>
}

export interface PointDef {
  key: string
  label: string
  unit: string
  periodMs: number | null
  optional: boolean
  json: boolean
}

export interface Catalog {
  devices: Record<string, PointDef[]>
  common: PointDef[]
  derived: string[]
}

export interface DeviceConf {
  name: string
  kind: string
  label: string
  attrs: Record<string, unknown>
}

export interface Config {
  eg: {
    generatedAt: string
    station: { name: string; label: string }
    sp: { host: string }
    cabinet: { code: string; name: string; group: string; kind: string; rated: number; riseLimit: number; rooms: string[]; index: number }
    eg: { name: string; token: string; attrs: Record<string, unknown> }
    devices: DeviceConf[]
    stationUplink: { mqtt: string | null; token: string }
    tb: { user: string; password: string } | null
  }
  local: {
    mqtt: { bus: string; tb: string }
    tb: { http: string }
    http: { port: number }
    ntp: { server: string }
    net: { uplink: string }
    docker: { api: string; containers: Record<string, string> }
    camera: { driver: string; onvif: string; user: string; password: string; rtsp: { visible: string; thermal: string; visibleSub: string; thermalSub: string } }
  }
  /** 子站下发、实际生效的告警规则与阈值版本（I4） */
  applied?: { version: string | null; appliedAt: number | null; by: string | null; rulesOff: string[] }
}

export interface AuditEntry {
  ts: number
  user: string
  name: string
  via: 'local' | 'sp' | 'system'
  ip: string
  action: string
  target: string
  ok: boolean
  detail?: string
}

export interface RawMessage {
  at: number
  topic: string
  own: boolean
  payload: string
}

export const KIND: Record<string, string> = { sam: '感知模块', meter: '多功能电表', pm: '颗粒物传感器', camera: '双光视频', eg: '边缘网关' }
