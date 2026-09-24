/* 组件状态、日志、重启；诊断汇总；审计 */
import { statfsSync } from 'node:fs'
import { freemem, totalmem, uptime } from 'node:os'
import { BadRequestException, Controller, Get, HttpCode, Inject, InternalServerErrorException, Param, Post, Query } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { BusService } from '../bus/bus.service.js'
import { ClientIp, CurrentSession, Maint } from '../auth/guard.js'
import type { Session } from '../auth/auth.service.js'
import { QualityService } from '../quality/quality.service.js'
import { SelfService } from '../self/self.service.js'
import { COMPONENTS, ComponentsService, RESTARTABLE, type ComponentKey } from './components.service.js'
import { EdgeDbService } from './edge-db.service.js'

/** 排队超过这么多条算有积压；上送偏移这么久没前进算「停了」；连得上子站却停了这么久才算 Edge 卡住 */
const BACKLOG = 100
const IDLE_MS = 15_000
const STUCK_MS = 3 * 60_000

@Controller('api')
export class ComponentsController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly comps: ComponentsService,
    private readonly edgeDb: EdgeDbService,
    private readonly self: SelfService,
    private readonly bus: BusService,
    private readonly quality: QualityService,
    private readonly audit: AuditService,
  ) {}

  @Get('components')
  components() {
    return this.comps.list()
  }

  @Maint()
  @Post('components/:key/restart')
  @HttpCode(200)
  async restart(@Param('key') key: string, @CurrentSession() s: Session, @ClientIp() ip: string) {
    if (!RESTARTABLE.includes(key as ComponentKey)) throw new BadRequestException(`只能重启 ${RESTARTABLE.map(k => COMPONENTS[k]).join('、')}`)
    const k = key as ComponentKey
    try {
      await this.comps.restart(k)
      this.audit.write({ user: s.user, name: s.name, via: s.via, ip, action: '重启组件', target: COMPONENTS[k], ok: true })
      return { ok: true }
    } catch (e) {
      this.audit.write({ user: s.user, name: s.name, via: s.via, ip, action: '重启组件', target: COMPONENTS[k], ok: false, detail: (e as Error).message })
      throw new InternalServerErrorException((e as Error).message)
    }
  }

  @Maint()
  @Get('logs/:key')
  async logs(@Param('key') key: string, @Query('tail') tail?: string) {
    if (key !== 'agent' && !(key in COMPONENTS)) throw new BadRequestException(`没有组件 ${key}`)
    const n = Math.min(Math.max(Number(tail) || 200, 10), 2000)
    try {
      return { key, lines: await this.comps.logs(key as ComponentKey | 'agent', n) }
    } catch (e) {
      throw new InternalServerErrorException((e as Error).message)
    }
  }

  /** 诊断汇总：本机总线、到子站、对时、Edge 上送、资源、下挂设备 */
  @Get('diag')
  async diag() {
    const now = Date.now()
    const q = this.edgeDb.queue()
    const probe = this.self.uplinkProbe()
    let uplink: { state: string; text: string }
    if ('error' in q) uplink = { state: 'unknown', text: `读不了 Edge 本地库：${q.error}` }
    else {
      const backlog = q.tsKv + q.events
      const idle = q.lastAdvanceAt ? now - q.lastAdvanceAt : Infinity
      if (backlog < BACKLOG) uplink = { state: 'ok', text: '正常，无积压' }
      else if (idle < IDLE_MS) {
        const eta = q.ratePerSec ? Math.ceil(backlog / q.ratePerSec) : null
        uplink = { state: 'backfill', text: `补传中，积压 ${backlog} 条${eta ? `，约 ${eta < 120 ? `${eta} 秒` : `${Math.ceil(eta / 60)} 分钟`}补完` : ''}` }
      } else if (probe.lossPct === 100) uplink = { state: 'offline', text: `连不上子站 ${probe.host}:${probe.port}，积压 ${backlog} 条，恢复后自动补传` }
      else if (idle < STUCK_MS) uplink = { state: 'paused', text: `上送暂停（Edge 在重连子站），积压 ${backlog} 条` }
      else
        uplink = {
          state: 'stuck',
          text: `子站连得上但 ${Math.round(idle / 60_000)} 分钟没上送，积压 ${backlog} 条 —— Edge 可能卡住（首次同步期间断过网？），可重启 Edge`,
        }
    }
    let disk: { usedPct: number; freeGb: number } | null = null
    try {
      const s = statfsSync(this.cfg.dir)
      disk = { usedPct: Math.round((1 - s.bavail / s.blocks) * 1000) / 10, freeGb: Math.round(((s.bavail * s.bsize) / 1073741824) * 10) / 10 }
    } catch {
      /* 取不到 */
    }
    return {
      now,
      bus: { url: this.cfg.conn.bus, connected: this.bus.connected },
      sp: probe,
      clock: this.self.clock(),
      edge: 'error' in q ? { error: q.error } : q,
      uplink,
      host: { uptimeSec: Math.round(uptime()), memUsedPct: Math.round((1 - freemem() / totalmem()) * 1000) / 10, disk },
      devices: { dead: this.quality.deadDevices(now), unknown: [...this.bus.unknown.keys()] },
    }
  }

  /** 某设备在总线上最近 20 条原始消息（给同事排错：发的主题、载荷对不对） */
  @Get('raw/:device')
  raw(@Param('device') device: string) {
    return { device, messages: this.bus.raw.get(device) ?? [] }
  }

  @Maint()
  @Get('audit')
  auditLog(@Query('limit') limit?: string) {
    return this.audit.recent(Math.min(Math.max(Number(limit) || 200, 1), 2000))
  }
}
