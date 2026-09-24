/* 设备静态属性：子站下发的那部分（eg.yaml 里各设备的 attrs：所在隔室、端口、协议、额定电流等），
 * 由 agent 在连上本机总线时发一次（lsa/<设备名>/attributes，经 IoT Gateway 成为设备的客户端属性）。
 * 以前是子站模拟器发的；交给 EG 端后没人发，新现场的设备就没有这些属性（子站台账、负荷率额定值要用）。
 *
 * 同事的程序只发他知道的（固件版本 fw、实际协议 proto 等），会覆盖同名项 —— 以现场实际为准。
 * EG 自身另加 agent 版本 agent。 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'

const AGENT_VERSION = '0.1.0'

@Injectable()
export class AttrsService implements OnModuleInit {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
  ) {}

  onModuleInit(): void {
    this.bus.onConnect(() => {
      for (const d of this.cfg.devices) this.bus.publishAttributes(d.name, d.attrs)
      this.bus.publishAttributes(this.cfg.eg.name, { ...this.cfg.eg.attrs, agent: AGENT_VERSION })
    })
  }
}
