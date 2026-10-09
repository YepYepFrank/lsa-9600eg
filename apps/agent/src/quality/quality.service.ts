/* 质量码看护（接入规范 §6.7，开发计划 §6.1）。
 *
 * 同事的转换程序只管发读数；某个量没按周期来，由这里标出来，写进该设备的遥测 key `q`（字符串化 JSON，只列非有效的量）：
 *   超过 3 个周期没来            → stale（陈旧）
 *   超过 max(30 s, 5 个周期)没来 → invalid（无效）
 * 周期取点表目录（@lsa/points 的 catalog = 规范 §6）。按 agent 收到的时刻判，不按设备时间戳（设备时钟可能偏）。
 *
 * 同事若自己也发了 q（他知道哪个传感器坏了），与看护的结果合并后再发 —— 否则两边的 q 互相覆盖。
 * 一台设备的必有量全部 invalid = 整台失效，EG 状态降级（eg.state=degraded，由 SelfService 发）；
 * 同一判据另发 dev.link（1 在线 / 0 失联，与 q 同发、每分钟重发）—— EG 本地 TB 按它出「设备失联」告警（§8 dev.link）。
 * 派生量（el.load_pct）跟随它的输入：三相电流有一相不有效，负荷率同样标。
 *
 * q 变化时立即发，另外每分钟重发一次（恢复后发 "{}"，子站据此清掉标记）。
 *
 * 阶段 A（接口 v1.1，V3.0 §13）：
 *   - q 另有转换程序给的 warmup / calibrating（透传、合并），合并优先级 invalid > calibrating / warmup > stale（同一个 key 取高的）
 *   - 每台下挂设备另发 dev.comm：ONLINE / DEGRADED（有数据但 q 里有非正常项）/ OFFLINE / UNKNOWN（agent 刚起、≤ 30 s）
 *     dev.last_ok：转换程序报了用它的，否则按 agent 收到测量值的时刻；dev.last_try / dev.err / dev.fails 转换程序报了原样转发
 *     （它们本来就随它的遥测走），没报时 EG 兜底：fails = 错过的周期数 floor(距 last_ok / 周期) - 1（正常到达的抖动不算失败），err 在 fails > 0 时为 TIMEOUT、恢复清空，last_try 不发
 *   - 离线判据：fails ≥ failN 且距 last_ok > max(minMs, periods × 周期)（参数随配置下发 devComm，缺省 5 / 30000 / 5）；
 *     dev.link 保留 = dev.comm != OFFLINE（本地「设备失联」规则照旧按它判）
 *   - 能力全都不启用的设备（caps）不发 dev.*（上送那边也整台不送）
 *   - q / dev.comm / dev.link 变了立即发，dev.last_ok / fails / err 随每分钟那一次 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { expectedPeriodMs, pointsOf } from '@lsa/points'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService, type Entry } from '../bus/bus.service.js'
import { CapsService } from '../caps/caps.service.js'

export type Quality = 'stale' | 'invalid'
export type Comm = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN'

/** 同一个 key 几个来源都标了时取高的：invalid > calibrating / warmup（及转换程序的其它值）> stale */
const RANK: Record<string, number> = { invalid: 3, stale: 1 }
const rank = (q: string | undefined) => (q ? (RANK[q] ?? 2) : 0)
/** agent 刚起、某台设备还一条都没收到时报 UNKNOWN 的最长时间 */
const UNKNOWN_MS = 30_000

interface Watch {
  period: number
  optional: boolean
  /** agent 最近一次收到的时刻；从没收到过则为 agent 启动时刻（启动后留出等第一批数据的时间） */
  lastAt: number
  seen: boolean
}

interface DeviceWatch {
  keys: Map<string, Watch>
  /** 同事自己发的 q */
  fromSource: Record<string, string>
  /** agent 自己算的派生量标的（跨设备的输入：区域温升要看 SAM 的 env.t，DeriveService 标） */
  derived: Record<string, string>
  /** 上一次发出去的 q（JSON） */
  published: string | null
  /** 上一次发出去的 dev.link */
  link: 0 | 1 | null
  /** 上一次发出去的 dev.comm */
  comm: Comm | null
  publishedAt: number
  /** 判离线用的周期：必有量里最快的（没有必有量取全部里最快的） */
  period: number
}

/** 派生量 → 它的输入 */
const DERIVED: Record<string, string[]> = {
  'el.load_pct': ['el.Ia', 'el.Ib', 'el.Ic'],
  // 摄像机区域测温（G4 摄像机测温约定 §3、§5）：温升还依赖 env.t（跨设备，由 DeriveService 另标），这里只跟随本设备的输入
  'ir.R1.rise': ['ir.R1.max'],
  'ir.R2.rise': ['ir.R2.max'],
  'ir.R3.rise': ['ir.R3.max'],
  'ir.dmax': ['ir.R1.max', 'ir.R2.max', 'ir.R3.max'],
  // §8.6 补充的汇总量（本地规则按它们判）
  'ir.rise': ['ir.R1.max', 'ir.R2.max', 'ir.R3.max'],
  'ir.rmax': ['ir.R1.max', 'ir.R2.max', 'ir.R3.max'],
  'ir.hot': ['ir.R1.max', 'ir.R2.max', 'ir.R3.max'],
}
const EVAL_MS = 2_000
const REPUBLISH_MS = 60_000

@Injectable()
export class QualityService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('质量码')
  private readonly devices = new Map<string, DeviceWatch>()
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly caps: CapsService,
  ) {
    for (const d of cfg.devices) {
      if (d.kind === 'eg') continue
      const keys = new Map<string, Watch>()
      for (const p of pointsOf(d.kind, cfg.cabinet.group, true)) {
        // I6（0.4）：按点目录的期望周期（局放 us.* / tev.* / uhf.* 是 3 s，装置 3 s 才刷新一次），没写的按 fast / slow 档
        const ms = expectedPeriodMs(p)
        // 事件型（弧光脉冲）不按周期看护；派生量跟随输入，不单独看护
        if (ms === null || p.key in DERIVED) continue
        keys.set(p.key, { period: ms, optional: !!p.optional, lastAt: this.startedAt, seen: false })
      }
      const must = [...keys.values()].filter(w => !w.optional).map(w => w.period)
      const period = Math.min(...(must.length ? must : [...keys.values()].map(w => w.period)), 60_000)
      this.devices.set(d.name, { keys, fromSource: {}, derived: {}, published: null, link: null, comm: null, publishedAt: 0, period })
    }
  }

  onModuleInit(): void {
    this.bus.onTelemetry((dev, entries, own) => this.take(dev, entries, own))
    this.timer = setInterval(() => this.evaluate(), EVAL_MS)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** DeriveService 标派生量出不来的原因（null = 恢复）；变了马上重发 q */
  setDerived(device: string, key: string, q: Quality | null): void {
    const d = this.devices.get(device)
    if (!d || (d.derived[key] ?? null) === q) return
    if (q) d.derived[key] = q
    else delete d.derived[key]
    this.evaluate(device)
  }

  /** 某设备当前的质量码（合并后），本地页与状态接口用 */
  qualityOf(device: string, now = Date.now()): Record<string, string> {
    const d = this.devices.get(device)
    if (!d) return {}
    const out: Record<string, string> = {}
    const put = (k: string, q: string) => {
      if (rank(q) > rank(out[k])) out[k] = q
    }
    for (const [k, q] of Object.entries(d.fromSource)) put(k, q)
    for (const [k, q] of Object.entries(d.derived)) put(k, q)
    for (const [key, w] of d.keys) {
      const q = judge(w, now)
      if (q) put(key, q)
    }
    for (const [derived, inputs] of Object.entries(DERIVED)) {
      if (!d.keys.has(inputs[0]!)) continue
      const worst = inputs.map(k => out[k]).find(q => q === 'invalid') ?? inputs.map(k => out[k]).find(Boolean)
      if (worst) out[derived] = worst
    }
    return out
  }

  /** 整台失效的设备（dev.comm = OFFLINE；能力不启用的不算） */
  deadDevices(now = Date.now()): string[] {
    const out: string[] = []
    for (const name of this.devices.keys()) if (this.caps.deviceEnabled(name) && this.commOf(name, now).comm === 'OFFLINE') out.push(name)
    return out
  }

  /** 某台设备的通信状态（§13）；本地页与状态接口也用 */
  commOf(device: string, now = Date.now()): { comm: Comm; lastOk: number | null; fails: number; err: string; fromSource: { lastOk: boolean; fails: boolean; err: boolean } } {
    const d = this.devices.get(device)
    if (!d) return { comm: 'UNKNOWN', lastOk: null, fails: 0, err: '', fromSource: { lastOk: false, fails: false, err: false } }
    const p = this.caps.devComm
    const tel = this.bus.live.get(device)?.telemetry ?? {}
    // 转换程序报的（不是 agent 自己发的）：窗口内来过才算数
    const fresh = Math.max(p.minMs, p.periods * d.period) * 2
    const src = (k: string) => {
      const l = tel[k]
      return l && !l.own && now - l.at <= fresh ? l.v : undefined
    }
    const sLastOk = src('dev.last_ok')
    const sFails = src('dev.fails')
    const sErr = src('dev.err')
    const seen = [...d.keys.values()].filter(w => w.seen).map(w => w.lastAt)
    const lastOk = typeof sLastOk === 'number' ? sLastOk : seen.length ? Math.max(...seen) : null
    const since = lastOk ?? this.startedAt
    const fails = typeof sFails === 'number' ? sFails : Math.max(0, Math.floor((now - since) / d.period) - 1)
    const err = typeof sErr === 'string' ? sErr : fails > 0 ? 'TIMEOUT' : ''
    let comm: Comm
    if (lastOk === null && now - this.startedAt < UNKNOWN_MS) comm = 'UNKNOWN'
    else if (fails >= p.failN && now - since > Math.max(p.minMs, p.periods * d.period)) comm = 'OFFLINE'
    else comm = Object.keys(this.qualityOf(device, now)).length ? 'DEGRADED' : 'ONLINE'
    return { comm, lastOk, fails, err, fromSource: { lastOk: sLastOk !== undefined, fails: sFails !== undefined, err: sErr !== undefined } }
  }

  private take(device: string, entries: Entry[], own: boolean): void {
    if (own) return
    const d = this.devices.get(device)
    if (!d) return
    const now = Date.now()
    let sourceQChanged = false
    for (const e of entries) {
      for (const [k, v] of Object.entries(e.values)) {
        if (k === 'q') {
          const parsed = parseQ(v)
          if (JSON.stringify(parsed) !== JSON.stringify(d.fromSource)) {
            d.fromSource = parsed
            sourceQChanged = true
          }
          continue
        }
        const w = d.keys.get(k)
        // 可选量（分区测温）与目录外的量：来过才看护
        if (!w) continue
        w.lastAt = now
        w.seen = true
      }
    }
    if (sourceQChanged) this.evaluate(device)
  }

  private evaluate(only?: string): void {
    const now = Date.now()
    for (const [name, d] of this.devices) {
      if (only && name !== only) continue
      const q = JSON.stringify(sortKeys(this.qualityOf(name, now)))
      const enabled = this.caps.deviceEnabled(name)
      const c = this.commOf(name, now)
      const link = c.comm === 'OFFLINE' ? 0 : 1
      if (q === d.published && link === d.link && c.comm === d.comm && now - d.publishedAt < REPUBLISH_MS) continue
      if (link !== d.link && d.link !== null) this.log.log(`${name} ${link ? '恢复在线' : '整台失效（dev.link = 0）'}`)
      if (c.comm !== d.comm && d.comm !== null) this.log.log(`${name} 通信状态 ${d.comm} → ${c.comm}（fails ${c.fails}${c.err ? `、${c.err}` : ''}）`)
      if (q !== d.published) {
        const n = Object.keys(JSON.parse(q)).length
        if (d.published !== null || n) this.log.log(`${name} 质量码 ${n ? q : '全部有效'}`)
      }
      const values: Record<string, unknown> = { q }
      if (enabled) {
        values['dev.link'] = link
        values['dev.comm'] = c.comm
        // 转换程序报了的不替它发（它的值随它自己的遥测已经走了）
        if (!c.fromSource.lastOk && c.lastOk !== null) values['dev.last_ok'] = c.lastOk
        if (!c.fromSource.fails) values['dev.fails'] = c.fails
        if (!c.fromSource.err) values['dev.err'] = c.err
      }
      this.bus.publish(name, values, now)
      d.published = q
      d.link = link
      d.comm = c.comm
      d.publishedAt = now
    }
  }
}

function judge(w: Watch, now: number): Quality | null {
  // 可选量没来过不算缺
  if (w.optional && !w.seen) return null
  const age = now - w.lastAt
  if (age > Math.max(30_000, 5 * w.period)) return 'invalid'
  if (age > 3 * w.period) return 'stale'
  return null
}

function parseQ(v: unknown): Record<string, string> {
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, string>
    } catch {
      /* 不是 JSON 就当没有 */
    }
    return {}
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}
