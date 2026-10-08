/* caps.actual（阶段 A，接口 v1.1）：EG 实际具备哪些能力，只用于子站提示「配置与实际不一致」。
 *   EG-<柜号> 的属性 caps.actual = JSON 串 { "<能力>": "ok" | "nodata" | "absent" }，按下发的 capKeys 判：
 *     ok      eg.yaml 里配了该设备，且窗口内有有效值（不在 q 里）
 *     nodata  配了，但窗口内没有有效值
 *     absent  eg.yaml 里没有对应设备
 *   窗口 = max(10 min, 3 × 该 key 的周期)（点表目录的周期；目录里没有的按 10 min）。
 *   通配（"PM6:*"、"el.*"）不算 q 与 dev.*（那是 agent 自己发的，传感器坏了也照样有）。
 *   每 30 s 判一次：变了马上报，连上本机总线 / 子站时报，另外每小时重报一次。子站没下发能力就不报。 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { periodMs, pointsOf } from '@lsa/points'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'
import { QualityService } from '../quality/quality.service.js'
import { UplinkService } from '../uplink/uplink.service.js'
import { capsActual, keyMatch, type CapActual } from './caps.js'
import { CapsService } from './caps.service.js'

const EVAL_MS = 30_000
const REPORT_MS = 3_600_000
const MIN_WINDOW_MS = 600_000

@Injectable()
export class CapsActualService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null
  private last: string | null = null
  private lastAt = 0
  /** 设备 → key → 周期（ms） */
  private readonly periods = new Map<string, Map<string, number>>()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly caps: CapsService,
    private readonly bus: BusService,
    private readonly quality: QualityService,
    private readonly uplink: UplinkService,
  ) {
    for (const d of cfg.devices) {
      if (d.kind === 'eg') continue
      const m = new Map<string, number>()
      for (const p of pointsOf(d.kind, cfg.cabinet.group, true)) {
        const ms = periodMs(p.period)
        if (ms !== null) m.set(p.key, ms)
      }
      this.periods.set(d.name, m)
    }
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), EVAL_MS)
    this.bus.onConnect(() => this.tick(true))
    this.uplink.whenUp(() => this.tick(true))
    this.caps.onChange(() => this.tick(true))
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** 当前的判定（本地页、状态接口用）；子站没下发能力为 null */
  actual(now = Date.now()): Record<string, CapActual> | null {
    const c = this.caps.config
    if (!c) return null
    const devices = this.cfg.devices.filter(d => d.kind !== 'eg').map(d => d.name)
    return capsActual(c, devices, (device, pattern) => this.hasValid(device, pattern, now))
  }

  private hasValid(device: string, pattern: string, now: number): boolean {
    const tel = this.bus.live.get(device)?.telemetry
    if (!tel) return false
    const q = this.quality.qualityOf(device, now)
    const periods = this.periods.get(device)
    const wild = pattern.includes('*')
    for (const [k, l] of Object.entries(tel)) {
      if (!keyMatch(pattern, k)) continue
      if (wild && (k === 'q' || k.startsWith('dev.'))) continue
      if (q[k]) continue
      const win = Math.max(MIN_WINDOW_MS, 3 * (periods?.get(k) ?? 0))
      if (now - l.at <= win) return true
    }
    return false
  }

  private tick(force = false): void {
    const a = this.actual()
    if (!a) return
    const s = JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))))
    const now = Date.now()
    if (!force && s === this.last && now - this.lastAt < REPORT_MS) return
    this.bus.publishAttributes(this.cfg.eg.name, { 'caps.actual': s })
    this.last = s
    this.lastAt = now
  }
}
