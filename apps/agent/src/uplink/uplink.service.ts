/* 上送子站（I2，后端库 docs/EG独立TB调整方案.md §2.1、§2.2、§8.1）。
 *
 * EG 跑独立 TB，数据由 eg-agent 自己送到子站：
 *   总线上的每条遥测 / 属性（传感器的、agent 算的、EG 自身指标）─► outbox（SQLite）─► 子站 TB 网关接口（MQTT QoS1）
 *   PUBACK 后才从 outbox 删 —— 至少一次；子站 TB 按 设备 + key + 源时间戳 覆盖写，重发无害。
 * 优先级：连上以后新进来的（实时）先发；连上那一刻 outbox 里已有的（补传）按源时间从旧到新、按 backfillRate 限速地发。
 * 容量：超 maxAgeDays 或 maxMb 丢最旧的遥测，丢失区间记下来随 eg.lost 上报；接近上限时 eg.outbox_full = true。
 *
 * 子站主题（§8.1）：子设备 v1/gateway/telemetry | attributes，EG 自身 v1/devices/me/telemetry | attributes；一次发布 ≤ 500 个样本且 ≤ 48 KB（chunk.ts）。
 * 上报给子站的上送状态（随 EG 自身指标每 5 s）：eg.buf_depth、eg.oldest_unsent、eg.backfill_pct、eg.uplink、eg.outbox_full、eg.lost。 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import mqtt, { type MqttClient } from 'mqtt'
import { stationToken, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'
import { OutboxStore, type OutRow, type RowKind } from './outbox.store.js'
import { chunkRows, MAX_PAYLOAD_BYTES } from './chunk.js'
import { AuditService } from '../audit/audit.service.js'

export type UplinkState = 'ok' | 'backfill' | 'paused' | 'offline' | 'stuck' | 'none' | 'unknown'

export interface UplinkStatus {
  state: UplinkState
  text: string
  /** outbox 待发条数 */
  depth: number | null
  /** 最早未发样本的源时间 */
  oldestUnsent: number | null
  /** 最近一次子站确认（PUBACK）的时刻 */
  lastAckAt: number | null
  /** 子站 MQTT 地址 */
  target: string | null
  backfillPct?: number | null
  outboxMb?: number
  lost?: number
}

const BATCH = 500
const MAX_INFLIGHT = 8
const TICK_MS = 200
const FLUSH_MS = 200
const TRIM_EVERY_MS = 60_000
/** 丢过数据后这么久内 eg.outbox_full 保持 true（让子站来得及报出来） */
const FULL_HOLD_MS = 10 * 60_000

@Injectable()
export class UplinkService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('上送')
  private store: OutboxStore | null = null
  private client: MqttClient | null = null
  private pending: { dev: string; kind: RowKind; ts: number; body: string }[] = []
  private timers: NodeJS.Timeout[] = []
  /** 本次启动的标识（§2.2；遥测靠 ts 幂等用不到，事件 I3 用） */
  readonly bootId = randomBytes(6).toString('hex')
  /** 主机这次开机的 id（§8.1 hostBootId；容器里读的是宿主机内核的，开发机 Windows 上读不到为 null） */
  readonly hostBootId: string | null = (() => {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
    } catch {
      return null
    }
  })()

  /** EG 自身的重启识别属性（§8.1）：子站 hostBootId 变 → 主机重启；只有 agentBootId 变 → 服务重启 */
  bootAttrs(): { hostBootId: string | null; agentBootId: string } {
    return { hostBootId: this.hostBootId, agentBootId: this.bootId }
  }

  // 发送游标：mark = 连上那一刻 outbox 的最大 seq；> mark 的是实时，≤ mark 的是补传
  private mark = 0
  private rtCursor = 0
  private histCursor = 0
  private histTotal = 0
  private histSent = 0
  private inflight = 0
  private tokens = 0
  private downSince: number | null = Date.now()
  private lastAckAt: number | null = null
  /** 发给子站的字节数（遥测载荷 + 告警事件请求体），算 eg.up_kbps 的退路 */
  private sentBytes = 0
  private rateMark: { at: number; bytes: number } | null = null
  /** 调试：人为断开（EG_DEBUG=1，自检模拟断网） */
  forcedDown = false

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly audit: AuditService,
  ) {}

  get configured(): boolean {
    return !!this.cfg.station.mqtt && !!stationToken(this.cfg)
  }

  /** EG_UPLINK=off：关掉上送（联调分步做时用，如 I1 只验本地 TB） */
  get disabled(): boolean {
    return process.env['EG_UPLINK'] === 'off'
  }

  onModuleInit(): void {
    if (this.disabled) {
      this.log.warn('上送已关闭（EG_UPLINK=off），数据只进本地 TB')
      return
    }
    if (!this.configured) {
      this.log.warn('eg.yaml 里没有子站上送地址与令牌（station.mqtt / station.token），数据只进本地 TB')
      return
    }
    this.store = new OutboxStore(resolve(this.cfg.dir, 'outbox.db'))
    const s = this.store.stats()
    if (s.depth) this.log.log(`outbox 里有上次没送完的 ${s.depth} 条，连上后补传`)
    this.bus.onTelemetry((dev, entries) => {
      for (const e of entries) this.pending.push({ dev, kind: 't', ts: e.ts, body: JSON.stringify(e.values) })
    })
    this.bus.onAttributes((dev, attrs) => this.pending.push({ dev, kind: 'a', ts: Date.now(), body: JSON.stringify(attrs) }))
    this.timers.push(setInterval(() => this.flush(), FLUSH_MS))
    this.timers.push(setInterval(() => this.pump(), TICK_MS))
    this.timers.push(setInterval(() => this.trim(), TRIM_EVERY_MS))
    this.connect()
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t)
    this.flush()
    this.client?.end(true)
    this.store?.close()
  }

  /** 调试：断开 / 恢复上行 */
  setForcedDown(down: boolean): void {
    this.forcedDown = down
    if (down) {
      const c = this.client
      this.client = null
      c?.end(true)
      this.onDown()
    } else if (!this.client) this.connect()
  }

  status(): UplinkStatus {
    const target = this.cfg.station.mqtt ?? null
    if (!this.store) {
      const text = this.disabled ? '上送已关闭（EG_UPLINK=off）：数据只进本地 TB' : 'eg.yaml 里还没有子站的上送地址与令牌（station.mqtt / station.token）：数据只进本地 TB'
      return { state: 'none', text, depth: null, oldestUnsent: null, lastAckAt: null, target }
    }
    const s = this.store.stats()
    const pct = this.backfillPct()
    const up = !!this.client?.connected
    const base = {
      depth: s.depth,
      oldestUnsent: s.oldestTs,
      lastAckAt: this.lastAckAt,
      target,
      backfillPct: pct,
      outboxMb: Math.round(s.bytes / 1048576),
      lost: this.store.lostTotal(),
    }
    if (!up) {
      const mins = this.downSince ? Math.round((Date.now() - this.downSince) / 60_000) : 0
      return { ...base, state: 'offline', text: `连不上子站 ${target}${mins ? `（已 ${mins} 分钟）` : ''}，待发 ${s.depth} 条，恢复后按原时间补传` }
    }
    if (pct !== null) return { ...base, state: 'backfill', text: `补传中 ${pct} %，待发 ${s.depth} 条` }
    return { ...base, state: 'ok', text: s.depth > 100 ? `正常，待发 ${s.depth} 条` : '正常，无积压' }
  }

  /** 上送状态指标，随 EG 自身指标上报（§8.1） */
  metrics(): Record<string, unknown> {
    if (!this.store) return {}
    const s = this.store.stats()
    // 丢过数据后保持 FULL_HOLD_MS：丢弃时刻存在库里，agent 重启不会提前变回 false
    const full = s.bytes >= this.cfg.local.outbox.maxMb * 1048576 * 0.95 || Date.now() - this.store.lastLostAt() < FULL_HOLD_MS
    const pct = this.backfillPct()
    return {
      'eg.buf_depth': s.depth,
      'eg.oldest_unsent': s.oldestTs,
      'eg.backfill_pct': pct,
      'eg.uplink': !this.client?.connected ? 'down' : pct !== null ? 'backfill' : 'ok',
      'eg.outbox_full': full,
      'eg.lost': JSON.stringify(this.store.lost()),
    }
  }

  countSent(bytes: number): void {
    this.sentBytes += bytes
  }

  /** 上次调用以来的平均发送速率（kbps）；上送没开返回 null */
  sentKbps(): number | null {
    if (!this.store && !this.sentBytes) return null
    const now = Date.now()
    const m = this.rateMark
    this.rateMark = { at: now, bytes: this.sentBytes }
    if (!m || now <= m.at) return null
    return Math.round((((this.sentBytes - m.bytes) * 8) / (now - m.at)) * 10) / 10
  }

  private backfillPct(): number | null {
    if (!this.client?.connected || this.histCursor >= this.mark || this.histTotal === 0) return null
    return Math.min(99, Math.floor((this.histSent / this.histTotal) * 100))
  }

  private connect(): void {
    if (this.forcedDown || !this.cfg.station.mqtt) return
    const c = mqtt.connect(this.cfg.station.mqtt, {
      username: stationToken(this.cfg),
      clientId: `eg-uplink-${this.cfg.cabinet.code}-${this.bootId}`,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      keepalive: 30,
    })
    this.client = c
    c.on('connect', () => this.onUp())
    c.on('close', () => this.onDown())
    c.on('error', e => this.log.warn(`子站 MQTT：${e.message}`))
  }

  private onUp(): void {
    this.flush()
    this.mark = this.store!.maxSeq()
    this.rtCursor = this.mark
    this.histCursor = 0
    this.histTotal = this.store!.stats().depth
    this.histSent = 0
    this.inflight = 0
    this.tokens = 0
    const was = this.downSince
    this.downSince = null
    this.log.log(`已连子站 ${this.cfg.station.mqtt}${this.histTotal ? `，补传 ${this.histTotal} 条` : ''}${was ? `（断了 ${Math.round((Date.now() - was) / 1000)} s）` : ''}`)
    // 声明子设备在线（TB 网关接口）；EG 自己是网关本身，不用声明
    for (const d of this.cfg.devices) this.client!.publish('v1/gateway/connect', JSON.stringify({ device: d.name }), { qos: 1 })
    // 重启识别（§8.1）：每次连上子站发一次
    this.client!.publish('v1/devices/me/attributes', JSON.stringify(this.bootAttrs()), { qos: 1 })
  }

  private onDown(): void {
    if (this.downSince === null) {
      this.downSince = Date.now()
      this.log.warn('子站连接断开，数据留在 outbox，恢复后补传')
    }
    this.inflight = 0
  }

  private flush(): void {
    if (!this.pending.length || !this.store) return
    const rows = this.pending
    this.pending = []
    try {
      this.store.push(rows)
    } catch (e) {
      this.log.error(`写 outbox 失败：${(e as Error).message}`)
    }
  }

  private pump(): void {
    const c = this.client
    if (!c?.connected || !this.store) return
    // 补传限速：令牌桶，每秒 backfillRate 个样本，最多攒 1 秒
    const rate = this.cfg.local.outbox.backfillRate
    this.tokens = Math.min(rate, this.tokens + (rate * TICK_MS) / 1000)
    while (this.inflight < MAX_INFLIGHT) {
      let rows = this.store.take(this.rtCursor, Number.MAX_SAFE_INTEGER, BATCH)
      let history = false
      if (rows.length) this.rtCursor = rows[rows.length - 1]!.seq
      else {
        if (this.histCursor >= this.mark) break
        const n = Math.min(BATCH, Math.floor(this.tokens))
        if (n < 1) break
        rows = this.store.take(this.histCursor, this.mark, n)
        if (!rows.length) {
          this.histCursor = this.mark
          if (this.histTotal) this.log.log(`补传完成（${this.histSent} 条）`)
          break
        }
        this.histCursor = rows[rows.length - 1]!.seq
        this.tokens -= rows.length
        history = true
      }
      this.send(c, rows, history)
    }
  }

  /** 按主题分组、按条数与字节切批（chunk.ts：≤ 500 条且 ≤ 48 KB）发出去；每批 PUBACK 后删掉对应的行 */
  private send(c: MqttClient, rows: OutRow[], history: boolean): void {
    const { publishes, oversized } = chunkRows(rows, this.cfg.eg.name)
    for (const r of oversized) this.dropOversized(r)
    for (const g of publishes) {
      this.inflight++
      const topic = g.topic
      const payload = g.payload
      this.sentBytes += Buffer.byteLength(payload)
      c.publish(topic, payload, { qos: 1 }, err => {
        this.inflight = Math.max(0, this.inflight - 1)
        if (err) return // 没确认的留在 outbox，重连后再发
        this.store?.ack(g.seqs)
        this.lastAckAt = Date.now()
        if (history) this.histSent += g.seqs.length
      })
    }
  }

  /** 单独一行就超过子站能收的大小：记审计、记丢失、从 outbox 删掉，不让它卡住后面的 */
  private dropOversized(r: OutRow): void {
    const bytes = Buffer.byteLength(r.body)
    this.log.warn(`${r.dev} 源时间 ${new Date(r.ts).toISOString()} 的一条${r.kind === 't' ? '遥测' : '属性'}有 ${bytes} 字节，超过子站单条上限 ${MAX_PAYLOAD_BYTES}，丢弃`)
    this.audit.write({ user: 'system', name: '上送', via: 'system', ip: '-', action: 'uplink.oversized', target: `${r.dev} ${r.kind} ${r.ts}`, ok: false, detail: `${bytes} 字节 > ${MAX_PAYLOAD_BYTES}` })
    this.store?.ack([r.seq])
    if (r.kind === 't') this.store?.recordLost({ from: r.ts, to: r.ts, n: 1 })
  }

  private trim(): void {
    if (!this.store) return
    this.flush()
    const o = this.cfg.local.outbox
    const lost = this.store.trim(Date.now() - o.maxAgeDays * 86_400_000, o.maxMb * 1048576)
    if (lost) {
      this.log.warn(`outbox 超出上限（${o.maxAgeDays} 天 / ${o.maxMb} MB），丢了最旧的 ${lost.n} 条（源时间 ${new Date(lost.from).toISOString()} – ${new Date(lost.to).toISOString()}）`)
    }
  }
}
