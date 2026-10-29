/* 弧光事件量 uv.arc（0.8.3 / 子站 0.19.3，用户 10-29 定；口径在后端 @lsa/model arc-event.ts 的 ArcDeriver，这里只接线）。
 *
 * 本地「弧光异常」（EG-arc）只看 uv.arc > 0：TB 设备配置规则对条件里的 key 留最新值快照，uv.pulse 发过一次就一直「在」，
 * 恢复后下一条遥测会再触发，所以要一个会回零的量。
 *   - 输入：转换程序发来的、**去重后**的遥测（BusService 已按同设备同 ts 去掉重复的 uv.pulse —— 本地 TB 直接从总线收的那份还会重，
 *     但规则只看这里派生的 uv.arc，0.17 记的「本地偶发多一条弧光异常」随之没了）。只看 SAM。
 *   - 输出：经本机总线发回（与 dev.link 同一路进本地 TB），ts 用触发那条的 ts；补 0 的 ts 用当时。**不上送子站**（UplinkService 去掉）。
 *   - 兜底：本柜 arcEvents 能力不是 confirmed（待定 / 不支持）时，uv.int 从阈值下跨到阈值上的那一个样本出一次；
 *     阈值取已生效阈值表 arc 这一行、本柜柜型那一列（ApplyService 应用时交给这里）。没下发过能力清单 = 当 confirmed，不开兜底。
 *   - 持续 > 1 s 的事件不算电弧：不出 uv.arc，只记日志（同一台每分钟最多一条）。
 *   - 回 0 以后每 5 s 再写一次 0、写 70 s（沙箱实测，真本地 TB 4.2.2.6）：TB 只在消息里带了规则自己的 key 时才重判清除条件，
 *     不带的（uv.int 等）不推它，只等 TB 自己的定时检查 —— 只写一次 0 时「≤ 0 连续 60 s」要 60–120 s 才恢复（测到 107 s）；
 *     重复写 0 后 65 s 恢复，与 0.19.2 按强度判时「60 s 无新放电恢复」一致。 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { ARC_KEY, ArcDeriver } from '@lsa/model'
import type { ThresholdRow } from '@lsa/model'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'
import { CapsService } from '../caps/caps.service.js'

/** 定时检查「出过 uv.arc、一直没有后续 uv.int」要不要补 0 的间隔；回 0 以后重复写 0 也按它 */
const TICK_MS = 5000
/** 回 0 以后重复写 0 写多久（规则「uv.arc ≤ 0 连续 60 s」恢复，多留 10 s） */
const ZERO_HOLD_MS = 70_000

@Injectable()
export class ArcService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('弧光事件')
  /** SAM 名 → 派生器 */
  private readonly sams = new Map<string, ArcDeriver>()
  private threshold = Number.POSITIVE_INFINITY
  private timer: NodeJS.Timeout | null = null
  /** SAM 名 → 回 0 以后重复写 0 写到什么时候 */
  private readonly zeroUntil = new Map<string, number>()
  /** SAM 名 → 上次记「长事件」日志的时刻 */
  private readonly longLogged = new Map<string, number>()
  /** 自启动起：出了几次 uv.arc（> 0）、几次长事件没出（状态接口 / 自检看） */
  readonly counts = { arc: 0, edge: 0, long: 0 }

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly caps: CapsService,
  ) {
    for (const d of cfg.devices) {
      if (d.kind !== 'sam') continue
      this.sams.set(d.name, new ArcDeriver({ threshold: this.threshold, edgeFallback: false, onLong: (peak, ms) => this.onLong(d.name, peak, ms) }))
    }
  }

  onModuleInit(): void {
    this.refresh()
    this.caps.onChange(() => this.refresh())
    this.bus.onTelemetry((dev, entries, own) => {
      if (own) return
      const der = this.sams.get(dev)
      if (!der) return
      for (const e of entries) {
        const edge = this.edgeOn && !('uv.pulse' in e.values)
        const v = der.on(e.values, e.ts)
        if (v === null) continue
        if (v > 0) {
          this.counts.arc++
          if (edge) this.counts.edge++
          this.log.log(`${dev} ${edge ? `弧光强度跨过阈值 ${this.threshold} %（本柜弧光事件能力未确认，按上升沿兜底）` : '弧光事件'}：uv.arc = ${v}（ts ${e.ts}）`)
          this.zeroUntil.delete(dev)
        } else this.zeroUntil.set(dev, Date.now() + ZERO_HOLD_MS)
        this.bus.publish(dev, { [ARC_KEY]: v }, e.ts)
      }
    })
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS)
    this.timer.unref?.()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** ApplyService 应用配置后（含启动时读 applied-config.json）调：阈值表里 arc 这一行、本柜柜型那一列 */
  setThresholds(rows: ThresholdRow[] | null | undefined): void {
    const v = rows?.find(r => r.key === 'arc')?.[this.cfg.cabinet.group]
    this.threshold = typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
    this.refresh()
  }

  /** 兜底开着没有（本柜 arcEvents 下发了、而且不是 confirmed） */
  get edgeOn(): boolean {
    const s = this.caps.config?.caps['arcEvents']
    return s !== undefined && s !== 'confirmed'
  }

  get arcThreshold(): number | null {
    return Number.isFinite(this.threshold) ? this.threshold : null
  }

  /** 定时：出过 uv.arc、60 s 内没有新的 uv.int 的补 0；回 0 以后 ZERO_HOLD_MS 内重复写 0（推本地 TB 判恢复） */
  tick(now: number): void {
    for (const [dev, der] of this.sams) {
      const v = der.tick(now)
      if (v !== null) {
        this.bus.publish(dev, { [ARC_KEY]: v }, now)
        this.zeroUntil.set(dev, now + ZERO_HOLD_MS)
        continue
      }
      const until = this.zeroUntil.get(dev)
      if (until === undefined) continue
      if (now >= until) this.zeroUntil.delete(dev)
      else this.bus.publish(dev, { [ARC_KEY]: 0 }, now)
    }
  }

  private refresh(): void {
    const edgeFallback = this.edgeOn
    for (const der of this.sams.values()) der.set({ threshold: this.threshold, edgeFallback })
  }

  private onLong(dev: string, peak: number, ms: number): void {
    this.counts.long++
    const now = Date.now()
    if (now - (this.longLogged.get(dev) ?? 0) < 60_000) return
    this.longLogged.set(dev, now)
    this.log.warn(`${dev} 弧光事件持续 ${ms} ms（峰值 ${peak}）超过 1 s，不算电弧、不出「弧光异常」（长时间受光由「弧光传感器受光异常」管）`)
  }
}
