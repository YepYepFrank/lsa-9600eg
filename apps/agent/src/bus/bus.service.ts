/* 本机总线（Mosquitto）：订阅同事的转换程序发来的全部数据，留每个 key 的最新值，并把每条遥测分发给
 * 质量码看护、派生量、南向统计（G1）、录波环形缓冲（G5）。
 * agent 自己算的量也发回总线，与传感器数据走同一条路经 IoT Gateway 上送（开发计划 §6.1）。
 *
 * agent 自己发的消息带 MQTT 5 用户属性 src=eg-agent：总线上会原样回到 agent 自己，
 * 统计「传感器来了多少条」、判断「同事是否自己发了 q / dev.*」时要把它们排除。 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import mqtt, { type MqttClient } from 'mqtt'
import { BUS_TOPIC, deviceOfTopic, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

export const SELF_SRC = 'eg-agent'

export interface Latest {
  v: unknown
  /** 设备侧时间戳 */
  ts: number
  /** agent 收到的时刻 */
  at: number
  /** 是 agent 自己算的（派生量、质量码、南向统计） */
  own: boolean
}

export interface DeviceLive {
  telemetry: Record<string, Latest>
  attributes: Record<string, unknown>
  /** 来自传感器（不含 agent 自己发的）的消息数 */
  msgs: number
  lastAt: number
}

/** 一条遥测：设备侧时间戳 + 值 */
export interface Entry {
  ts: number
  values: Record<string, unknown>
}

/** 总线上某台设备最近的原始消息（本地页「原始消息」给同事排错用） */
export interface RawMessage {
  at: number
  topic: string
  own: boolean
  payload: string
}
const RAW_KEEP = 20
const RAW_MAX_CHARS = 4000

export type TelemetryListener = (device: string, entries: Entry[], own: boolean) => void

@Injectable()
export class BusService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('总线')
  private client: MqttClient | null = null
  private readonly listeners: TelemetryListener[] = []
  private readonly connectListeners: (() => void)[] = []
  readonly live = new Map<string, DeviceLive>()
  readonly raw = new Map<string, RawMessage[]>()
  msgs = 0
  /** 不在 eg.yaml 设备清单里的设备名（同事发错名字时本地页要能看出来） */
  readonly unknown = new Map<string, number>()

  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {}

  get connected(): boolean {
    return !!this.client?.connected
  }

  /** 订阅每条遥测（传感器的与 agent 自己的都会来，own 区分） */
  onTelemetry(fn: TelemetryListener): void {
    this.listeners.push(fn)
  }

  /** 每次连上（含重连）本机总线时调用 */
  onConnect(fn: () => void): void {
    this.connectListeners.push(fn)
    if (this.connected) fn()
  }

  onModuleInit(): void {
    const known = new Set([this.cfg.eg.name, ...this.cfg.devices.map(d => d.name)])
    this.client = mqtt.connect(this.cfg.conn.bus, {
      clientId: `eg-agent-${this.cfg.cabinet.code}-${Math.random().toString(16).slice(2, 6)}`,
      protocolVersion: 5,
      reconnectPeriod: 3000,
      connectTimeout: 5000,
      keepalive: 30,
    })
    this.client.on('connect', () => {
      this.log.log(`已连本机总线 ${this.cfg.conn.bus}`)
      this.client!.subscribe([BUS_TOPIC.telemetryAll, BUS_TOPIC.attributesAll], { qos: 1 })
      for (const fn of this.connectListeners) fn()
    })
    this.client.on('error', e => this.log.warn(`本机总线：${e.message}`))
    this.client.on('message', (topic, buf, packet) => {
      const t = deviceOfTopic(topic)
      if (!t) return
      const own = packet.properties?.userProperties?.['src'] === SELF_SRC
      if (!own) this.msgs++
      const ring = this.raw.get(t.device) ?? []
      ring.push({ at: Date.now(), topic, own, payload: buf.toString('utf8').slice(0, RAW_MAX_CHARS) })
      if (ring.length > RAW_KEEP) ring.shift()
      this.raw.set(t.device, ring)
      if (!known.has(t.device)) {
        this.unknown.set(t.device, Date.now())
        return
      }
      let body: unknown
      try {
        body = JSON.parse(buf.toString('utf8'))
      } catch {
        this.log.warn(`${topic} 不是 JSON，丢弃`)
        return
      }
      const d = this.device(t.device)
      if (!own) {
        d.msgs++
        d.lastAt = Date.now()
      }
      if (t.kind === 'attributes') {
        if (body && typeof body === 'object') Object.assign(d.attributes, body)
        return
      }
      const entries = (Array.isArray(body) ? body : [body]).map(normalize).filter((e): e is Entry => !!e)
      for (const e of entries) this.take(d, e, own)
      for (const fn of this.listeners) {
        try {
          fn(t.device, entries, own)
        } catch (e) {
          this.log.warn(`处理 ${t.device} 的数据出错：${(e as Error).message}`)
        }
      }
    })
  }

  onModuleDestroy(): void {
    this.client?.end(true)
  }

  /** 发到本机总线（派生量、质量码、EG 自身指标）；与传感器数据同一格式，带 src=eg-agent */
  publish(device: string, values: Record<string, unknown>, ts = Date.now()): void {
    if (!this.client?.connected) return
    // 取不到的量不发（不发 null / 0 冒充读数，接入规范 §4 规则 4）
    const kv = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined))
    if (!Object.keys(kv).length) return
    this.client.publish(BUS_TOPIC.telemetry(device), JSON.stringify({ ts, values: kv }), {
      qos: 1,
      properties: { userProperties: { src: SELF_SRC } },
    })
  }

  /** 发设备属性（平铺对象） */
  publishAttributes(device: string, attrs: Record<string, unknown>): void {
    if (!this.client?.connected || !Object.keys(attrs).length) return
    this.client.publish(BUS_TOPIC.attributes(device), JSON.stringify(attrs), { qos: 1, properties: { userProperties: { src: SELF_SRC } } })
  }

  private device(name: string): DeviceLive {
    let d = this.live.get(name)
    if (!d) this.live.set(name, (d = { telemetry: {}, attributes: {}, msgs: 0, lastAt: 0 }))
    return d
  }

  private take(d: DeviceLive, e: Entry, own: boolean): void {
    const at = Date.now()
    for (const [k, v] of Object.entries(e.values)) {
      const old = d.telemetry[k]
      // 补发的旧数据不覆盖更新的值
      if (!old || old.ts <= e.ts) d.telemetry[k] = { v, ts: e.ts, at, own }
    }
  }
}

/** {ts, values} 带设备时间戳；只有 values 平铺时按到达时刻（接入规范要求带 ts，这里兜底） */
function normalize(e: unknown): Entry | null {
  if (!e || typeof e !== 'object') return null
  const rec = e as { ts?: unknown; values?: unknown }
  if (typeof rec.ts === 'number' && rec.values && typeof rec.values === 'object') return { ts: rec.ts, values: rec.values as Record<string, unknown> }
  return { ts: Date.now(), values: e as Record<string, unknown> }
}
