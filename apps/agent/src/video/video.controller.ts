/* 本地管理页看视频与测温：转给 eg-video（它只听本机 127.0.0.1:9110，G4）。
 *   GET  /api/video/status             四路、驱动、mediamtx、测温与区域（eg-video 不在时 available=false）
 *   POST /api/video/refresh            （维护）重取流地址、重写 mediamtx 配置
 *   POST /api/video/snapshot?ch=…      抓一帧 JPEG */
import { BadRequestException, Controller, Get, HttpCode, Injectable, Post, Query, Res, ServiceUnavailableException } from '@nestjs/common'
import type { Response } from 'express'
import { Maint } from '../auth/guard.js'

const BASE = (process.env['EG_VIDEO_URL'] ?? 'http://127.0.0.1:9110').replace(/\/$/, '')

@Injectable()
export class VideoClient {
  async status(timeoutMs = 2000): Promise<Record<string, unknown> & { available: boolean; error?: string }> {
    try {
      const r = await fetch(`${BASE}/api/video/status`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) return { available: false, error: `eg-video 回 ${r.status}` }
      return { available: true, ...((await r.json()) as Record<string, unknown>) }
    } catch (e) {
      return { available: false, error: `eg-video 连不上（${BASE}）：${(e as Error).cause ? String((e as Error).cause) : (e as Error).message}` }
    }
  }

  /** 摄像机配置改了：让 eg-video 重读（它不在就算了，起来时会读） */
  async refresh(): Promise<boolean> {
    try {
      return (await fetch(`${BASE}/api/video/refresh`, { method: 'POST', signal: AbortSignal.timeout(20_000) })).ok
    } catch {
      return false
    }
  }
}

@Controller('api/video')
export class VideoController {
  constructor(private readonly video: VideoClient) {}

  @Get('status')
  status() {
    return this.video.status()
  }

  @Maint()
  @Post('refresh')
  @HttpCode(200)
  async refresh() {
    if (!(await this.video.refresh())) throw new ServiceUnavailableException('eg-video 没响应')
    return this.video.status()
  }

  @Post('snapshot')
  @HttpCode(200)
  async snapshot(@Query('ch') ch: string, @Res() res: Response) {
    if (ch !== 'visible' && ch !== 'ir') throw new BadRequestException('ch 取 visible 或 ir')
    let r: globalThis.Response
    try {
      r = await fetch(`${BASE}/api/video/snapshot?ch=${ch}`, { method: 'POST', signal: AbortSignal.timeout(20_000) })
    } catch (e) {
      throw new ServiceUnavailableException(`eg-video 连不上：${(e as Error).message}`)
    }
    if (!r.ok) throw new ServiceUnavailableException(((await r.json().catch(() => ({}))) as { message?: string }).message ?? `抓帧失败（${r.status}）`)
    res.setHeader('Content-Type', 'image/jpeg')
    for (const h of ['x-snapshot-ts', 'x-snapshot-via']) {
      const v = r.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    res.end(Buffer.from(await r.arrayBuffer()))
  }
}
