/* PUT /api/config —— 子站扩展服务下发配置（I4，§8.3）。鉴权：请求头 X-EG-Ticket 带子站签的服务票据（角色 station，60 s、一次性），
 * 不认浏览器会话（本地维护账号也不能改阈值与规则 —— 配置只有子站一个来源）。
 * 校验不过、写不进本地 TB 都回 200 + status FAILED 与原因（扩展服务照原因显示「失败」）；票据不对回 401。 */
import { Body, Controller, Headers, HttpCode, Put, UnauthorizedException } from '@nestjs/common'
import { AuditService } from '../audit/audit.service.js'
import { AuthService } from '../auth/auth.service.js'
import { ClientIp, Public } from '../auth/guard.js'
import { ApplyService } from './apply.service.js'

@Controller('api/config')
export class ApplyController {
  constructor(
    private readonly auth: AuthService,
    private readonly apply: ApplyService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Put()
  @HttpCode(200)
  put(@Headers('x-eg-ticket') ticket: string | undefined, @Body() body: unknown, @ClientIp() ip: string) {
    const c = this.auth.verifyService(ticket)
    if ('error' in c) {
      this.audit.write({ user: '?', name: '?', via: 'sp', ip, action: '应用子站配置', target: '?', ok: false, detail: c.error })
      throw new UnauthorizedException({ code: 'bad_ticket', message: c.error })
    }
    return this.apply.apply(body, { user: c.u, name: c.n, ip })
  }
}
