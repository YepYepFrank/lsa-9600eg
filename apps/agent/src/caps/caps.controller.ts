/* 本地页读能力清单（阶段 A）：子站下发的本柜能力状态、capKeys、EG 实际判定（caps.actual）、离线判据参数。
 * 子站没下发过能力时 delivered = false，页面按现在的样子显示（不隐藏）。 */
import { Controller, Get } from '@nestjs/common'
import { CapsActualService } from './caps-actual.service.js'
import { CapsService } from './caps.service.js'

@Controller('api')
export class CapsController {
  constructor(
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
    }
  }
}
