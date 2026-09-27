/* eg-video：EG 上的视频扩展服务（用户 2026-09-24 定：视频处理不经 TB，独立服务；G4 约定 docs/G4视频接口约定.md、docs/G4摄像机测温约定.md）。
 *
 * 每面柜一台双目摄像机（可见光 + 热像），接 EG 的 LAN1；摄像机由「驱动」接入（sim 仿真 / onvif / rtsp，真机测温驱动归 H）。
 *   GET  /api/video/status                   四路的来源、探测结果、mediamtx 状态、cam.* 指标、测温与区域
 *   POST /api/video/refresh                  重读 local.yaml、重取流地址、重写 mediamtx 配置（本地页改了摄像机后调）
 *   POST /api/video/snapshot?ch=visible|ir   抓一帧 JPEG（G5 告警抓拍用）；头 X-Snapshot-Ts、X-Snapshot-Via
 * 只听本机（127.0.0.1）：本地管理页经 eg-agent 转过来。
 *
 *   pnpm video                        开发：读仓库下 run/
 *   pnpm -F @lsa-eg/video video:render  只生成 mediamtx 配置（mediamtx 先于 eg-video 起时用） */
import 'reflect-metadata'
import { BadRequestException, Controller, Get, HttpCode, Inject, Logger, Module, Post, Query, Res, ServiceUnavailableException } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { Response } from 'express'
import { VideoService } from './video.service.js'

const SVC = Symbol('VideoService')

@Controller('api/video')
class VideoController {
  constructor(@Inject(SVC) private readonly svc: VideoService) {}

  @Get('status')
  status() {
    return this.svc.status()
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh() {
    await this.svc.refresh()
    await this.svc.probe()
    return this.svc.status()
  }

  @Post('snapshot')
  @HttpCode(200)
  async snapshot(@Query('ch') ch: string, @Res() res: Response) {
    if (ch !== 'visible' && ch !== 'ir') throw new BadRequestException('ch 取 visible 或 ir')
    try {
      const s = await this.svc.snapshot(ch)
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('X-Snapshot-Ts', String(s.ts))
      res.setHeader('X-Snapshot-Via', s.via)
      res.end(s.jpeg)
    } catch (e) {
      throw new ServiceUnavailableException({ code: 'snapshot_failed', message: (e as Error).message })
    }
  }
}

const svc = new VideoService()

@Module({ controllers: [VideoController], providers: [{ provide: SVC, useValue: svc }] })
class VideoModule {}

async function bootstrap() {
  await svc.start()
  const app = await NestFactory.create(VideoModule, { logger: ['log', 'warn', 'error'] })
  const port = Number(process.env['EG_VIDEO_PORT'] ?? 9110)
  await app.listen(port, process.env['EG_VIDEO_HOST'] ?? '127.0.0.1')
  new Logger('eg-video').log(`已启动：http://127.0.0.1:${port}/api/video/status`)
}

bootstrap().catch(e => {
  console.error('eg-video 启动失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
