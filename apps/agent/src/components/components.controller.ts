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
import { UplinkService } from '../uplink/uplink.service.js'
import { AlarmsService } from '../alarms/alarms.service.js'
import { VideoClient } from '../video/video.controller.js'

@Controller('api')
export class ComponentsController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly comps: ComponentsService,
    private readonly uplinkSvc: UplinkService,
    private readonly self: SelfService,
    private readonly bus: BusService,
    private readonly quality: QualityService,
    private readonly audit: AuditService,
    private readonly alarms: AlarmsService,
    private readonly video: VideoClient,
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

  /** 诊断汇总：本机总线、到子站、对时、上送子站（遥测、告警事件）、资源、下挂设备 */
  @Get('diag')
  async diag() {
    const now = Date.now()
    const probe = this.self.uplinkProbe()
    const uplink = this.uplinkSvc.status()
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
      uplink,
      events: this.alarms.status(),
      video: await this.video.status(1500),
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
