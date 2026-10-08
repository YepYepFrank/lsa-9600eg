/* 能力清单与下挂设备状态参数的当前值（阶段 A，接口 v1.1）。只存状态、不依赖别的服务：
 * ApplyService 应用配置后（含启动时读 applied-config.json）调 set()；上送（UplinkService）、质量码（QualityService）、
 * caps.actual（CapsActualService）、本地页（/api/caps）来读。 */
import { Injectable, Logger } from '@nestjs/common'
import { capEnabled, deviceEnabled, deviceLocal, type CapsConfig } from './caps.js'

/** 下挂设备离线判据（§13）：fails ≥ failN 且距 last_ok 超过 max(minMs, periods × 周期) */
export interface DevCommParams {
  failN: number
  minMs: number
  periods: number
}
export const DEFAULT_DEVCOMM: DevCommParams = { failN: 5, minMs: 30_000, periods: 5 }

@Injectable()
export class CapsService {
  private readonly log = new Logger('能力')
  private current: CapsConfig | null = null
  private comm: DevCommParams = DEFAULT_DEVCOMM
  private readonly listeners: (() => void)[] = []
  private enabledCache = new Map<string, boolean>()

  /** 应用配置后调用（null = 子站没下发能力，全部照旧） */
  set(c: CapsConfig | null, devComm: DevCommParams | null): void {
    const before = JSON.stringify([this.current, this.comm])
    this.current = c
    this.comm = devComm ?? DEFAULT_DEVCOMM
    this.enabledCache = new Map()
    if (JSON.stringify([this.current, this.comm]) === before) return
    if (c) {
      const off = Object.entries(c.caps).filter(([, s]) => s !== 'confirmed').map(([k, s]) => `${k}=${s}`)
      this.log.log(`能力清单：${Object.keys(c.caps).length} 项${off.length ? `，不启用 ${off.join('、')}` : '，全部启用'}`)
    }
    for (const fn of this.listeners) fn()
  }

  /** 能力清单或参数变了（上送据此补 connect / 停送） */
  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  get config(): CapsConfig | null {
    return this.current
  }

  get devComm(): DevCommParams {
    return this.comm
  }

  capEnabled(cap: string): boolean {
    return capEnabled(cap, this.current)
  }

  /** 这台设备是否进 EG 本地 TB（v1.2：匹配上的能力全都是 unsupported = 不进） */
  deviceLocal(device: string): boolean {
    return deviceLocal(device, this.current)
  }

  /** 这台设备是否上送（整台匹配上的能力都不启用 = 不上送） */
  deviceEnabled(device: string): boolean {
    let v = this.enabledCache.get(device)
    if (v === undefined) {
      v = deviceEnabled(device, this.current)
      this.enabledCache.set(device, v)
    }
    return v
  }
}
