/* 子站「测温区设置」经 agent 写摄像机测温区（0.8.4）。鉴权同配置下发：请求头 X-EG-Ticket 子站服务票据（station，60 s、一次性），不认浏览器会话。
 * 转给只听本机的 eg-video（/api/video/cam-regions*），写摄像机的活还是 eg-video 用它手里的驱动做（摄像机最多 2 个会话，不另外登录）：
 *   GET  /api/cam-regions           摄像机上现在的区（整份原样、写法、全局测温参数）
 *   POST /api/cam-regions/apply     体 { set: [{ n, rect }], disable?: [n], yes? }；eg-video 写之前把整份备份存到配置目录 cam-regions-backup/（回执 backupFile）
 *   POST /api/cam-regions/restore   体 { backup, ids?, skipGlob? }（直接给备份也认）：按备份写回；eg-video 写之前先把现在的样子也存一份（回执 backup / backupFile）
 * 本机审计记子站登录名（票据里的 u / n）。预览（没给 yes）不记审计。
 * 超时分级（审查 3）：eg-video 写 12 个区 + 写法探测 + 出错写回 + 读回 + 等温度，最坏约 4 分钟（驱动单次 6 s）；agent 等它 VIDEO_TIMEOUT_MS，
 *   子站等 agent 更久（后端 cam-regions.service.ts EG_TIMEOUT_MS）—— 外层不会先放弃、把已经写成的当成失败。 */
import { Body, Controller, Get, Headers, HttpCode, HttpException, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { AuditService } from '../audit/audit.service.js'
import { AuthService } from '../auth/auth.service.js'
import { ClientIp, Public } from '../auth/guard.js'

const BASE = (process.env['EG_VIDEO_URL'] ?? 'http://127.0.0.1:9110').replace(/\/$/, '')
/** agent 等 eg-video 写摄像机最多多久（读当前那个短得多） */
export const VIDEO_TIMEOUT_MS = 240_000
const READ_TIMEOUT_MS = 20_000

interface Backup {
  at: string
  camera: string
  regions: Record<string, unknown>[]
  glob?: Record<string, unknown>
}

/** eg-video 回的结果（cam-regions.ts ApplyResult / RestoreResult 的公共部分） */
type VideoResult = Record<string, unknown> & { ok?: boolean; error?: string; preview?: boolean; refused?: boolean; backup?: Backup; backupFile?: string | null; mismatch?: string[]; written?: number[]; rolledBack?: string }

@Controller('api/cam-regions')
export class CamRegionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  private who(ticket: string | undefined, ip: string, action: string) {
    const c = this.auth.verifyService(ticket)
    if ('error' in c) {
      this.audit.write({ user: '?', name: '?', via: 'sp', ip, action, target: '摄像机测温区', ok: false, detail: c.error })
      throw new UnauthorizedException({ code: c.code, message: c.error })
    }
    return { user: c.u, name: c.n || c.u }
  }

  /** 转 eg-video；它回的 4xx / 5xx 原样带状态码和说法回去（409 busy、409 not_restv1、503 camera） */
  private async video(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<VideoResult> {
    let r: Response
    try {
      r = await fetch(`${BASE}/api/video/cam-regions${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new ServiceUnavailableException({ code: 'video_down', message: `eg-video 连不上或超时（${BASE}）：${(e as Error).message}；写到一半的话备份在 EG 配置目录 cam-regions-backup/` })
    }
    const j = (await r.json().catch(() => null)) as (VideoResult & { message?: string; code?: string }) | null
    if (!r.ok) throw new HttpException({ code: j?.code ?? 'video', message: j?.message ?? `eg-video 回 HTTP ${r.status}` }, r.status)
    if (!j || typeof j !== 'object') throw new HttpException({ code: 'video_bad', message: 'eg-video 回的不是 JSON' }, 502)
    return j
  }

  @Public()
  @Get()
  async current(@Headers('x-eg-ticket') ticket: string | undefined, @ClientIp() ip: string) {
    this.who(ticket, ip, '读摄像机测温区')
    return this.video('GET', '', undefined, READ_TIMEOUT_MS)
  }

  @Public()
  @Post('apply')
  @HttpCode(200)
  async apply(@Headers('x-eg-ticket') ticket: string | undefined, @Body() body: unknown, @ClientIp() ip: string) {
    const w = this.who(ticket, ip, '写摄像机测温区')
    let r: VideoResult
    try {
      r = await this.video('POST', '/apply', body, VIDEO_TIMEOUT_MS)
    } catch (e) {
      if ((body as { yes?: boolean })?.yes === true) this.audit.write({ ...w, via: 'sp', ip, action: '写摄像机测温区', target: '摄像机测温区', ok: false, detail: (e as Error).message })
      throw e
    }
    if (r.preview || r.refused) return r
    const set = ((body as { set?: { n: number; rect: { x: number; y: number; width: number; height: number } }[] })?.set ?? []).map(s => `R${s.n} x${s.rect?.x} y${s.rect?.y} ${s.rect?.width}×${s.rect?.height}`)
    const off = ((body as { disable?: number[] })?.disable ?? []).map(n => `R${n}`)
    this.audit.write({
      ...w,
      via: 'sp',
      ip,
      action: '写摄像机测温区',
      target: '摄像机测温区',
      ok: !!r.ok,
      detail: `${set.join('、')}${off.length ? `；停用 ${off.join('、')}` : ''}${r.error ? `；${r.error}` : ''}${r.rolledBack ? `；按备份写回：${r.rolledBack}` : ''}${r.mismatch?.length ? `；读回不一致：${r.mismatch.join('；')}` : ''}；备份 ${r.backupFile ?? '（没写摄像机）'}`,
    })
    return r
  }

  @Public()
  @Post('restore')
  @HttpCode(200)
  async restore(@Headers('x-eg-ticket') ticket: string | undefined, @Body() body: Backup | { backup: Backup; ids?: number[]; skipGlob?: boolean }, @ClientIp() ip: string) {
    const w = this.who(ticket, ip, '恢复摄像机测温区')
    const b = body && typeof body === 'object' && 'backup' in body ? body.backup : (body as Backup)
    if (!b || !Array.isArray(b.regions)) throw new HttpException({ code: 'bad_backup', message: '体要是 { backup: { at, camera, regions }, ids?, skipGlob? }（直接给备份也认）' }, 400)
    let r: VideoResult
    try {
      r = await this.video('POST', '/restore', body, VIDEO_TIMEOUT_MS)
    } catch (e) {
      this.audit.write({ ...w, via: 'sp', ip, action: '恢复摄像机测温区', target: '摄像机测温区', ok: false, detail: (e as Error).message })
      throw e
    }
    this.audit.write({ ...w, via: 'sp', ip, action: '恢复摄像机测温区', target: '摄像机测温区', ok: !!r.ok, detail: `按备份 ${b.at} 写回 ${r.written?.length ?? 0} 个区${r.error ? `；${r.error}` : ''}${r.mismatch?.length ? `；不一致：${r.mismatch.join('；')}` : ''}；写回之前的样子存在 ${r.backupFile ?? '?'}` })
    return r
  }
}
