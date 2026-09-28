/* PUT /api/config —— 子站扩展服务下发配置（I4，§8.3）。鉴权：请求头 X-EG-Ticket 带子站签的服务票据（角色 station，60 s、一次性），
 * 不认浏览器会话（本地维护账号也不能改阈值与规则 —— 配置只有子站一个来源）。
 * 校验不过、写不进本地 TB 都回 200 + status FAILED 与原因（扩展服务照原因显示「失败」）；票据不对回 401。
 * 调试（EG_DEBUG=1）：POST /api/config/_debug?unavailable=1 让 PUT 回 503（扮演 EG 离线，测子站 PENDING 与恢复后自动重发），=0 恢复；
 *   ?tbDown=1 假装本地 TB 没就绪（测 EG 回 PENDING、排队、就绪后自动应用），=0 恢复。 */
import { Body, Controller, ForbiddenException, Headers, HttpCode, Post, Put, Query, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
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
    if (this.unavailable) throw new ServiceUnavailableException({ code: 'debug_unavailable', message: '调试：暂不接受配置下发（EG_DEBUG）' })
    const c = this.auth.verifyService(ticket)
    if ('error' in c) {
      this.audit.write({ user: '?', name: '?', via: 'sp', ip, action: '应用子站配置', target: '?', ok: false, detail: c.error })
      throw new UnauthorizedException({ code: 'bad_ticket', message: c.error })
    }
    return this.apply.apply(body, { user: c.u, name: c.n, ip })
  }

  private unavailable = false

  @Public()
  @Post('_debug')
  @HttpCode(200)
  debug(@Query('unavailable') unavailable?: string, @Query('tbDown') tbDown?: string) {
    if (process.env['EG_DEBUG'] !== '1') throw new ForbiddenException('只在调试模式（EG_DEBUG=1）开放')
    if (unavailable === '1' || unavailable === '0') this.unavailable = unavailable === '1'
    if (tbDown === '1' || tbDown === '0') this.apply.debugTbDown = tbDown === '1'
    return { unavailable: this.unavailable, tbDown: this.apply.debugTbDown, pending: this.apply.pendingInfo() }
  }
}
