/* 传感器预热的判定逻辑（0.17，docs/气体传感器预热方案.md v2）。纯逻辑、时间由调用方给，WarmupService 管状态与持久化，自检直接测这里。
 *
 * 「刚通电」的判据（按设备，任意一条成立就进预热；已在预热的从这一刻重新计时；预热从触发后第一次读到数起算 warmupS 秒）：
 *   T1 传感器自己报（转换程序发 q:"warmup"）—— 等 T08 型号；这里只认「转换程序标了 warmup」时 dev.warmup_s 至少报 1（QualityService 合并）
 *   T2 读数连续中断 ≥ gapS 后恢复（缺省 60 s；RS485 偶发读不到十几秒不算断电）
 *   T3 EG 主机刚开机（开机时长 < warmupS 或 hostBootId 变了）—— 前提是传感器与 EG 同一路电，按柜可关（bootOffCabs）
 * 只是 agent 重启（主机没重启）不算。
 *
 * 参数随子站下发配置的 extras 走（gasWarmupS / gasGapS / gasBootWarmupOffCabs，与后端 @lsa/model ThresholdExtras 同名）：
 * 都没带 = 缺省值且不计进配置哈希（老配置哈希不变）。 */

export interface GasParams {
  /** 预热时长 s，0 = 不做预热处理 */
  warmupS: number
  /** T2：读数连续中断多久算断过电，s */
  gapS: number
  /** T3 不适用的柜（传感器与 EG 不同一路电） */
  bootOffCabs: string[]
}
export const DEFAULT_GAS: GasParams = { warmupS: 180, gapS: 60, bootOffCabs: [] }
export const GAS_RANGE = { warmupS: [0, 900], gapS: [30, 600] } as const

/** 需要预热的设备种类：T08 定了气体 / 烟雾的 kind 后加进来（缺省就要预热）；现在只认 eg.yaml 设备属性 */
export const WARMUP_KINDS = new Set<string>([])

/** 这台设备要不要做预热处理：种类在 WARMUP_KINDS 里，或 eg.yaml 设备属性 warmup: true / warmupS 是数（按设备覆盖时长；0 = 这台不做） */
export function warmupDevice(d: { kind: string; attrs: Record<string, unknown> }): boolean {
  const s = d.attrs['warmupS']
  if (typeof s === 'number') return s > 0
  return d.attrs['warmup'] === true || WARMUP_KINDS.has(d.kind)
}

/** 一台需要预热的设备里，哪些量归预热管（0.7.1）：SAM 是一组传感器（局放 / 弧光 / 温湿度 / 气体），只有气体那路要预热 ——
 *  只有 smoke.* 的读数驱动预热计时（T2 读数中断看的是它）、预热中只给 smoke.* 标 warmup，局放、温湿度这些照常可信。
 *  其余种类（老配置里的 PM6 等）整台都归预热管 */
export function warmupScope(kind: string): (key: string) => boolean {
  return kind === 'sam' ? k => k.startsWith('smoke.') : () => true
}

/** 按设备覆盖的预热时长（eg.yaml attrs.warmupS，限在 0–900）；没写用站级参数 */
export function deviceWarmupS(attrs: Record<string, unknown>, p: GasParams): number {
  const s = attrs['warmupS']
  return typeof s === 'number' && Number.isFinite(s) ? Math.min(Math.max(Math.round(s), GAS_RANGE.warmupS[0]), GAS_RANGE.warmupS[1]) : p.warmupS
}

/** 子站下发的 extras 里取预热参数；一个都没带返回 null（用缺省、不计哈希）。不合法抛 Error（ApplyService 转 BAD_REQUEST） */
export function parseGas(extras: Record<string, unknown>): GasParams | null {
  const has = (k: string) => extras[k] !== undefined
  if (!has('gasWarmupS') && !has('gasGapS') && !has('gasBootWarmupOffCabs')) return null
  const int = (k: 'warmupS' | 'gapS', field: string): number => {
    const v = extras[field]
    if (v === undefined) return DEFAULT_GAS[k]
    const [lo, hi] = GAS_RANGE[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`extras.${field} 要是 ${lo}–${hi} 的整数（秒）`)
    return v
  }
  const off = extras['gasBootWarmupOffCabs'] ?? []
  if (!Array.isArray(off) || !off.every(x => typeof x === 'string' && x.length > 0 && x.length <= 32)) throw new Error('extras.gasBootWarmupOffCabs 要是柜号数组')
  return { warmupS: int('warmupS', 'gasWarmupS'), gapS: int('gapS', 'gasGapS'), bootOffCabs: [...new Set(off as string[])].sort() }
}

export type WarmupReason = 'T2' | 'T3'

/** 一台设备的预热计时 */
export class WarmupTracker {
  /** 最近一次读到测量值的时刻（agent 收到）；这次启动还没读到过为 null */
  lastReadAt: number | null = null
  /** 预热结束时刻；不在预热为 null */
  until: number | null = null
  reason: WarmupReason | null = null
  /** T3 已武装：主机刚开机，下一次读到数时开始预热 */
  bootArmed = false

  /** 读到一次测量值。返回这次触发的原因（没触发返回 null） */
  read(now: number, warmupS: number, gapS: number): WarmupReason | null {
    let why: WarmupReason | null = null
    if (this.bootArmed) {
      this.bootArmed = false
      why = 'T3'
    } else if (this.lastReadAt !== null && now - this.lastReadAt >= gapS * 1000) why = 'T2'
    this.lastReadAt = now
    if (why && warmupS > 0) {
      this.until = now + warmupS * 1000
      this.reason = why
      return why
    }
    return null
  }

  /** 还没开始计时、但读数一回来就要预热（T3 已武装，或读数已中断 ≥ gapS） */
  waiting(now: number, gapS: number): boolean {
    return this.bootArmed || (this.lastReadAt !== null && now - this.lastReadAt >= gapS * 1000)
  }

  /** 剩余预热秒数（0 = 就绪）；到点自动清状态。
   *  T3 已武装、或读数已中断 ≥ gapS（回来就要预热）时提前报满额：读数与 dev.warmup_s 走两条路到 TB，
   *  不提前报的话读数恢复的那一刻 TB 可能先拿 dev.warmup_s = 0 判一次，不带持续时间的正式规则就会误出（竞态） */
  remaining(now: number, warmupS: number, gapS: number): number {
    if (warmupS <= 0) return 0
    if (this.waiting(now, gapS)) return warmupS
    if (this.until === null) return 0
    if (now >= this.until) {
      this.until = null
      this.reason = null
      return 0
    }
    return Math.ceil((this.until - now) / 1000)
  }
}

/** T3：这次启动算不算「主机刚开机」。hostBootId 读不到（开发机 Windows）只看开机时长 */
export function bootTrigger(o: { uptimeS: number; warmupS: number; hostBootId: string | null; lastHostBootId: string | null }): boolean {
  if (o.warmupS <= 0) return false
  if (o.uptimeS < o.warmupS) return true
  return !!o.hostBootId && !!o.lastHostBootId && o.hostBootId !== o.lastHostBootId
}
