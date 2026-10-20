/* 传感器预热的状态（0.17，docs/气体传感器预热方案.md v2；判定逻辑在 warmup.ts）。
 *
 * 只管「需要预热的设备」（warmupDevice：eg.yaml 设备属性 warmup: true / warmupS，T08 后加气体种类）。
 * QualityService 收到测量值时调 read()、发 q / dev.warmup_s 时调 remaining()：
 *   预热中该设备的量在 q 里标 warmup，dev.warmup_s 报剩余秒数（启动即发、进出预热立即发、预热中每 10 s、就绪后随分钟档）。
 * T3（主机刚开机）在启动时判一次，武装各设备（柜在 bootOffCabs 里的不武装）；下一次读到数时开始计时。
 * 预热结束时刻落盘（config/warmup-state.json）：agent 在预热中途重启（主机没重启）时接着算，不当成已就绪。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { CapsService } from '../caps/caps.service.js'
import { bootTrigger, deviceWarmupS, warmupDevice, WarmupTracker, type WarmupReason } from './warmup.js'

const REASON_TEXT: Record<WarmupReason, string> = { T2: '读数中断后恢复', T3: 'EG 主机刚开机' }

interface State {
  hostBootId: string | null
  until: Record<string, number>
}

@Injectable()
export class WarmupService implements OnModuleInit {
  private readonly log = new Logger('传感器预热')
  private readonly devs = new Map<string, { attrs: Record<string, unknown>; t: WarmupTracker }>()
  private readonly file: string
  private readonly hostBootId: string | null
  /** 测试用：开机时长（s），缺省读本机 */
  uptimeS: () => number = () => uptime()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly caps: CapsService,
  ) {
    this.file = resolve(cfg.dir, 'warmup-state.json')
    this.hostBootId = (() => {
      try {
        return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
      } catch {
        return null
      }
    })()
    for (const d of cfg.devices) if (d.kind !== 'eg' && warmupDevice(d)) this.devs.set(d.name, { attrs: d.attrs, t: new WarmupTracker() })
  }

  /** 启动时（各服务都构造完、ApplyService 已把下发过的参数交给 CapsService）：接着算上次没完的预热，再判 T3 */
  onModuleInit(): void {
    if (!this.devs.size) return
    const now = Date.now()
    let last: State | null = null
    try {
      last = JSON.parse(readFileSync(this.file, 'utf8')) as State
    } catch {
      /* 第一次跑 / 文件坏了：当没有 */
    }
    if (last && this.hostBootId && last.hostBootId === this.hostBootId) {
      for (const [name, until] of Object.entries(last.until ?? {})) {
        const d = this.devs.get(name)
        if (d && until > now) d.t.until = until
      }
    }
    const p = this.caps.gas
    const cab = this.cfg.cabinet.code
    const unit = this.cfg.unit.code
    // 按要预热的设备里最长的时长判「刚开机」（0.7.1：站级缺省 0 了，设备 attrs.warmupS 单独设了的照样要判）；预热 0 秒的设备不武装
    const armable = [...this.devs.entries()].filter(([, d]) => deviceWarmupS(d.attrs, p) > 0)
    const maxS = Math.max(0, ...armable.map(([, d]) => deviceWarmupS(d.attrs, p)))
    const boot = bootTrigger({ uptimeS: this.uptimeS(), warmupS: maxS, hostBootId: this.hostBootId, lastHostBootId: last?.hostBootId ?? null })
    // gasBootWarmupOffCabs 按柜号（子站按柜给）；单元号也认
    if (boot && (p.bootOffCabs.includes(cab) || p.bootOffCabs.includes(unit))) this.log.log(`EG 主机刚开机，但本柜 ${cab} 在 gasBootWarmupOffCabs 里（传感器与 EG 不同一路电），不进预热`)
    else if (boot) {
      for (const [, d] of armable) d.t.bootArmed = true
      this.log.log(`EG 主机刚开机（开机 ${Math.round(this.uptimeS())} s）：${armable.map(([n, d]) => `${n} ${deviceWarmupS(d.attrs, p)} s`).join('、')}，读到数后开始预热`)
    }
    this.save()
  }

  /** 需要预热的设备 */
  devices(): string[] {
    return [...this.devs.keys()]
  }

  has(device: string): boolean {
    return this.devs.has(device)
  }

  /** 读到一次测量值（QualityService 调）。触发了预热返回 true */
  read(device: string, now = Date.now()): boolean {
    const d = this.devs.get(device)
    if (!d) return false
    const p = this.caps.gas
    const s = deviceWarmupS(d.attrs, p)
    const why = d.t.read(now, s, p.gapS)
    if (!why) return false
    this.log.log(`${device} 进入预热 ${s} s（${why} ${REASON_TEXT[why]}）`)
    this.save()
    return true
  }

  /** 这台设备的预热时长（s）：eg.yaml attrs.warmupS > 子站下发的 gasWarmupS > 缺省 0；0 = 不做预热 */
  seconds(device: string): number {
    const d = this.devs.get(device)
    return d ? deviceWarmupS(d.attrs, this.caps.gas) : 0
  }

  /** 剩余预热秒数（0 = 就绪；不是需要预热的设备也是 0） */
  remaining(device: string, now = Date.now()): number {
    const d = this.devs.get(device)
    if (!d) return 0
    const p = this.caps.gas
    return d.t.remaining(now, deviceWarmupS(d.attrs, p), p.gapS)
  }

  /** 读数一回来就要预热（读数中断已满 gapS / 主机刚开机还没读到），还没开始计时 */
  waiting(device: string, now = Date.now()): boolean {
    const d = this.devs.get(device)
    return !!d && d.t.waiting(now, this.caps.gas.gapS)
  }

  /** 本地页 / 状态接口：各设备预热情况 */
  info(now = Date.now()): { device: string; remainingS: number; reason: WarmupReason | null; armed: boolean }[] {
    return [...this.devs].map(([device, d]) => ({ device, remainingS: this.remaining(device, now), reason: d.t.reason, armed: d.t.bootArmed }))
  }

  private save(): void {
    const s: State = { hostBootId: this.hostBootId, until: Object.fromEntries([...this.devs].filter(([, d]) => d.t.until !== null).map(([n, d]) => [n, d.t.until!])) }
    try {
      writeFileSync(this.file, JSON.stringify(s), 'utf8')
    } catch (e) {
      this.log.warn(`warmup-state.json 写不了：${(e as Error).message}`)
    }
  }
}
