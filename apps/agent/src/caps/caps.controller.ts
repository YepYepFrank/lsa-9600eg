/* 本地页读能力清单（阶段 A）：子站下发的本柜能力状态、capKeys、EG 实际判定（caps.actual）、离线判据参数。
 * 子站没下发过能力时 delivered = false，页面按现在的样子显示（不隐藏）。 */
import { Controller, Get, Inject } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { CapsActualService } from './caps-actual.service.js'
import { CapsService } from './caps.service.js'

@Controller('api')
export class CapsController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly caps: CapsService,
    private readonly actual: CapsActualService,
  ) {}

  @Get('caps')
  get() {
    const c = this.caps.config
    return {
      delivered: !!c,
      caps: c?.caps ?? null,
      capKeys: c?.capKeys ?? null,
      actual: this.actual.actual(),
      devComm: this.caps.devComm,
      // 不上送子站的设备（能力都不启用）与不进本地 TB 的设备（能力全都 unsupported，v1.2）
      notUploaded: this.cfg.devices.map(d => d.name).filter(n => !this.caps.deviceEnabled(n)),
      notLocal: this.cfg.devices.map(d => d.name).filter(n => !this.caps.deviceLocal(n)),
    }
  }
}
