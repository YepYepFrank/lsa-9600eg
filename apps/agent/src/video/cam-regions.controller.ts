/* 子站「测温区设置」经 agent 写摄像机测温区（0.9.0）。鉴权同配置下发：请求头 X-EG-Ticket 子站服务票据（station，60 s、一次性），不认浏览器会话。
 * 转给只听本机的 eg-video（/api/video/cam-regions*），写摄像机的活还是 eg-video 用它手里的驱动做（摄像机最多 2 个会话，不另外登录）：
 *   GET  /api/cam-regions           摄像机上现在的区（整份原样、写法、全局测温参数）
 *   POST /api/cam-regions/apply     体 { set: [{ n, rect }], disable?: [n], yes? }；写之前的整份备份另存配置目录 cam-regions-backup/<时间>.json（留最近 50 份）
 *   POST /api/cam-regions/restore   体 = 备份（子站存的那份，或 apply 回执里的 backup）：按备份写回
 * 本机审计记子站登录名（票据里的 u / n）。预览（没给 yes）不存备份、不记审计。 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { AuthService } from '../auth/auth.service.js'
import { ClientIp, Public } from '../auth/guard.js'

const BASE = (process.env['EG_VIDEO_URL'] ?? 'http://127.0.0.1:9110').replace(/\/$/, '')
/** 留几份备份 */
const KEEP_BACKUPS = 50

interface Backup {
  at: string
  camera: string
  regions: Record<string, unknown>[]
  glob?: Record<string, unknown>
}

/** eg-video 回的结果（cam-regions.ts ApplyResult / RestoreResult 的公共部分） */
type VideoResult = Record<string, unknown> & { ok?: boolean; error?: string; preview?: boolean; refused?: boolean; backup?: Backup; mismatch?: string[]; written?: number[]; rolledBack?: string }

@Controller('api/cam-regions')
export class CamRegionsController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
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
  private async video(method: 'GET' | 'POST', path: string, body?: unknown): Promise<VideoResult> {
    let r: Response
    try {
      r = await fetch(`${BASE}/api/video/cam-regions${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      })
    } catch (e) {
      throw new ServiceUnavailableException({ code: 'video_down', message: `eg-video 连不上（${BASE}）：${(e as Error).message}` })
    }
    const j = (await r.json().catch(() => ({}))) as VideoResult & { message?: string; code?: string }
    if (!r.ok) throw new HttpException({ code: j.code ?? 'video', message: j.message ?? `eg-video 回 HTTP ${r.status}` }, r.status)
    return j
  }

  /** 备份存 cam-regions-backup/<时间>.json（600），超过 KEEP_BACKUPS 份删最老的；返回文件名 */
  private saveBackup(b: Backup): string | null {
    try {
      const dir = resolve(this.cfg.dir, 'cam-regions-backup')
      mkdirSync(dir, { recursive: true })
      const name = `${b.at.replace(/[:.]/g, '-')}.json`
      writeFileSync(resolve(dir, name), JSON.stringify(b, null, 2) + '\n', { mode: 0o600 })
      const all = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
      for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) unlinkSync(resolve(dir, f))
      return name
    } catch {
      return null
    }
  }

  @Public()
  @Get()
  async current(@Headers('x-eg-ticket') ticket: string | undefined, @ClientIp() ip: string) {
    this.who(ticket, ip, '读摄像机测温区')
    return this.video('GET', '')
  }

  @Public()
  @Post('apply')
  @HttpCode(200)
  async apply(@Headers('x-eg-ticket') ticket: string | undefined, @Body() body: unknown, @ClientIp() ip: string) {
    const w = this.who(ticket, ip, '写摄像机测温区')
    let r: VideoResult
    try {
      r = await this.video('POST', '/apply', body)
    } catch (e) {
      if ((body as { yes?: boolean })?.yes === true) this.audit.write({ ...w, via: 'sp', ip, action: '写摄像机测温区', target: '摄像机测温区', ok: false, detail: (e as Error).message })
      throw e
    }
    if (r.preview || r.refused) return r
    const file = r.backup ? this.saveBackup(r.backup) : null
    const set = ((body as { set?: { n: number; rect: { x: number; y: number; width: number; height: number } }[] })?.set ?? []).map(s => `R${s.n} x${s.rect?.x} y${s.rect?.y} ${s.rect?.width}×${s.rect?.height}`)
    const off = ((body as { disable?: number[] })?.disable ?? []).map(n => `R${n}`)
    this.audit.write({
      ...w,
      via: 'sp',
      ip,
      action: '写摄像机测温区',
      target: '摄像机测温区',
      ok: !!r.ok,
      detail: `${set.join('、')}${off.length ? `；停用 ${off.join('、')}` : ''}${r.error ? `；${r.error}` : ''}${r.rolledBack ? `；按备份写回：${r.rolledBack}` : ''}${r.mismatch?.length ? `；读回不一致：${r.mismatch.join('；')}` : ''}；备份 ${file ?? '（没存下）'}`,
    })
    return { ...r, backupFile: file }
  }

  @Public()
  @Post('restore')
  @HttpCode(200)
  async restore(@Headers('x-eg-ticket') ticket: string | undefined, @Body() body: Backup, @ClientIp() ip: string) {
    const w = this.who(ticket, ip, '恢复摄像机测温区')
    if (!body || !Array.isArray(body.regions)) throw new HttpException({ code: 'bad_backup', message: '体要是备份 { at, camera, regions: [...] }' }, 400)
    let r: VideoResult
    try {
      r = await this.video('POST', '/restore', body)
    } catch (e) {
      this.audit.write({ ...w, via: 'sp', ip, action: '恢复摄像机测温区', target: '摄像机测温区', ok: false, detail: (e as Error).message })
      throw e
    }
    this.audit.write({ ...w, via: 'sp', ip, action: '恢复摄像机测温区', target: '摄像机测温区', ok: !!r.ok, detail: `按备份 ${body.at} 写回 ${r.written?.length ?? 0} 个区${r.error ? `；${r.error}` : ''}${r.mismatch?.length ? `；不一致：${r.mismatch.join('；')}` : ''}` })
    return r
  }
}
