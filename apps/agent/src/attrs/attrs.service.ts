/* 设备静态属性：子站下发的那部分（eg.yaml 里各设备的 attrs：所在隔室、端口、协议、额定电流等），
 * 由 agent 在连上本机总线时发一次（lsa/<设备名>/attributes，经 IoT Gateway 成为设备的客户端属性）。
 * 以前是子站模拟器发的；交给 EG 端后没人发，新现场的设备就没有这些属性（子站台账、负荷率额定值要用）。
 *
 * 同事的程序只发他知道的（固件版本 fw、实际协议 proto 等），会覆盖同名项 —— 以现场实际为准。
 * EG 自身另加 agent 版本、实际生效的配置版本 cfg、本地 TB 版本 tbVersion（§8.1）；
 * eg.yaml 里的 cfgWant 是子站自己的量（期望版本），EG 不报（I 阶段复测：报了会与子站的期望版本看混）。 */
import { readFileSync } from 'node:fs'
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'
import { ApplyService } from '../apply/apply.service.js'
import { LocalTbService } from '../tb/local-tb.service.js'

/** 发布件版本（如 0.2.0-67da0ec）：镜像里 /app/package.json 由 pack-eg 写成「版本-提交号」；开发时读仓库根的 package.json */
export const AGENT_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  } catch {
    return '0.2.0'
  }
})()

@Injectable()
export class AttrsService implements OnModuleInit {
  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly apply: ApplyService,
    private readonly tb: LocalTbService,
  ) {}

  private tbVersion: string | null = null
  private asking = false

  /** 本地 TB 版本：/api/system/info（租户管理员可读）。本地 TB 常比 agent 起得晚，读不到每分钟再试 */
  private async askTbVersion(): Promise<void> {
    if (this.asking || !this.tb.available) return
    this.asking = true
    try {
      for (let i = 0; i < 60 && !this.tbVersion; i++) {
        try {
          this.tbVersion = (await this.tb.get<{ version: string }>('/api/system/info')).version || null
        } catch {
          await new Promise(r => setTimeout(r, 60_000))
        }
      }
      if (this.tbVersion) this.bus.publishAttributes(this.cfg.eg.name, { tbVersion: this.tbVersion })
    } finally {
      this.asking = false
    }
  }

  onModuleInit(): void {
    this.bus.onConnect(() => {
      for (const d of this.cfg.devices) this.bus.publishAttributes(d.name, d.attrs)
      // egAgentVersion：§8.1 约定的名字；agent 是 G1 时起的旧名，留着给本地页
      // cfg：实际生效的配置版本（I4 应用过就是应用的那一版，§8.1）
      const { cfgWant: _want, ...egAttrs } = this.cfg.eg.attrs
      this.bus.publishAttributes(this.cfg.eg.name, { ...egAttrs, cfg: this.apply.version(), agent: AGENT_VERSION, egAgentVersion: AGENT_VERSION })
      if (this.tbVersion) this.bus.publishAttributes(this.cfg.eg.name, { tbVersion: this.tbVersion })
      else void this.askTbVersion()
    })
  }
}
