/* 派生量：同事的程序只发传感器原本就有的量，下面这些由 agent 算好发回总线（开发计划 §6.1）。
 *
 *   el.load_pct = max(Ia, Ib, Ic) ÷ 额定电流 × 100（接入规范 §6.2）
 *     过载告警在 EG 本地 TB 上统一按 110 % 判 —— TB 设备配置的告警规则读不到设备属性，额定电流各柜不同，只能 EG 先除好。
 *     额定电流取电表的 `rated` 属性（eg.yaml，子站 model.yaml 来的），没有就用柜的额定电流。
 *     时间戳与电流读数相同，这样子站上负荷率与电流在同一时刻。
 *
 * 另做一项检查：el.Ep（累计电能）必须单调不减（子站按日差分算日电量）。倒退了（电表清零 / 更换）照样上送，
 * 只记警告日志 —— 要在子站维护记录里登记，否则那天的日电量是负的。 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService, type Entry } from '../bus/bus.service.js'

const PHASES = ['el.Ia', 'el.Ib', 'el.Ic'] as const

@Injectable()
export class DeriveService implements OnModuleInit {
  /** 电表名 → 额定电流 A */
  private readonly rated = new Map<string, number>()
  private readonly log = new Logger('派生量')
  /** 电表名 → 上一个 el.Ep（设备时间戳与值） */
  private readonly lastEp = new Map<string, { ts: number; v: number }>()
  /** 电表名 → el.Ep 倒退的次数（状态接口显示） */
  readonly epBackwards = new Map<string, number>()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
  ) {
    for (const d of cfg.devices) {
      if (d.kind !== 'meter') continue
      const r = Number(d.attrs['rated'] ?? cfg.cabinet.rated)
      if (Number.isFinite(r) && r > 0) this.rated.set(d.name, r)
    }
  }

  onModuleInit(): void {
    this.bus.onTelemetry((dev, entries, own) => {
      if (own || !this.rated.has(dev)) return
      this.loadPct(dev, entries)
      this.checkEp(dev, entries)
    })
  }

  /** 额定电流（本地页显示用） */
  ratedOf(device: string): number | null {
    return this.rated.get(device) ?? null
  }

  private checkEp(dev: string, entries: Entry[]): void {
    for (const e of entries) {
      const v = num(e.values['el.Ep'])
      if (v === null) continue
      const last = this.lastEp.get(dev)
      // 补发的旧数据（时间戳更早）不比
      if (last && e.ts <= last.ts) continue
      if (last && v < last.v - 1e-6) {
        this.epBackwards.set(dev, (this.epBackwards.get(dev) ?? 0) + 1)
        this.log.warn(`${dev} 的 el.Ep 倒退：${last.v} → ${v} kWh（电表清零或更换？要在子站维护记录里登记）`)
      }
      this.lastEp.set(dev, { ts: e.ts, v })
    }
  }

  private loadPct(dev: string, entries: Entry[]): void {
    const rated = this.rated.get(dev)!
    const live = this.bus.live.get(dev)?.telemetry ?? {}
    for (const e of entries) {
      if (!PHASES.some(k => k in e.values)) continue
      // 这一条里没带的相，用同一时刻（或更早）的最新值
      const amps = PHASES.map(k => num(e.values[k] ?? (live[k] && live[k].ts <= e.ts ? live[k].v : undefined)))
      if (amps.some(a => a === null)) continue
      const pct = Math.round((Math.max(...(amps as number[])) / rated) * 1000) / 10
      this.bus.publish(dev, { 'el.load_pct': pct }, e.ts)
    }
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
