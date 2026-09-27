/* 派生量：同事的程序只发传感器原本就有的量，下面这些由 agent 算好发回总线（开发计划 §6.1）。
 *
 *   el.load_pct = max(Ia, Ib, Ic) ÷ 额定电流 × 100（接入规范 §6.2）
 *     过载告警在 EG 本地 TB 上统一按 110 % 判 —— TB 设备配置的告警规则读不到设备属性，额定电流各柜不同，只能 EG 先除好。
 *     额定电流取电表的 `rated` 属性（eg.yaml，子站 model.yaml 来的），没有就用柜的额定电流。
 *     时间戳与电流读数相同，这样子站上负荷率与电流在同一时刻。
 *
 * 另做一项检查：el.Ep（累计电能）必须单调不减（子站按日差分算日电量）。倒退了（电表清零 / 更换）照样上送，
 * 只记警告日志 —— 要在子站维护记录里登记，否则那天的日电量是负的。
 *
 * 摄像机区域测温（G4 摄像机测温约定 §3、§5，设备 CAM-<柜号>）：
 *   ir.R<n>.rise = ir.R<n>.max − env.t（本柜柜内空气温度：CAM 属性 regions.R<n>.env 指定的设备，缺省本柜第一台 SAM）；
 *     两个输入都有效、源时间差 ≤ 容差（local.yaml camera.riseToleranceS，缺省 15 s）才出值，时间戳取 max 的；允许负值；
 *     出不来时在 CAM 的质量码里标 ir.R<n>.rise（env.t 缺 / 失效跟随它，时间差超容差标 stale）。
 *   ir.dmax = 各区域 ir.R<n>.max 的极差（「区域温差」告警的输入 —— TB 规则只能比常量）。 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService, type Entry } from '../bus/bus.service.js'
import { QualityService } from '../quality/quality.service.js'

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
  /** 摄像机名 → 区域号 → 取 env.t 的设备 */
  private readonly envOf = new Map<string, Map<number, string>>()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly quality: QualityService,
  ) {
    const firstSam = cfg.devices.find(d => d.kind === 'sam')?.name
    for (const d of cfg.devices) {
      if (d.kind !== 'camera') continue
      const regions = (d.attrs['regions'] ?? {}) as Record<string, { env?: string } | undefined>
      const m = new Map<number, string>()
      for (const n of [1, 2, 3]) {
        const env = regions[`R${n}`]?.env ?? firstSam
        if (env) m.set(n, env)
      }
      this.envOf.set(d.name, m)
    }
    for (const d of cfg.devices) {
      if (d.kind !== 'meter') continue
      const r = Number(d.attrs['rated'] ?? cfg.cabinet.rated)
      if (Number.isFinite(r) && r > 0) this.rated.set(d.name, r)
    }
  }

  onModuleInit(): void {
    this.bus.onTelemetry((dev, entries, own) => {
      if (!own && this.envOf.has(dev)) return this.camRise(dev, entries)
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

  private camRise(dev: string, entries: Entry[]): void {
    const envMap = this.envOf.get(dev)!
    const tol = this.cfg.local.camera.riseToleranceS * 1000
    for (const e of entries) {
      const maxes = [1, 2, 3].map(n => ({ n, v: num(e.values[`ir.R${n}.max`]) })).filter((x): x is { n: number; v: number } => x.v !== null)
      if (!maxes.length) continue
      const out: Record<string, number> = {}
      if (maxes.length >= 2) out['ir.dmax'] = round1(Math.max(...maxes.map(x => x.v)) - Math.min(...maxes.map(x => x.v)))
      for (const { n, v } of maxes) {
        const key = `ir.R${n}.rise`
        const envDev = envMap.get(n)
        const env = envDev ? this.bus.live.get(envDev)?.telemetry['env.t'] : undefined
        const envQ = envDev ? this.quality.qualityOf(envDev)['env.t'] : undefined
        const envV = env ? num(env.v) : null
        if (!env || envV === null) this.quality.setDerived(dev, key, 'invalid')
        else if (envQ === 'stale' || envQ === 'invalid') this.quality.setDerived(dev, key, envQ)
        else if (Math.abs(e.ts - env.ts) > tol) this.quality.setDerived(dev, key, 'stale')
        else {
          out[key] = round1(v - envV)
          this.quality.setDerived(dev, key, null)
        }
      }
      if (Object.keys(out).length) this.bus.publish(dev, out, e.ts)
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

const round1 = (v: number) => Math.round(v * 10) / 10

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
