/* 每台下挂设备的预期测点，取自 EG 本机的转换程序配置（config/conv/sensors/*.yaml，EG 0.6.2，全链路联调 W1）。
 *
 * QualityService（质量码、dev.comm、缺量）与 SouthService（到达率）按它看护：只有预期测点算缺；
 * 不在预期里、以前来过的量（传感器改挂到别的设备以后，旧设备上留下的）照常过期成 stale / invalid 写进 q（W2），但不算进 dev.comm。
 * 没有转换程序配置、或某台设备没有传感器挂它：这台照旧按物模型全量看护。
 * 配置每 30 s 看一次有没有改（install-conv.sh 改了 enabled / device 以后不用重启 agent）。
 *
 * 0.17.4（舱室 EG 方案 §4）：顺带把 485 总线清单（打开的传感器的从站地址、挂哪台设备）作为 EG 的客户端属性 conv.bus 报给子站，
 * 子站网关页「接口与下挂设备」按它显示实际地址。配置变了、每次连上总线都报；没有转换程序配置时报空清单。 */
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { busConflicts, convExpectSig, loadConvExpect, type ConvBus, type ConvExpect } from '@lsa-eg/config/conv-expect'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'

const RELOAD_MS = 30_000

@Injectable()
export class ConvExpectService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('转换程序配置')
  private cur: ConvExpect | null = null
  private sig: string | null = null
  private readonly subs: (() => void)[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    @Optional() private readonly bus?: BusService,
  ) {
    this.reload()
  }

  onModuleInit(): void {
    this.bus?.onConnect(() => this.publishBus())
    this.timer = setInterval(() => this.reload(), RELOAD_MS)
    this.timer.unref?.()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** 这台设备的预期测点；null = 按物模型全量（没有转换程序配置，或没有传感器挂它） */
  expected(device: string): ReadonlySet<string> | null {
    const s = this.cur?.byDevice.get(device)
    return s && s.size ? s : null
  }

  /** 485 总线清单（没有转换程序配置为 null） */
  busList(): ConvBus | null {
    return this.cur?.bus ?? null
  }

  /** 报 EG 客户端属性 conv.bus（JSON 串；没有转换程序配置时 slaves 为空） */
  private publishBus(): void {
    if (!this.bus) return
    const b: ConvBus = this.cur?.bus ?? { v: 1, port: 'COM2', baud: null, slaves: [] }
    this.bus.publishAttributes(this.cfg.eg.name, { 'conv.bus': JSON.stringify(b) })
  }

  /** 配置改了（重读以后）通知 */
  onChange(fn: () => void): void {
    this.subs.push(fn)
  }

  /** 重读（签名没变就不动）；返回是否变了 */
  reload(): boolean {
    const sig = convExpectSig(this.cfg.dir)
    if (sig === this.sig) return false
    const first = this.sig === null
    this.sig = sig
    this.cur = loadConvExpect(this.cfg.dir)
    this.report()
    if (!first) this.publishBus()
    if (!first) for (const fn of this.subs) fn()
    return true
  }

  private report(): void {
    const c = this.cur
    if (!c) {
      this.log.log('没有转换程序配置（config/conv/sensors/）：下挂设备按物模型全量看护')
      return
    }
    for (const e of c.errors) this.log.warn(`读不了：${e}`)
    for (const [a, l] of busConflicts(c.bus)) this.log.warn(`485 总线上从站地址 ${a} 重复：${l.join('、')}（只能有一台应答，用 install-conv.sh --addr 改）`)
    if (c.bus.slaves.length) this.log.log(`485 总线（${c.bus.port}${c.bus.baud ? ` · ${c.bus.baud}` : ''}）：${c.bus.slaves.map(s => `${s.a} ${s.n}→${s.dev}`).join('，')}`)
    const names = new Set(this.cfg.devices.map(d => d.name))
    for (const d of this.cfg.devices) {
      if (d.kind === 'eg') continue
      const s = c.byDevice.get(d.name)
      if (s?.size) this.log.log(`${d.name} 预期测点：${[...s].join(', ')}`)
      else if (d.kind === 'sam') this.log.log(`${d.name}：转换程序配置里没有传感器挂它，按物模型全量看护`)
    }
    for (const n of c.byDevice.keys()) if (!names.has(n)) this.log.warn(`转换程序配置里的设备「${n}」不在 eg.yaml 里：它的数据进不了本地 TB、也不上送`)
  }
}
