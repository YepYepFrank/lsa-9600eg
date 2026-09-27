/* 录波的环形缓冲（G5，docs/G5证据约定.md §2）：本机总线上各设备的数值型遥测按源时间留最近一段，
 * 触发后到了后窗再按 [触发 − 前窗, 触发 + 后窗] 取出来。采样如实记（同事那边 2 s 一个就是 0.5 Hz），带时间戳。 */
import type { Entry } from '../bus/bus.service.js'

export interface Wave {
  trigger: number
  pre: number
  post: number
  /** 各序列采样间隔中位数折算的频率（Hz） */
  rateHz: number | null
  /** "<设备>/<key>" → [[ts, v], …] */
  series: Record<string, [number, number][]>
}

export class WaveBuffer {
  private readonly ring = new Map<string, { ts: number; values: Record<string, unknown> }[]>()

  constructor(private readonly keepMs: () => number) {}

  take(dev: string, entries: Entry[]): void {
    let list = this.ring.get(dev)
    if (!list) this.ring.set(dev, (list = []))
    for (const e of entries) list.push({ ts: e.ts, values: e.values })
    const cut = Date.now() - this.keepMs()
    while (list.length && list[0]!.ts < cut) list.shift()
  }

  collect(trigger: number, preS: number, postS: number): Wave {
    const from = trigger - preS * 1000
    const to = trigger + postS * 1000
    const series: Record<string, [number, number][]> = {}
    for (const [dev, list] of this.ring) {
      for (const e of list) {
        if (e.ts < from || e.ts > to) continue
        for (const [k, v] of Object.entries(e.values)) {
          const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null
          if (n === null || k === 'q') continue
          ;(series[`${dev}/${k}`] ??= []).push([e.ts, n])
        }
      }
    }
    const steps: number[] = []
    for (const pts of Object.values(series)) {
      pts.sort((a, b) => a[0] - b[0])
      for (let i = 1; i < pts.length; i++) steps.push(pts[i]![0] - pts[i - 1]![0])
    }
    steps.sort((a, b) => a - b)
    const med = steps.length ? steps[steps.length >> 1]! : 0
    return { trigger, pre: preS, post: postS, rateHz: med > 0 ? Math.round((1000 / med) * 100) / 100 : null, series }
  }
}
