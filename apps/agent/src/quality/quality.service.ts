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
 * q 变化时立即发，另外每分钟重发一次（恢复后发 "{}"，子站据此清掉标记）。 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { periodMs, pointsOf } from '@lsa/points'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService, type Entry } from '../bus/bus.service.js'

export type Quality = 'stale' | 'invalid'

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
  publishedAt: number
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
  ) {
    for (const d of cfg.devices) {
      if (d.kind === 'eg') continue
      const keys = new Map<string, Watch>()
      for (const p of pointsOf(d.kind, cfg.cabinet.group, true)) {
        const ms = periodMs(p.period)
        // 事件型（弧光脉冲）不按周期看护；派生量跟随输入，不单独看护
        if (ms === null || p.key in DERIVED) continue
        keys.set(p.key, { period: ms, optional: !!p.optional, lastAt: this.startedAt, seen: false })
      }
      this.devices.set(d.name, { keys, fromSource: {}, derived: {}, published: null, link: null, publishedAt: 0 })
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
    const out: Record<string, string> = { ...d.fromSource, ...d.derived }
    for (const [key, w] of d.keys) {
      const q = judge(w, now)
      if (q) out[key] = q
    }
    for (const [derived, inputs] of Object.entries(DERIVED)) {
      if (!d.keys.has(inputs[0]!)) continue
      const worst = inputs.map(k => out[k]).find(q => q === 'invalid') ?? inputs.map(k => out[k]).find(Boolean)
      if (worst) out[derived] = worst
    }
    return out
  }

  /** 整台失效的设备（必有量全部 invalid） */
  deadDevices(now = Date.now()): string[] {
    const out: string[] = []
    for (const [name, d] of this.devices) if (isDead(d, now)) out.push(name)
    return out
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
      const link = isDead(d, now) ? 0 : 1
      if (q === d.published && link === d.link && now - d.publishedAt < REPUBLISH_MS) continue
      if (link !== d.link && d.link !== null) this.log.log(`${name} ${link ? '恢复在线' : '整台失效（dev.link = 0）'}`)
      if (q !== d.published) {
        const n = Object.keys(JSON.parse(q)).length
        if (d.published !== null || n) this.log.log(`${name} 质量码 ${n ? q : '全部有效'}`)
      }
      this.bus.publish(name, { q, 'dev.link': link }, now)
      d.published = q
      d.link = link
      d.publishedAt = now
    }
  }
}

/** 整台失效：必有量全部 invalid */
function isDead(d: DeviceWatch, now: number): boolean {
  const must = [...d.keys.values()].filter(w => !w.optional)
  return must.length > 0 && must.every(w => judge(w, now) === 'invalid')
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
