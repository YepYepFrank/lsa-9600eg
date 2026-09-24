/* EG 自身指标 eg.*（接入规范 §6.5），每 5 s 发到本机总线 lsa/EG-<柜号>/telemetry，
 * 由 IoT Gateway 的自定义连接器经网关自己的会话上送（deploy/tb-gateway/extensions/lsa）。
 *
 * 子站靠 EG 设备的数据判「在线」、判 Edge 是否卡住，所以这一路不能停。
 * G0 先发取得到的：CPU、内存、存储、状态；到子站时延 / 丢包、对时偏差、机内温度、上行流量、eg.state 的降级判断在 G1。 */
import { statfsSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService } from '../bus/bus.service.js'

/** 规范的 EG 档：5 s */
const PERIOD_MS = 5_000

@Injectable()
export class SelfService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null
  private lastCpu = cpuTimes()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.bus.publish(this.cfg.eg.name, this.sample()), PERIOD_MS)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  sample(): Record<string, unknown> {
    const now = cpuTimes()
    const busy = now.busy - this.lastCpu.busy
    const all = now.all - this.lastCpu.all
    this.lastCpu = now
    return {
      'eg.state': 'online',
      'eg.cpu': all > 0 ? round((busy / all) * 100) : 0,
      'eg.mem': round((1 - freemem() / totalmem()) * 100),
      'eg.ssd': diskUsedPct(this.cfg.dir),
    }
  }
}

function cpuTimes(): { busy: number; all: number } {
  let busy = 0
  let all = 0
  for (const c of cpus()) {
    const t = c.times
    const sum = t.user + t.nice + t.sys + t.idle + t.irq
    all += sum
    busy += sum - t.idle
  }
  return { busy, all }
}

/** 数据所在分区的占用 %（EG 上是 SSD） */
function diskUsedPct(path: string): number | null {
  try {
    const s = statfsSync(path)
    return round((1 - s.bavail / s.blocks) * 100)
  } catch {
    return null
  }
}

const round = (v: number) => Math.round(v * 10) / 10
