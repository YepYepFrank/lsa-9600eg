/* 南向通道统计 dev.*（接入规范 §6.6），每台下挂设备每分钟一条。
 *
 * EG 这一层看不到串口 / 网口的收发细节（那在同事的程序里），能看到的是「该来的数据来了没有」：
 *   dev.req_24h      近 24 h 应到的采样次数（按这类设备最快的周期档算：SAM / 电表 2 s、颗粒物 10 s、视频 60 s）
 *   dev.timeout_24h  其中没到的次数
 *   dev.rate_24h     到达率 %
 * 校验错 dev.crc_24h、重试 dev.retry_24h 只有同事的程序知道，这里不编；
 * 同事的程序自己发了 dev.*（任何一个）的设备，这里就不再发，以他的为准。
 *
 * 计数按分钟分桶留 24 h；agent 重启后从零开始计（窗口按运行时长算，不会把重启前当成超时）。 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { periodMs, pointsOf } from '@lsa/points'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService, type Entry } from '../bus/bus.service.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN

interface DeviceStats {
  /** 最快周期档 ms：应到间隔 */
  interval: number
  /** 最快档的测点：带其中任一个的消息算一次采样（慢档消息不算，否则会掩盖快档丢数） */
  fastKeys: Set<string>
  /** 分钟序号 → 这一分钟里到了多少个不同的采样时刻 */
  buckets: Map<number, Set<number>>
  /** 同事的程序自己发 dev.* */
  bySource: boolean
}

export interface SouthRow {
  req: number
  timeout: number
  rate: number | null
}

@Injectable()
export class SouthService implements OnModuleInit, OnModuleDestroy {
  private readonly stats = new Map<string, DeviceStats>()
  private readonly startedAt = Date.now()
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
  ) {
    for (const d of cfg.devices) {
      if (d.kind === 'eg') continue
      const pts = pointsOf(d.kind, cfg.cabinet.group).map(p => ({ key: p.key, ms: periodMs(p.period) }))
      const periods = pts.map(p => p.ms).filter((x): x is number => x !== null)
      if (!periods.length) continue
      const interval = Math.min(...periods)
      const fastKeys = new Set(pts.filter(p => p.ms === interval).map(p => p.key))
      this.stats.set(d.name, { interval, fastKeys, buckets: new Map(), bySource: false })
    }
  }

  onModuleInit(): void {
    this.bus.onTelemetry((dev, entries, own) => {
      if (!own) this.take(dev, entries)
    })
    // 第一条在启动 1 分钟后发（窗口太短的到达率没意义），之后每分钟
    this.first = setTimeout(() => {
      this.publishAll()
      this.timer = setInterval(() => this.publishAll(), MIN)
    }, MIN)
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
  }

  /** 某设备当前的统计 */
  rowOf(device: string, now = Date.now()): SouthRow | null {
    const s = this.stats.get(device)
    if (!s) return null
    const from = Math.max(this.startedAt, now - DAY)
    const req = Math.floor((now - from) / s.interval)
    let got = 0
    for (const [m, set] of s.buckets) {
      if (m * MIN + MIN <= from) s.buckets.delete(m)
      else got += set.size
    }
    got = Math.min(got, req)
    return { req, timeout: req - got, rate: req > 0 ? Math.round((got / req) * 10000) / 100 : null }
  }

  bySource(device: string): boolean {
    return this.stats.get(device)?.bySource ?? false
  }

  private take(device: string, entries: Entry[]): void {
    const s = this.stats.get(device)
    if (!s) return
    for (const e of entries) {
      const keys = Object.keys(e.values)
      if (keys.some(k => k.startsWith('dev.') && k !== 'dev.link')) s.bySource = true
      if (!keys.some(k => s.fastKeys.has(k))) continue
      // 按到达时刻分桶（补发的旧数据也算到达）；同一采样时刻只算一次
      const m = Math.floor(Date.now() / MIN)
      let set = s.buckets.get(m)
      if (!set) s.buckets.set(m, (set = new Set()))
      set.add(e.ts)
    }
  }

  private publishAll(): void {
    const now = Date.now()
    for (const name of this.stats.keys()) {
      if (this.bySource(name)) continue
      const r = this.rowOf(name, now)
      if (!r || r.req === 0) continue
      this.bus.publish(name, { 'dev.req_24h': r.req, 'dev.timeout_24h': r.timeout, 'dev.rate_24h': r.rate }, now)
    }
  }
}
