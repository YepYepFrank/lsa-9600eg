/* 证据接口（G5，docs/G5证据约定.md §3、§5）：
 *   PUT  /api/evidence/lock             子站请求锁定时间窗（X-EG-Ticket 服务票据）→ 回执 ACCEPTED / EXPIRED / PARTIAL
 *   GET  /api/evidence                  本地页：证据列表与上送状态（会话）
 *   GET  /api/evidence/:id/file         取文件（服务票据或会话；支持 Range，视频可拖动）；本地已清回 410 + 索引现状
 *   POST /api/evidence/:id/upload       让 EG 把这一条的文件传到子站（服务票据或维护会话） */
import { BadRequestException, Body, Controller, ForbiddenException, Get, GoneException, Headers, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuditService } from '../audit/audit.service.js'
import { AuthService } from '../auth/auth.service.js'
import { ClientIp, Public } from '../auth/guard.js'
import { EvidenceService, type LockRequest } from './evidence.service.js'

@Controller('api/evidence')
export class EvidenceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** 服务票据或本地会话；needMaint = 会话要维护角色 */
  private who(req: Request, needMaint: boolean): string {
    const ticket = req.headers['x-eg-ticket'] as string | undefined
    if (ticket) {
      const c = this.auth.verifyService(ticket)
      if ('error' in c) throw new UnauthorizedException({ code: 'bad_ticket', message: c.error })
      return `子站 ${c.n}`
    }
    const h = req.headers.authorization
    const s = this.auth.session(h?.startsWith('Bearer ') ? h.slice(7) : undefined)
    if (!s) throw new UnauthorizedException({ code: 'no_session', message: '未登录或会话已过期' })
    if (needMaint && s.role !== 'maint') throw new ForbiddenException({ code: 'no_permission', message: '只读账号不能做这项操作' })
    return s.name
  }

  @Public()
  @Put('lock')
  @HttpCode(200)
  async lock(@Headers('x-eg-ticket') ticket: string | undefined, @Body() body: LockRequest, @ClientIp() ip: string) {
    const c = this.auth.verifyService(ticket)
    if ('error' in c) throw new UnauthorizedException({ code: 'bad_ticket', message: c.error })
    const start = Number(body?.start)
    const end = Number(body?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new BadRequestException({ code: 'bad_request', message: 'start / end 要是毫秒、且 end > start' })
    const r = await this.evidence.lock({ ...body, start, end })
    this.audit.write({ user: c.u, name: c.n, via: 'sp', ip, action: '子站锁定证据', target: `${body.eventId ?? body.requestId ?? ''} ${new Date(start).toISOString()}–${new Date(end).toISOString()}`, ok: true, detail: `${r.status}，${r.evidenceIds.length} 条` })
    return r
  }

  @Get()
  list(@Query('limit') limit?: string) {
    return { status: this.evidence.status(), items: this.evidence.list(Math.min(500, Math.max(1, Number(limit) || 200))) }
  }

  @Public()
  @Get(':id/file')
  file(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    this.who(req, false)
    const f = this.evidence.fileOf(id)
    if (!f) throw new NotFoundException(`没有证据 ${id}`)
    if ('gone' in f) throw new GoneException({ code: 'gone', message: '本地副本已清理', status: f.gone.status, location: f.gone.location })
    res.setHeader('X-Sha256', f.row.sha256 ?? '')
    res.sendFile(f.path, { headers: { 'Content-Type': f.type }, acceptRanges: true })
  }

  @Public()
  @Post(':id/upload')
  @HttpCode(200)
  upload(@Param('id') id: string, @Req() req: Request) {
    this.who(req, true)
    const r = this.evidence.requestUpload(id)
    if (!r) throw new NotFoundException(`没有证据 ${id}`)
    return { evidenceId: id, status: r.status, uploadWanted: true }
  }
}
