/* 配置查看与本地配置修改（开发计划 §6.2 配置归属）：
 *   eg.yaml（子站下发）只读看，访问令牌打码；
 *   local.yaml 能在页面上改的只有：对时服务器、上行网口、摄像机（地址、账号、各路 RTSP）。
 *   总线 / Edge 地址、容器名、管理页端口改错了本地页自己就打不开或失联，不给页面改，要改到 EG 上改文件。 */
import { Body, Controller, Get, Inject, Put } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator'
import { saveLocal, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { ClientIp, CurrentSession, Maint } from '../auth/guard.js'
import type { Session } from '../auth/auth.service.js'

class RtspDto {
  @IsOptional() @IsString() @MaxLength(512) visible?: string
  @IsOptional() @IsString() @MaxLength(512) thermal?: string
  @IsOptional() @IsString() @MaxLength(512) visibleSub?: string
  @IsOptional() @IsString() @MaxLength(512) thermalSub?: string
}
class CameraDto {
  @IsOptional() @IsString() @MaxLength(512) onvif?: string
  @IsOptional() @IsString() @MaxLength(64) user?: string
  /** 不传 = 不改（页面上不回显口令） */
  @IsOptional() @IsString() @MaxLength(128) password?: string
  @IsOptional() @ValidateNested() @Type(() => RtspDto) rtsp?: RtspDto
}
class LocalPatchDto {
  @IsOptional() @IsString() @MaxLength(255) ntpServer?: string
  @IsOptional() @IsString() @MaxLength(32) uplinkIface?: string
  @IsOptional() @ValidateNested() @Type(() => CameraDto) camera?: CameraDto
}

const mask = (s: string) => (s ? `已设置（${s.length} 位）` : '')

@Controller('api/config')
export class ConfigController {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly audit: AuditService,
  ) {}

  @Get()
  get() {
    const c = this.cfg
    return {
      eg: {
        generatedAt: c.generatedAt,
        station: c.station,
        sp: c.sp,
        cabinet: c.cabinet,
        eg: { name: c.eg.name, token: mask(c.eg.token), attrs: c.eg.attrs },
        devices: c.devices,
      },
      local: {
        ...c.local,
        edgeDb: c.local.edgeDb.replace(/:\/\/([^:@]+):[^@]*@/, '://$1:***@'),
        camera: { ...c.local.camera, password: c.local.camera.password ? '已设置' : '' },
      },
      editable: ['ntpServer', 'uplinkIface', 'camera'],
    }
  }

  @Maint()
  @Put('local')
  patch(@Body() b: LocalPatchDto, @CurrentSession() s: Session, @ClientIp() ip: string) {
    const l = this.cfg.local
    const changed: string[] = []
    const set = <T>(label: string, cur: T, next: T | undefined, apply: (v: T) => void) => {
      if (next === undefined || next === cur) return
      apply(next)
      changed.push(label)
    }
    set('对时服务器', l.ntp.server, b.ntpServer?.trim(), v => (l.ntp.server = v))
    set('上行网口', l.net.uplink, b.uplinkIface?.trim(), v => (l.net.uplink = v))
    if (b.camera) {
      const cam = b.camera
      set('摄像机 ONVIF 地址', l.camera.onvif, cam.onvif?.trim(), v => (l.camera.onvif = v))
      set('摄像机账号', l.camera.user, cam.user?.trim(), v => (l.camera.user = v))
      if (cam.password !== undefined && cam.password !== '') set('摄像机口令', l.camera.password, cam.password, v => (l.camera.password = v))
      for (const k of ['visible', 'thermal', 'visibleSub', 'thermalSub'] as const) set(`RTSP ${k}`, l.camera.rtsp[k], cam.rtsp?.[k]?.trim(), v => (l.camera.rtsp[k] = v))
    }
    if (changed.length) {
      // 本进程里的配置对象是共享的：对时服务器、上行网口下一次采样就生效；摄像机由 eg-video 读文件（G4）
      saveLocal(l, this.cfg.dir)
      this.audit.write({ user: s.user, name: s.name, via: s.via, ip, action: '改本地配置', target: 'local.yaml', ok: true, detail: changed.join('、') })
    }
    return { ok: true, changed }
  }
}
