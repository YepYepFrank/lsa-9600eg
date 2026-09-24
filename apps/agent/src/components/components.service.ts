/* 本机各组件的状态、日志与重启（开发计划 G2）。
 *   edge TB Edge、gateway TB IoT Gateway、mosquitto 本机总线、mediamtx 视频（G4 起）—— 容器，经 Docker API
 *   agent 本进程
 * 重启只开放 Edge 与 IoT Gateway（排障最常用、也最安全）；Mosquitto 一停同事的程序与 agent 都断，不给页面上点。 */
import { Inject, Injectable } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { RingLogger } from '../logging/ring-logger.js'
import { dockerCall, dockerJson, demuxLogs } from './docker.js'

export const COMPONENTS = {
  edge: 'TB Edge',
  gateway: 'TB IoT Gateway',
  mosquitto: '本机总线 Mosquitto',
  mediamtx: '视频转发 mediamtx',
} as const
export type ComponentKey = keyof typeof COMPONENTS
export const RESTARTABLE: ComponentKey[] = ['edge', 'gateway']

export interface ComponentState {
  key: ComponentKey | 'agent'
  label: string
  container: string | null
  /** running / exited / restarting / 不存在 / 取不到 */
  state: string
  startedAt: number | null
  restarts: number | null
  memMb: number | null
  cpuPct: number | null
  image: string | null
  restartable: boolean
}

interface Inspect {
  State: { Status: string; StartedAt: string }
  RestartCount: number
  Config: { Image: string }
}
interface Stats {
  memory_stats: { usage?: number; stats?: { inactive_file?: number } }
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number }
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number }
}

const STARTED = Date.now()

@Injectable()
export class ComponentsService {
  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {}

  private get api(): string {
    return process.env['EG_DOCKER_API'] || this.cfg.local.docker.api
  }

  containerOf(key: ComponentKey): string {
    return this.cfg.local.docker.containers[key]
  }

  async list(): Promise<ComponentState[]> {
    const out: ComponentState[] = [
      {
        key: 'agent',
        label: 'eg-agent（本服务）',
        container: null,
        state: 'running',
        startedAt: STARTED,
        restarts: null,
        memMb: Math.round(process.memoryUsage().rss / 1048576),
        cpuPct: null,
        image: null,
        restartable: false,
      },
    ]
    await Promise.all(
      (Object.keys(COMPONENTS) as ComponentKey[]).map(async key => {
        out.push(await this.one(key))
      }),
    )
    const order = ['agent', ...Object.keys(COMPONENTS)]
    return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  }

  async restart(key: ComponentKey): Promise<void> {
    const r = await dockerCall(this.api, 'POST', `/containers/${encodeURIComponent(this.containerOf(key))}/restart?t=10`, 60_000)
    if (r.status >= 400) throw new Error(`重启 ${COMPONENTS[key]} 失败：Docker API ${r.status} ${r.body.toString('utf8').slice(0, 200)}`)
  }

  async logs(key: ComponentKey | 'agent', tail: number): Promise<string[]> {
    if (key === 'agent') return RingLogger.lines.slice(-tail)
    const r = await dockerCall(this.api, 'GET', `/containers/${encodeURIComponent(this.containerOf(key))}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`)
    if (r.status >= 400) throw new Error(`取 ${COMPONENTS[key]} 日志失败：Docker API ${r.status}`)
    return demuxLogs(r.body).split('\n').filter(Boolean)
  }

  private async one(key: ComponentKey): Promise<ComponentState> {
    const container = this.containerOf(key)
    const base: ComponentState = {
      key,
      label: COMPONENTS[key],
      container,
      state: '取不到',
      startedAt: null,
      restarts: null,
      memMb: null,
      cpuPct: null,
      image: null,
      restartable: RESTARTABLE.includes(key),
    }
    try {
      const i = await dockerJson<Inspect>(this.api, `/containers/${encodeURIComponent(container)}/json`)
      base.state = i.State.Status
      base.startedAt = Date.parse(i.State.StartedAt) || null
      base.restarts = i.RestartCount
      base.image = i.Config.Image
      if (i.State.Status === 'running') {
        const s = await dockerJson<Stats>(this.api, `/containers/${encodeURIComponent(container)}/stats?stream=false`)
        const mem = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? 0)
        base.memMb = mem > 0 ? Math.round(mem / 1048576) : null
        const cpu = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
        const sys = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0)
        base.cpuPct = sys > 0 ? Math.round((cpu / sys) * (s.cpu_stats.online_cpus ?? 1) * 1000) / 10 : null
      }
    } catch (e) {
      base.state = /404/.test((e as Error).message) ? '不存在' : '取不到'
    }
    return base
  }
}
