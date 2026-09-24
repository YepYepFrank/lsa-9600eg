/* 本机总线（Mosquitto）：订阅同事的转换程序发来的全部数据，留每个 key 的最新值。
 * 本地管理页的实时数据、质量码看护（G1）、录波环形缓冲（G5）都从这里取。
 * agent 自己算的派生量也发回总线，与传感器数据走同一条路经 IoT Gateway 上送（开发计划 §6.1）。 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import mqtt, { type MqttClient } from 'mqtt'
import { BUS_TOPIC, deviceOfTopic, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

export interface Latest {
  v: unknown
  /** 设备侧时间戳 */
  ts: number
  /** agent 收到的时刻 */
  at: number
}

export interface DeviceLive {
  telemetry: Record<string, Latest>
  attributes: Record<string, unknown>
  msgs: number
  lastAt: number
}

@Injectable()
export class BusService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('总线')
  private client: MqttClient | null = null
  readonly live = new Map<string, DeviceLive>()
  msgs = 0
  /** 不在 eg.yaml 设备清单里的设备名（同事发错名字时本地页要能看出来） */
  readonly unknown = new Map<string, number>()

  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {}

  get connected(): boolean {
    return !!this.client?.connected
  }

  onModuleInit(): void {
    const known = new Set([this.cfg.eg.name, ...this.cfg.devices.map(d => d.name)])
    this.client = mqtt.connect(this.cfg.conn.bus, {
      clientId: `eg-agent-${this.cfg.cabinet.code}-${Math.random().toString(16).slice(2, 6)}`,
      reconnectPeriod: 3000,
      connectTimeout: 5000,
      keepalive: 30,
    })
    this.client.on('connect', () => {
      this.log.log(`已连本机总线 ${this.cfg.conn.bus}`)
      this.client!.subscribe([BUS_TOPIC.telemetryAll, BUS_TOPIC.attributesAll], { qos: 1 })
    })
    this.client.on('error', e => this.log.warn(`本机总线：${e.message}`))
    this.client.on('message', (topic, buf) => {
      const t = deviceOfTopic(topic)
      if (!t) return
      this.msgs++
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
      d.msgs++
      d.lastAt = Date.now()
      if (t.kind === 'attributes') Object.assign(d.attributes, body)
      else for (const e of Array.isArray(body) ? body : [body]) this.take(d, e)
    })
  }

  onModuleDestroy(): void {
    this.client?.end(true)
  }

  /** 发到本机总线（派生量、EG 自身指标）；与传感器数据同一格式 */
  publish(device: string, values: Record<string, unknown>, ts = Date.now()): void {
    if (!this.client?.connected) return
    // 取不到的量不发（不发 null / 0 冒充读数，接入规范 §4 规则 4）
    const kv = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined))
    if (!Object.keys(kv).length) return
    this.client.publish(BUS_TOPIC.telemetry(device), JSON.stringify({ ts, values: kv }), { qos: 1 })
  }

  private device(name: string): DeviceLive {
    let d = this.live.get(name)
    if (!d) this.live.set(name, (d = { telemetry: {}, attributes: {}, msgs: 0, lastAt: 0 }))
    return d
  }

  /** 一条遥测：{ts, values} 带设备时间戳；只有 values 平铺时按到达时刻 */
  private take(d: DeviceLive, e: unknown): void {
    if (!e || typeof e !== 'object') return
    const at = Date.now()
    const rec = e as { ts?: unknown; values?: unknown }
    const hasTs = typeof rec.ts === 'number' && rec.values && typeof rec.values === 'object'
    const ts = hasTs ? (rec.ts as number) : at
    const values = (hasTs ? rec.values : e) as Record<string, unknown>
    for (const [k, v] of Object.entries(values)) {
      const old = d.telemetry[k]
      // 补发的旧数据不覆盖更新的值
      if (!old || old.ts <= ts) d.telemetry[k] = { v, ts, at }
    }
  }
}
