/* eg-video：EG 上的视频扩展服务（用户 2026-09-24 定：视频处理不经 TB，独立服务）。
 *
 * 每面柜一台双目摄像机（可见光 + 热像，ONVIF），接 EG 的 LAN1。职责（G4 / G5）：
 *   - 按 local.yaml 的摄像机地址（或 ONVIF 查得）生成本机 mediamtx 配置：按需从摄像机拉流，
 *     子站 mediamtx 再按需从 EG 拉 —— 只拉有人在看的那一路；
 *   - 抓帧（告警抓拍用，给 eg-agent 调）；
 *   - 摄像机在线、帧率、码率（cam.* 指标）。
 * G0 只有骨架：GET /api/video/status。 */
import 'reflect-metadata'
import { Controller, Get, Inject, Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { loadConfig, type EgConfig } from '@lsa-eg/config'

const CFG = Symbol('CFG')

@Controller('api/video')
class VideoController {
  constructor(@Inject(CFG) private readonly cfg: EgConfig) {}

  @Get('status')
  status() {
    const cam = this.cfg.local.camera
    return {
      cabinet: this.cfg.cabinet.code,
      camera: this.cfg.devices.find(d => d.kind === 'camera')?.name ?? null,
      onvif: cam.onvif || null,
      configured: !!(cam.onvif || cam.rtsp.visible),
      streams: [],
    }
  }
}

@Module({ controllers: [VideoController], providers: [{ provide: CFG, useFactory: () => loadConfig() }] })
class VideoModule {}

async function bootstrap() {
  const app = await NestFactory.create(VideoModule, { logger: ['log', 'warn', 'error'] })
  const port = Number(process.env['EG_VIDEO_PORT'] ?? 9110)
  await app.listen(port, '0.0.0.0')
  new Logger('eg-video').log(`已启动：http://localhost:${port}/api/video/status`)
}

bootstrap().catch(e => {
  console.error('eg-video 启动失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
