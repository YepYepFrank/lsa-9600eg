/* GET /api/status —— 本机概况：柜、设备清单与各设备的数据新鲜度、本机总线连接。
 * G0 骨架只到这里；Edge / IoT Gateway 状态、诊断、配置在 G2 */
import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'

const STARTED = Date.now()

@Controller('api')
export class StatusController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
  ) {}

  @Get('status')
  status() {
    const now = Date.now()
    return {
      eg: this.cfg.eg.name,
      cabinet: this.cfg.cabinet,
      station: this.cfg.station,
      sp: this.cfg.sp,
      uptimeSec: Math.round((now - STARTED) / 1000),
      bus: { url: this.cfg.conn.bus, connected: this.bus.connected, msgs: this.bus.msgs },
      devices: this.cfg.devices.map(d => {
        const live = this.bus.live.get(d.name)
        const keys = live ? Object.values(live.telemetry) : []
        const lastTs = keys.reduce((a, k) => Math.max(a, k.ts), 0)
        return {
          name: d.name,
          kind: d.kind,
          label: d.label,
          keys: keys.length,
          msgs: live?.msgs ?? 0,
          lastTs: lastTs || null,
          ageSec: lastTs ? Math.round((now - lastTs) / 1000) : null,
        }
      }),
      unknownDevices: [...this.bus.unknown.keys()],
    }
  }

  /** 某台设备各 key 的最新值（设备时间戳、到达时刻） */
  @Get('live/:device')
  live(@Param('device') device: string) {
    const d = this.bus.live.get(device)
    if (!d) throw new NotFoundException(`没有 ${device} 的数据`)
    return { device, telemetry: d.telemetry, attributes: d.attributes, msgs: d.msgs, lastAt: d.lastAt }
  }
}
