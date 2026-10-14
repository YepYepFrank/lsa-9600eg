/* mqtt.js 长连接保活（0.17）：agent 上送子站、agent / eg-video 本机总线、仿真器共用。
 *
 * mqtt.js 5.x 收到被拒的 CONNACK（Not authorized、Server unavailable…）会置 reconnectSuppressed，从此不再重连 ——
 * 子站 TB 重启（升级、重启主机）时只要时机不巧回了一个拒绝，这台 EG 就永远不再上送，直到 agent 重启
 * （后端模拟器 10-11 在 dind 里踩过：TB 重启时 21 台 EG 全断、一直连不回去，后端 #40）。三层：
 *   1. 建客户端时一律 reconnectOnConnackError: true（mqtt.js 自己被拒后照样重连）；
 *   2. 连续被拒时把 mqtt.js 的重连间隔按 min → max 翻倍（令牌错时不必每几秒敲一次），连上就恢复；
 *   3. 兜底：close 之后 mqtt.js 没排重连（没有 reconnectTimer，不管什么原因），就关掉它、退避后换个新客户端重连。
 * 被拒的原因（CONNACK 码 + 文字）记在 refused 里，调用方写日志 / 状态，不静默。
 *
 * 不 import mqtt（本包不依赖它）：create 由调用方给，类型按结构对。 */

/** 用到的 mqtt.js 客户端成员 */
export interface KeepClient {
  connected: boolean
  disconnecting?: boolean
  options: { reconnectPeriod?: number }
  on(event: 'connect', fn: () => void): unknown
  on(event: 'close', fn: () => void): unknown
  on(event: 'error', fn: (e: Error & { code?: unknown }) => void): unknown
  end(force?: boolean): unknown
}

export interface Refused {
  /** CONNACK 码（MQTT 3.1.1 的 returnCode 或 5.0 的 reasonCode） */
  code: number
  /** mqtt.js 给的文字，如 Not authorized */
  reason: string
  /** 这一段连续被拒从什么时候开始 */
  since: number
  /** 这一段连续被拒的次数 */
  count: number
}

export interface KeepOptions<C extends KeepClient> {
  /** 建一个新客户端（调用方传 reconnectOnConnackError: true 与自己的 clientId 等；mqttKeepOptions 可帮着补） */
  create: () => C
  /** 每个新客户端建好后挂调用方自己的监听（connect 里订阅等） */
  wire?: (c: C) => void
  log?: (level: 'log' | 'warn', msg: string) => void
  /** 退避起点 / 上限（毫秒），缺省 5 s / 60 s */
  minMs?: number
  maxMs?: number
  /** 被拒 / 恢复时回调（写状态用） */
  onRefused?: (r: Refused | null) => void
}

/** 被拒的 CONNACK：mqtt.js 抛 ErrorWithReasonCode('Connection refused: …', code) */
export function refusedOf(e: Error & { code?: unknown }): { code: number; reason: string } | null {
  if (typeof e.code !== 'number' || !/^Connection refused/i.test(e.message)) return null
  return { code: e.code, reason: e.message.replace(/^Connection refused:\s*/i, '') || `code ${e.code}` }
}

/** 给 mqtt.connect 的选项补上被拒后照样重连 */
export function mqttKeepOptions<T extends Record<string, unknown>>(o: T): T & { reconnectOnConnackError: true } {
  return { ...o, reconnectOnConnackError: true }
}

export class MqttKeeper<C extends KeepClient> {
  client: C | null = null
  refused: Refused | null = null
  /** 兜底换过几次客户端（自检、排障用） */
  replaced = 0
  private stopped = true
  private tries = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly minMs: number
  private readonly maxMs: number

  constructor(private readonly o: KeepOptions<C>) {
    this.minMs = o.minMs ?? 5000
    this.maxMs = o.maxMs ?? 60_000
  }

  get connected(): boolean {
    return !!this.client?.connected
  }

  start(): C {
    this.stopped = false
    return this.spawn()
  }

  /** 主动停（不再重连） */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const c = this.client
    this.client = null
    if (c) {
      c.options.reconnectPeriod = 0
      c.end(true)
    }
  }

  /** 当前退避间隔 */
  backoffMs(): number {
    return Math.min(this.minMs * 2 ** this.tries, this.maxMs)
  }

  private spawn(): C {
    const c = this.o.create()
    this.client = c
    c.on('connect', () => {
      if (this.client !== c) return
      this.tries = 0
      c.options.reconnectPeriod = this.minMs
      if (this.refused) {
        this.o.log?.('log', `连上了（之前连续被拒 ${this.refused.count} 次：${this.refused.reason}）`)
        this.refused = null
        this.o.onRefused?.(null)
      }
    })
    c.on('error', e => {
      if (this.client !== c) return
      const r = refusedOf(e)
      if (!r) return
      const now = Date.now()
      this.refused = this.refused && this.refused.code === r.code ? { ...this.refused, count: this.refused.count + 1 } : { ...r, since: now, count: 1 }
      // mqtt.js 在这个 error 之后才按 options.reconnectPeriod 排重连：改它就是给 mqtt.js 自己的重连加退避
      c.options.reconnectPeriod = this.backoffMs()
      this.tries++
      // 第一次、以及退避到顶后每次都记（顶上是每 60 s 一次，不刷屏）
      if (this.refused.count === 1 || c.options.reconnectPeriod >= this.maxMs) {
        this.o.log?.('warn', `连接被拒（CONNACK ${r.code} ${r.reason}，连续 ${this.refused.count} 次），${Math.round(c.options.reconnectPeriod / 1000)} s 后重试`)
      }
      this.o.onRefused?.(this.refused)
    })
    c.on('close', () => setTimeout(() => this.afterClose(c), 0))
    this.o.wire?.(c)
    return c
  }

  /** 兜底：断了而 mqtt.js 没在重连（没排 reconnectTimer）—— 关掉它，退避后换个新客户端 */
  private afterClose(c: C): void {
    if (this.stopped || this.client !== c || c.connected || c.disconnecting) return
    if ((c as unknown as { reconnectTimer?: unknown }).reconnectTimer) return
    if (this.timer) return
    const wait = this.backoffMs()
    this.tries++
    this.o.log?.('warn', `连接断了、mqtt.js 没在重连${this.refused ? `（上次被拒：CONNACK ${this.refused.code} ${this.refused.reason}）` : ''}：${Math.round(wait / 1000)} s 后换个客户端重连`)
    c.options.reconnectPeriod = 0
    c.end(true)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped || this.client !== c) return
      this.replaced++
      this.spawn()
    }, wait)
  }
}
