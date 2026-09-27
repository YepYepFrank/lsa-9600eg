/* 趋势（eg-ui-v2）：GET /api/history?device=<设备名>&keys=a,b,c[&hours=24][&points=288][&agg=AVG|MAX|MIN|NONE]
 * 从 EG 本地 TB 取遥测（本地只留 7 天），按需降采样：区间 / points 为一桶，桶内取 agg（缺省 AVG）；agg=NONE 原样取（事件型量，如 uv.pulse）。
 * 回 { device, from, to, intervalMs, agg, series: { key: [[ts, value], …] } }；数值型转 number，JSON 串（uv.pulse）原样给字符串。
 * 设备只认本机清单里的（下挂设备 + EG 自己），key 只许字母数字点下划线，一次最多 12 个。 */
import { BadRequestException, Controller, Get, Inject, NotFoundException, Query, ServiceUnavailableException } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { LocalTbService } from '../tb/local-tb.service.js'

const AGGS = new Set(['AVG', 'MAX', 'MIN', 'SUM', 'COUNT', 'NONE'])
const KEY = /^[A-Za-z0-9._]{1,64}$/

@Controller('api')
export class HistoryController {
  private readonly ids = new Map<string, string>()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly tb: LocalTbService,
  ) {}

  @Get('history')
  async history(@Query('device') device?: string, @Query('keys') keysQ?: string, @Query('hours') hoursQ?: string, @Query('points') pointsQ?: string, @Query('agg') aggQ?: string) {
    const known = [this.cfg.eg.name, ...this.cfg.devices.map(d => d.name)]
    if (!device || !known.includes(device)) throw new NotFoundException({ code: 'no_device', message: `没有设备 ${device ?? ''}（本机：${known.join('、')}）` })
    const keys = (keysQ ?? '').split(',').map(k => k.trim()).filter(Boolean)
    if (!keys.length || keys.length > 12 || !keys.every(k => KEY.test(k))) throw new BadRequestException({ code: 'bad_keys', message: 'keys 要 1–12 个，只许字母、数字、点、下划线' })
    const hours = Math.min(168, Math.max(0.1, Number(hoursQ) || 24))
    const points = Math.min(2000, Math.max(10, Math.round(Number(pointsQ) || 288)))
    const agg = (aggQ ?? 'AVG').toUpperCase()
    if (!AGGS.has(agg)) throw new BadRequestException({ code: 'bad_agg', message: `agg 取 ${[...AGGS].join(' / ')}` })
    if (!this.tb.available) throw new ServiceUnavailableException({ code: 'no_tb', message: 'eg.yaml 里没有本地 TB 账号，取不了历史' })

    const to = Date.now()
    const from = to - Math.round(hours * 3_600_000)
    // TB 的 interval 至少 1 s；取整到秒，桶数不超过 points
    const intervalMs = Math.max(1000, Math.ceil((to - from) / points / 1000) * 1000)
    const id = await this.idOf(device)
    const q = new URLSearchParams({ keys: keys.join(','), startTs: String(from), endTs: String(to), orderBy: 'ASC' })
    if (agg === 'NONE') q.set('limit', '5000')
    else {
      q.set('agg', agg)
      q.set('interval', String(intervalMs))
      q.set('limit', String(points + 10))
    }
    const raw = await this.tb.get<Record<string, { ts: number; value: string }[]>>(`/api/plugins/telemetry/DEVICE/${id}/values/timeseries?${q}`)
    const series: Record<string, [number, number | string][]> = {}
    for (const k of keys)
      series[k] = (raw[k] ?? []).map(p => {
        const n = Number(p.value)
        return [p.ts, p.value !== '' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : p.value]
      })
    return { device, from, to, intervalMs: agg === 'NONE' ? null : intervalMs, agg, series }
  }

  private async idOf(name: string): Promise<string> {
    const hit = this.ids.get(name)
    if (hit) return hit
    const d = await this.tb.get<{ id: { id: string } }>(`/api/tenant/devices?deviceName=${encodeURIComponent(name)}`)
    this.ids.set(name, d.id.id)
    return d.id.id
  }
}
