/* 电表变比（I3，协调会话 2026-10-09 定稿方案 B）：EG 上送前把 el.* 换成一次值，子站一律按一次量处理。
 *
 * 变比来源（后者覆盖前者）：
 *   1. eg.yaml 电表 attrs 的 ctRatio / ptRatio（首次部署的初值；没有就是 1）
 *   2. 子站配置体 meters: { "<柜号>": { "<电表设备名>": { "ct": 40, "pt": 100 } } }（配置体全站一份，与 caps 一样按柜号分组，
 *      EG 只看本柜那一块；ApplyService 应用时 set；随 applied-config.json 持久）
 * 换算：电压 × pt；电流 × ct；P / Q / S / Ep × pt × ct；PF、F、THD、谐波含有率不乘（需量点目录里还没有，T09 定了再加）。
 * EG 本地 TB 里存的是转换程序发的表计原值（IoT Gateway 直接写），本地页显示与负荷率按这里的变比换算；
 * 上送（outbox 入队那一刻）换成一次值 —— 补传队列里的旧数入队时已按当时变比换过，不重算。 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

export interface Ratio {
  ct: number
  pt: number
}

const VOLT = new Set(['el.Ua', 'el.Ub', 'el.Uc'])
const CURR = new Set(['el.Ia', 'el.Ib', 'el.Ic'])
const POWER = new Set(['el.P', 'el.Q', 'el.S', 'el.Ep'])

/** 这个 key 要乘的倍数（不用乘返回 1） */
export function factorOf(key: string, r: Ratio): number {
  if (VOLT.has(key)) return r.pt
  if (CURR.has(key)) return r.ct
  if (POWER.has(key)) return r.pt * r.ct
  return 1
}

/** 去掉浮点乘法的尾巴（57.66 × 100 = 5766.000000000001） */
const clean = (v: number) => Number(v.toPrecision(12))

/** 一条遥测换成一次值（不是数、或不用乘的原样） */
export function toPrimary(values: Record<string, unknown>, r: Ratio): Record<string, unknown> {
  if (r.ct === 1 && r.pt === 1) return values
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    const f = typeof v === 'number' ? factorOf(k, r) : 1
    out[k] = f === 1 ? v : clean((v as number) * f)
  }
  return out
}

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

@Injectable()
export class MetersService {
  private readonly log = new Logger('电表变比')
  private readonly base = new Map<string, Ratio>()
  private override: Record<string, Partial<Ratio>> | null = null

  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {
    for (const d of cfg.devices) {
      if (d.kind !== 'meter') continue
      this.base.set(d.name, { ct: pos(d.attrs['ctRatio']) ?? 1, pt: pos(d.attrs['ptRatio']) ?? 1 })
    }
  }

  /** 本机的电表 */
  get names(): string[] {
    return [...this.base.keys()]
  }

  /** 子站下发的 meters（null = 没下发，只用 eg.yaml 的初值） */
  set(meters: Record<string, Partial<Ratio>> | null): void {
    const before = JSON.stringify(this.effective())
    this.override = meters
    const after = JSON.stringify(this.effective())
    if (before !== after) this.log.log(`变比生效：${after}`)
  }

  ratio(device: string): Ratio {
    const b = this.base.get(device)
    if (!b) return { ct: 1, pt: 1 }
    const o = this.override?.[device]
    return { ct: o?.ct ?? b.ct, pt: o?.pt ?? b.pt }
  }

  /** 各电表实际生效的变比（回执回显、状态接口用） */
  effective(): Record<string, Ratio> {
    return Object.fromEntries(this.names.map(n => [n, this.ratio(n)]))
  }

  toPrimary(device: string, values: Record<string, unknown>): Record<string, unknown> {
    return this.base.has(device) ? toPrimary(values, this.ratio(device)) : values
  }
}

/** 校验配置体里的 meters（ApplyService 用）：按柜号分组，只看本柜那一块（别的柜的条目不管）；
 *  本柜块里的表名必须是本机电表，ct / pt 要是正数；出错抛 Error（调用方转 BAD_REQUEST）。没带 meters 或没有本柜块返回 null（用 eg.yaml 初值） */
export function parseMeters(raw: unknown, cabinet: string, meters: string[]): Record<string, Partial<Ratio>> | null {
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('meters 要是对象 { "<柜号>": { "<电表设备名>": { "ct": 正数, "pt": 正数 } } }')
  const mine = (raw as Record<string, unknown>)[cabinet]
  if (mine === undefined) return null
  if (!mine || typeof mine !== 'object' || Array.isArray(mine)) throw new Error(`meters.${cabinet} 要是对象 { "<电表设备名>": { ct, pt } }`)
  const out: Record<string, Partial<Ratio>> = {}
  for (const [name, v] of Object.entries(mine as Record<string, unknown>)) {
    if (!meters.includes(name)) throw new Error(`meters.${cabinet}.${name}：本机 eg.yaml 里没有这台电表（本机电表：${meters.join('、') || '无'}）`)
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`meters.${cabinet}.${name} 要是 { ct, pt }`)
    const r: Partial<Ratio> = {}
    for (const k of ['ct', 'pt'] as const) {
      const x = (v as Record<string, unknown>)[k]
      if (x === undefined) continue
      if (pos(x) === null) throw new Error(`meters.${cabinet}.${name}.${k} 要是正数`)
      r[k] = x as number
    }
    out[name] = r
  }
  return out
}
