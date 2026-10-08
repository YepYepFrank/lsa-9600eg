/* IoT Gateway 配置跟着能力清单走（阶段 A v1.2，协调会话 2026-10-08）：
 *   能力全都是 unsupported 的设备不订阅 → 不进 EG 本地 TB；有 pending 的照常进（现场调试先看真实读数）。
 * 启动时（main.ts 先按全部设备生成一份，这里按已应用的能力清单再生成）与能力清单变了时重新生成；
 * 文件没变不写。IoT Gateway 每 60 s 查一次连接器配置，变了自己重载。 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { CapsService } from '../caps/caps.service.js'
import { renderGatewayConfig } from './render.js'

@Injectable()
export class GatewayConfigService implements OnModuleInit {
  private readonly log = new Logger('IoT Gateway 配置')
  private skipped = ''

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly caps: CapsService,
  ) {}

  onModuleInit(): void {
    this.render()
    this.caps.onChange(() => this.render())
  }

  /** 现在不进本地 TB 的设备（本地页、状态接口用） */
  notLocal(): string[] {
    return this.cfg.devices.map(d => d.name).filter(n => !this.caps.deviceLocal(n))
  }

  private render(): void {
    const skip = this.notLocal()
    try {
      const r = renderGatewayConfig(this.cfg, undefined, n => skip.includes(n))
      const key = skip.join(',')
      if (r.changed.length || key !== this.skipped) {
        this.log.log(skip.length ? `不进本地 TB（能力全都不具备）：${skip.join('、')}；IoT Gateway 约 60 s 内重载` : `全部下挂设备进本地 TB${r.changed.length ? '（IoT Gateway 约 60 s 内重载）' : ''}`)
      }
      this.skipped = key
    } catch (e) {
      this.log.error(`生成 IoT Gateway 配置失败：${(e as Error).message}`)
    }
  }
}
