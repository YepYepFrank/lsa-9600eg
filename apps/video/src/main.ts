/* eg-video：EG 上的视频扩展服务（用户 2026-09-24 定：视频处理不经 TB，独立服务；G4 约定 docs/G4视频接口约定.md、docs/G4摄像机测温约定.md）。
 *
 * 每面柜一台双目摄像机（可见光 + 热像），接 EG 的 LAN1；摄像机由「驱动」接入（sim 仿真 / onvif / rtsp，真机测温驱动归 H）。
 *   GET  /api/video/status                   四路的来源、探测结果、mediamtx 状态、cam.* 指标、测温与区域
 *   POST /api/video/refresh                  重读 local.yaml、重取流地址、重写 mediamtx 配置（本地页改了摄像机后调）
 *   POST /api/video/snapshot?ch=visible|ir   抓一帧 JPEG（G5 告警抓拍用）；头 X-Snapshot-Ts、X-Snapshot-Via
 *   GET  /api/video/recording               循环录像覆盖（两路子码流各自最旧 / 最新一段、是否在录）
 *   GET  /api/video/clip?ch=visible|ir&start=&end=   裁一段 MP4（毫秒）；头 X-Actual-Start / End、X-Gap；没有录像回 404 + missingReason
 *   POST /api/video/cam-regions/default?force=1&yes=1&distance=<米>&setGlobal=1  给没画测温区的 restv1 摄像机写缺省 R1–R3（0.8.0，cam-regions.ts）；回备份与核对结果
 *   POST /api/video/cam-regions/probe        在一个没启用的区上试写、读回、马上写回（0.8.1，先验写法）
 *   POST /api/video/cam-regions/disable?ids=5,6&yes=1  停用指定的区（0.8.2；没给 yes 只预览）
 *   POST /api/video/cam-regions/restore      按备份（JSON 体）原样写回
 *   GET  /api/video/cam-regions              摄像机上现在的区（整份原样 + 写法 + 全局测温参数；0.9.0）
 *   POST /api/video/cam-regions/apply        按子站网页画的写（0.9.0）：体 { set: [{ n, rect }], disable?: [n], yes? }；回备份与核对结果
 *   install.sh --cam-regions-* 经 docker exec 调本机；apply / restore / GET 另经 eg-agent 的 /api/cam-regions（子站服务票据）转过来，本地页不转。
 *   写摄像机的几个同一时间只做一个（另一个回 409 busy）：摄像机最多 2 个会话，两个写交错着来备份 / 写回会乱
 * 只听本机（127.0.0.1）：本地管理页经 eg-agent 转过来。
 *
 *   pnpm video                        开发：读仓库下 run/
 *   pnpm -F @lsa-eg/video video:render  只生成 mediamtx 配置（mediamtx 先于 eg-video 起时用） */
import 'reflect-metadata'
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Logger, Module, NotFoundException, Post, Query, Res, ServiceUnavailableException } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { Response } from 'express'
import { VideoService } from './video.service.js'
import { MissingError } from './recording.js'
import { applyDefaultRegions, applyRegions, disableRegions, probeRegions, readRegions, restoreRegions, type Backup, type RegionSpec } from './cam-regions.js'

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

  @Get('recording')
  async recording() {
    // 没配摄像机：不是「录像断了」，ok 给 null（agent 就不报 eg.rec_ok），configured: false
    if (!this.svc.hasCamera()) return { ok: null, configured: false, ringHours: this.svc.cfg.local.evidence.ringHours, paths: [] }
    const ring = await this.svc.recording.ring()
    return { ok: ring.every(r => r.recording), configured: true, ringHours: this.svc.cfg.local.evidence.ringHours, paths: ring }
  }

  @Get('clip')
  async clip(@Query('ch') ch: string, @Query('start') start: string, @Query('end') end: string, @Res() res: Response) {
    if (ch !== 'visible' && ch !== 'ir') throw new BadRequestException('ch 取 visible 或 ir')
    const s = Number(start)
    const e = Number(end)
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new BadRequestException('start / end 要是毫秒、且 end > start')
    if (!this.svc.hasCamera()) throw new NotFoundException({ code: 'missing', missingReason: 'no_camera', message: '本机没有配摄像机（local.yaml 摄像机一段没有地址）' })
    try {
      const c = await this.svc.recording.clip(ch, s, e)
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('X-Actual-Start', String(c.actualStart))
      res.setHeader('X-Actual-End', String(c.actualEnd))
      res.setHeader('X-Gap', c.gap ? '1' : '0')
      res.end(c.mp4)
    } catch (err) {
      if (err instanceof MissingError) throw new NotFoundException({ code: 'missing', missingReason: err.reason, message: err.message })
      throw new ServiceUnavailableException({ code: 'clip_failed', message: (err as Error).message })
    }
  }
}

@Controller('api/video/cam-regions')
class CamRegionsController {
  constructor(@Inject(SVC) private readonly svc: VideoService) {}

  private driver() {
    const d = this.svc.restv1()
    if (!d) throw new ConflictException({ code: 'not_restv1', message: `摄像机驱动是 ${this.svc.cfg.local.camera.driver}：只有 restv1 真机能写测温区` })
    return d
  }

  /** 正在写摄像机的操作（null = 没有） */
  private busy: string | null = null

  /** 写摄像机的操作排它：已经有一个在写回 409 */
  private async exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ConflictException({ code: 'busy', message: `摄像机正在${this.busy}，稍后再试` })
    this.busy = what
    try {
      return await fn()
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof ConflictException) throw e
      throw new ServiceUnavailableException({ code: 'camera', message: (e as Error).message })
    } finally {
      this.busy = null
    }
  }

  @Get()
  async current() {
    const d = this.driver()
    try {
      return { ...(await readRegions(d)), camera: this.svc.cfg.local.camera.restv1, busy: this.busy }
    } catch (e) {
      throw new ServiceUnavailableException({ code: 'camera', message: (e as Error).message })
    }
  }

  @Post('apply')
  @HttpCode(200)
  async apply(@Body() b: { set?: RegionSpec[]; disable?: number[]; yes?: boolean }) {
    const d = this.driver()
    if (!b || !Array.isArray(b.set) || (b.disable !== undefined && !Array.isArray(b.disable))) throw new BadRequestException('体要是 { set: [{ n, rect: { x, y, width, height } }], disable?: [n], yes? }')
    const set = b.set.map(s => ({ n: Number(s?.n), rect: { x: Number(s?.rect?.x), y: Number(s?.rect?.y), width: Number(s?.rect?.width), height: Number(s?.rect?.height) } }))
    return this.exclusive('写测温区', () => applyRegions(d, { set, disable: (b.disable ?? []).map(Number), yes: b.yes === true, camera: this.svc.cfg.local.camera.restv1 }))
  }

  @Post('default')
  @HttpCode(200)
  async applyDefault(@Query('force') force?: string, @Query('yes') yes?: string, @Query('setGlobal') setGlobal?: string, @Query('distance') distance?: string) {
    const d = this.driver()
    const dist = distance === undefined || distance === '' ? undefined : Number(distance)
    if (dist !== undefined && !(dist > 0 && dist <= 1000)) throw new BadRequestException(`距离 ${distance} 不对：要在 (0, 1000] 米之间`)
    return this.exclusive('写缺省测温区', () => applyDefaultRegions(d, { force: force === '1', yes: yes === '1', setGlobal: setGlobal === '1', distance: dist, camera: this.svc.cfg.local.camera.restv1 }))
  }

  @Post('disable')
  @HttpCode(200)
  async disable(@Query('ids') ids?: string, @Query('yes') yes?: string) {
    const d = this.driver()
    const list = String(ids ?? '').split(',').filter(Boolean).map(Number)
    return this.exclusive('停用测温区', () => disableRegions(d, { ids: list, yes: yes === '1', camera: this.svc.cfg.local.camera.restv1 }))
  }

  @Post('probe')
  @HttpCode(200)
  async probe() {
    const d = this.driver()
    return this.exclusive('试写测温区', () => probeRegions(d, { camera: this.svc.cfg.local.camera.restv1 }))
  }

  @Post('restore')
  @HttpCode(200)
  async restore(@Body() b: Backup) {
    const d = this.driver()
    return this.exclusive('恢复测温区', () => restoreRegions(d, b, { camera: this.svc.cfg.local.camera.restv1 }))
  }
}

const svc = new VideoService()

@Module({ controllers: [VideoController, CamRegionsController], providers: [{ provide: SVC, useValue: svc }] })
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
