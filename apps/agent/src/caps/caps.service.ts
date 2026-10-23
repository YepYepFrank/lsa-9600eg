/* 能力清单与下挂设备状态参数的当前值（阶段 A，接口 v1.1）。只存状态、不依赖别的服务：
 * ApplyService 应用配置后（含启动时读 applied-config.json）调 set()；上送（UplinkService）、质量码（QualityService）、
 * caps.actual（CapsActualService）、本地页（/api/caps）来读。
 * 0.8.1：另外按 eg.yaml 记下每台下挂设备点表里的遥测 key（判「整台不启用」时，有不归任何能力的 key 就照常启用，见 caps.ts deviceEnabled）；
 * 自检里直接 new、不给配置时照旧只看能力。 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { pointsOf } from '@lsa/points'
import { EG_CONFIG } from '../config.js'
import { capEnabled, deviceEnabled, deviceLocal, keyCapState, type CapState, type CapsConfig } from './caps.js'
import { DEFAULT_GAS, type GasParams } from '../warmup/warmup.js'

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
  private gasP: GasParams = DEFAULT_GAS
  private readonly listeners: (() => void)[] = []
  private enabledCache = new Map<string, boolean>()
  /** 设备名 → 点表里的遥测 key（不含 dev.*） */
  private readonly keys = new Map<string, string[]>()

  constructor(@Optional() @Inject(EG_CONFIG) cfg?: EgConfig) {
    for (const d of cfg?.devices ?? []) {
      if (d.kind === 'eg' || d.kind === 'pm') continue
      this.keys.set(d.name, (pointsOf(d.kind, cfg!.cabinet.group, true) as { key: string }[]).map(p => p.key).filter(k => !k.startsWith('dev.')))
    }
  }

  /** 应用配置后调用（null = 子站没下发能力 / 参数，全部照旧）；gas = 传感器预热参数（0.17，extras.gas*） */
  set(c: CapsConfig | null, devComm: DevCommParams | null, gas: GasParams | null = null): void {
    const before = JSON.stringify([this.current, this.comm, this.gasP])
    this.current = c
    this.comm = devComm ?? DEFAULT_DEVCOMM
    this.gasP = gas ?? DEFAULT_GAS
    this.enabledCache = new Map()
    if (JSON.stringify([this.current, this.comm, this.gasP]) === before) return
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

  /** 传感器预热参数（子站没下发 = 缺省 0 / 60 / []；0.7.1 起预热缺省 0） */
  get gas(): GasParams {
    return this.gasP
  }

  capEnabled(cap: string): boolean {
    return capEnabled(cap, this.current)
  }

  /** 某台设备某个量的能力状态（null = 没有对应能力或子站没下发，照旧当启用） */
  keyState(device: string, key: string): CapState | null {
    return keyCapState(device, key, this.current)
  }

  /** 这台设备是否进 EG 本地 TB（v1.2：匹配上的能力全都是 unsupported = 不进） */
  deviceLocal(device: string): boolean {
    return deviceLocal(device, this.current)
  }

  /** 这台设备是否上送（整台匹配上的能力都不启用 = 不上送） */
  deviceEnabled(device: string): boolean {
    let v = this.enabledCache.get(device)
    if (v === undefined) {
      v = deviceEnabled(device, this.current, this.keys.get(device))
      this.enabledCache.set(device, v)
    }
    return v
  }
}
