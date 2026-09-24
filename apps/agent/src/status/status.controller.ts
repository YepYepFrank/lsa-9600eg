/* GET /api/status —— 本机概况：柜、设备清单与各设备的数据新鲜度 / 质量码 / 南向统计、本机总线、进程内存。
 * GET /api/live/:device —— 某设备各 key 的最新值。
 * 都要登录（只读角色即可）；组件、诊断、配置、审计在 components / config 控制器。 */
import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'
import { DeriveService } from '../derive/derive.service.js'
import { QualityService } from '../quality/quality.service.js'
import { SelfService } from '../self/self.service.js'
import { SouthService } from '../south/south.service.js'
import { Public } from '../auth/guard.js'

const STARTED = Date.now()

@Controller('api')
export class StatusController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly quality: QualityService,
    private readonly south: SouthService,
    private readonly self: SelfService,
    private readonly derive: DeriveService,
  ) {}

  @Get('status')
  status() {
    const now = Date.now()
    const dead = new Set(this.quality.deadDevices(now))
    return {
      eg: this.cfg.eg.name,
      cabinet: this.cfg.cabinet,
      station: this.cfg.station,
      sp: this.cfg.sp,
      uptimeSec: Math.round((now - STARTED) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      bus: { url: this.cfg.conn.bus, connected: this.bus.connected, msgs: this.bus.msgs },
      state: dead.size ? 'degraded' : 'online',
      devices: this.cfg.devices.map(d => {
        const live = this.bus.live.get(d.name)
        // 新鲜度只看传感器来的量，不看 agent 自己发的 q / dev.* / 派生量
        const keys = live ? Object.values(live.telemetry).filter(k => !k.own) : []
        const lastTs = keys.reduce((a, k) => Math.max(a, k.ts), 0)
        return {
          name: d.name,
          kind: d.kind,
          label: d.label,
          keys: keys.length,
          msgs: live?.msgs ?? 0,
          lastTs: lastTs || null,
          ageSec: lastTs ? Math.round((now - lastTs) / 1000) : null,
          dead: dead.has(d.name),
          q: this.quality.qualityOf(d.name, now),
          south: this.south.rowOf(d.name, now),
          southBySource: this.south.bySource(d.name),
          rated: this.derive.ratedOf(d.name),
          epBackwards: this.derive.epBackwards.get(d.name) ?? 0,
        }
      }),
      unknownDevices: [...this.bus.unknown.keys()],
    }
  }

  /** 某台设备各 key 的最新值（设备时间戳、到达时刻、是否 agent 自己算的） */
  @Get('live/:device')
  live(@Param('device') device: string) {
    const d = this.bus.live.get(device)
    if (!d) throw new NotFoundException(`没有 ${device} 的数据`)
    return { device, telemetry: d.telemetry, attributes: d.attributes, msgs: d.msgs, lastAt: d.lastAt, q: this.quality.qualityOf(device) }
  }

  /** 自检用：暂停发 EG 自身指标 s 秒，模拟 agent 停掉（看 IoT Gateway 的自定义连接器能否维持 EG 在线）。只在 EG_DEBUG=1 时开放 */
  @Public()
  @Post('_debug/self-pause')
  @HttpCode(200)
  pauseSelf(@Query('s') s: string) {
    if (process.env['EG_DEBUG'] !== '1') throw new ForbiddenException('只在调试模式（EG_DEBUG=1）开放')
    const sec = Number(s)
    if (!Number.isFinite(sec) || sec < 0 || sec > 600) throw new BadRequestException('s 取 0–600')
    this.self.pausedUntil = Date.now() + sec * 1000
    return { pausedUntil: this.self.pausedUntil }
  }
}
