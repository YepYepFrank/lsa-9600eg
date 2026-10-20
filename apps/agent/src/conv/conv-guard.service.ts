/* 转换程序保险（0.17；2026-10-13 用户定 Mosquitto 一侧归 EG 方）。不管装的是哪个转换程序，eg-agent 在旁边看着：
 *
 *   1. 本机总线 lsa-eg-mosquitto 重启了（容器启动时刻变了），conv 是在它之前起的 → 重启 lsa-eg-conv：
 *      转换程序断线后不重连的话，总线一重启（EG 升级、Mosquitto 崩了自起）这面柜就再没数据（联调实测）
 *   2. conv 在跑、却超过 silentS（缺省 60 s）总线上没有它的任何读数 → 重启 conv。
 *      连续重启要退避：第 n 次之后至少等 silentS × 2^n（最多 maxBackoffS，缺省 30 min）才再动；读数回来就清零
 *
 * 「它的读数」= 转换程序发的下挂设备遥测（eg.yaml 里 sam / meter / pm 的设备）；eg-agent 自己发的、eg-video 发的摄像机、EG 级信号都不算。
 * conv 没启用（容器不存在 / 没在跑，比如没有 485 的样机）时什么也不做；没在跑由 Docker 的 restart: unless-stopped 管。
 *
 * 每次重启：
 *   - agent 日志 + 本地审计（action「自动重启转换程序」，detail 写原因）；
 *   - EG 自身遥测 eg.conv_restarts（累计次数）、eg.conv_restart（最近一次 {"at","reason","detail"} 的 JSON 串）上送子站，
 *     子站 check.sh / 自监控据此提示；
 *   - 状态落盘 config/conv-guard.json（install.sh --status 显示）。
 * 参数在 local.yaml：convGuard { enabled, silentS, maxBackoffS }，容器名 docker.containers.conv / mosquitto。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { BusService } from '../bus/bus.service.js'
import { dockerCall, dockerJson } from '../components/docker.js'

interface Inspect {
  State: { Status: string; StartedAt: string }
}

export type ConvRestartReason = 'mosquitto-restart' | 'silent'
const REASON_TEXT: Record<ConvRestartReason, string> = { 'mosquitto-restart': '本机总线 Mosquitto 重启过', silent: '总线上长时间没有转换程序的读数' }

export interface ConvGuardState {
  restarts: number
  last: { at: number; reason: ConvRestartReason; detail: string } | null
  backoffN: number
  nextAllowedAt: number
}

const TICK_MS = 5_000
const REPUBLISH_MS = 600_000

@Injectable()
export class ConvGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('转换程序保险')
  private readonly file: string
  private readonly devices: Set<string>
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now()
  /** 最近一次收到转换程序读数（agent 收到的时刻） */
  lastReadAt = 0
  private mqStartedAt: number | null = null
  private publishedAt = 0
  private busy = false
  state: ConvGuardState = { restarts: 0, last: null, backoffN: 0, nextAllowedAt: 0 }
  /** 测试用 */
  tickMs = TICK_MS
  now: () => number = () => Date.now()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly audit: AuditService,
  ) {
    this.file = resolve(cfg.dir, 'conv-guard.json')
    // 0.7.1：PM6 取消，老 eg.yaml 里还挂着的 pm 不算（转换程序不再读它，算进来会一直判「没数」而重启转换程序）
    this.devices = new Set(cfg.devices.filter(d => d.kind === 'sam' || d.kind === 'meter').map(d => d.name))
    try {
      this.state = { ...this.state, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ConvGuardState>) }
    } catch {
      /* 第一次 / 坏了：从 0 开始 */
    }
  }

  private get p() {
    const g = this.cfg.local.convGuard
    return { enabled: g?.enabled !== false, silentS: Math.max(10, g?.silentS ?? 60), maxBackoffS: Math.max(60, g?.maxBackoffS ?? 1800) }
  }

  private get api(): string {
    return process.env['EG_DOCKER_API'] || this.cfg.local.docker.api
  }

  private get conv(): string {
    return this.cfg.local.docker.containers.conv ?? 'lsa-eg-conv'
  }

  private get mosquitto(): string {
    return this.cfg.local.docker.containers.mosquitto
  }

  onModuleInit(): void {
    this.bus.onTelemetry((dev, _entries, own) => {
      if (own || !this.devices.has(dev)) return
      this.lastReadAt = this.now()
      if (this.state.backoffN) {
        this.log.log(`转换程序的读数恢复了（${dev}），重启退避清零`)
        this.state = { ...this.state, backoffN: 0, nextAllowedAt: 0 }
        this.save()
      }
    })
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** 本地页 / 状态接口 */
  info() {
    const p = this.p
    return { ...this.state, enabled: p.enabled, silentS: p.silentS, lastReadAt: this.lastReadAt || null, container: this.conv }
  }

  private async inspect(name: string): Promise<{ running: boolean; startedAt: number } | null> {
    try {
      const i = await dockerJson<Inspect>(this.api, `/containers/${encodeURIComponent(name)}/json`)
      return { running: i.State.Status === 'running', startedAt: Date.parse(i.State.StartedAt) || 0 }
    } catch {
      return null
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = this.now()
      if (now - this.publishedAt > REPUBLISH_MS && this.state.restarts) this.publish()
      const p = this.p
      if (!p.enabled) return
      const [conv, mq] = await Promise.all([this.inspect(this.conv), this.inspect(this.mosquitto)])
      const mqRestarted = !!mq && this.mqStartedAt !== null && mq.startedAt > this.mqStartedAt
      if (mq) this.mqStartedAt = mq.startedAt
      // conv 没启用 / 没在跑：不管（restart: unless-stopped 管它自己的崩溃）
      if (!conv?.running) return
      // 1. 总线重启了、conv 是在它之前起的：重启 conv（等总线起来 3 s）
      if (mqRestarted && mq!.running && conv.startedAt < mq!.startedAt) {
        if (now - mq!.startedAt < 3_000) {
          this.mqStartedAt = mq!.startedAt - 1 // 下一轮再判
          return
        }
        await this.restart('mosquitto-restart', `总线 ${this.mosquitto} ${new Date(mq!.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 重新起来，conv 是 ${new Date(conv.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 起的`)
        return
      }
      // 2. 长时间没有读数：从 conv 起来、agent 起来、最近一次读数里最晚的那个算
      const since = Math.max(this.lastReadAt, conv.startedAt, this.startedAt)
      const silentMs = now - since
      if (silentMs > p.silentS * 1000 && now >= this.state.nextAllowedAt) {
        await this.restart('silent', `${Math.round(silentMs / 1000)} s 没有转换程序的读数（门限 ${p.silentS} s）`)
        const n = this.state.backoffN + 1
        this.state = { ...this.state, backoffN: n, nextAllowedAt: this.now() + Math.min(p.silentS * 2 ** n, p.maxBackoffS) * 1000 }
        this.save()
      }
    } catch (e) {
      this.log.warn(`检查转换程序出错：${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }

  private async restart(reason: ConvRestartReason, detail: string): Promise<void> {
    let ok = true
    let err = ''
    try {
      const r = await dockerCall(this.api, 'POST', `/containers/${encodeURIComponent(this.conv)}/restart?t=10`, 60_000)
      if (r.status >= 400) {
        ok = false
        err = `Docker API ${r.status} ${r.body.toString('utf8').slice(0, 120)}`
      }
    } catch (e) {
      ok = false
      err = (e as Error).message
    }
    const at = this.now()
    this.state = { ...this.state, restarts: this.state.restarts + (ok ? 1 : 0), last: { at, reason, detail: ok ? detail : `${detail}；重启失败：${err}` } }
    this.save()
    const text = `${REASON_TEXT[reason]}：${detail}`
    if (ok) this.log.warn(`自动重启转换程序 ${this.conv}（${text}；累计 ${this.state.restarts} 次）`)
    else this.log.error(`自动重启转换程序 ${this.conv} 失败（${text}）：${err}`)
    this.audit.write({ user: 'system', name: '转换程序保险', via: 'system', ip: '-', action: '自动重启转换程序', target: this.conv, ok, detail: ok ? text : `${text}；${err}` })
    this.publish()
  }

  private publish(): void {
    this.publishedAt = this.now()
    this.bus.publish(this.cfg.eg.name, { 'eg.conv_restarts': this.state.restarts, 'eg.conv_restart': JSON.stringify(this.state.last ?? {}) }, this.now())
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.state), 'utf8')
    } catch (e) {
      this.log.warn(`conv-guard.json 写不了：${(e as Error).message}`)
    }
  }
}
