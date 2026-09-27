/* POST /hooks/alarm —— EG 本地 TB 规则链推来的告警变化（provision:eg --hook）。不要登录：本地 TB 的 REST 节点不带凭据；
 *   请求体只当提示，agent 按告警 id 回本地 TB 读一遍才记（alarms.service.ts），伪造的请求记不进任何东西。
 * GET /api/alarms —— 本机最近的告警与送子站的状态（本地页用）。 */
import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common'
import { Public } from '../auth/guard.js'
import { AlarmsService, type AlarmHook } from './alarms.service.js'

@Controller()
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  @Public()
  @Post('hooks/alarm')
  @HttpCode(200)
  hook(@Body() body: AlarmHook) {
    return this.alarms.hook(body ?? {})
  }

  @Get('api/alarms')
  list(@Query('limit') limit?: string) {
    const n = Math.min(500, Math.max(1, Number(limit) || 50))
    return { events: this.alarms.status(), alarms: this.alarms.recent(n) }
  }

  /** 自检用：不理钩子（只靠 30 s 对账）/ 马上对账一次。只在 EG_DEBUG=1 时开放 */
  @Public()
  @Post('api/_debug/alarms')
  @HttpCode(200)
  async debug(@Query('hooks') hooks?: string, @Query('reconcile') reconcile?: string) {
    if (process.env['EG_DEBUG'] !== '1') throw new ForbiddenException('只在调试模式（EG_DEBUG=1）开放')
    if (hooks === 'off') this.alarms.ignoreHooks = true
    if (hooks === 'on') this.alarms.ignoreHooks = false
    if (reconcile === '1') await this.alarms.reconcileNow()
    return this.alarms.status()
  }
}
