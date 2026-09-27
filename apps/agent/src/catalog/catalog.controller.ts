/* GET /api/catalog —— 本柜各设备该有哪些测点（名称、单位、周期），实时数据页按它列、按它判「缺了哪些」。
 * 来源是 @lsa/points 的点表目录（= 接入规范 §6），与质量码看护用的同一份。 */
import { Controller, Get, Inject } from '@nestjs/common'
import { CATALOG, SOUTH, periodMs, pointsOf } from '@lsa/points'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

const toRow = (p: { key: string; label: string; unit: string; period: string; optional?: boolean; json?: boolean }) => ({
  key: p.key,
  label: p.label,
  unit: p.unit,
  periodMs: periodMs(p.period as never),
  optional: !!p.optional,
  json: !!p.json,
})

@Controller('api')
export class CatalogController {
  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {}

  @Get('catalog')
  catalog() {
    const g = this.cfg.cabinet.group
    const devices: Record<string, ReturnType<typeof toRow>[]> = {}
    for (const d of this.cfg.devices) devices[d.name] = pointsOf(d.kind, g, true).map(toRow)
    devices[this.cfg.eg.name] = CATALOG.eg.map(toRow)
    return {
      devices,
      // 各设备都可能有的：南向统计与质量码（agent 算的）
      common: [...SOUTH.map(toRow), { key: 'q', label: '质量码', unit: '', periodMs: 60_000, optional: false, json: true }],
      derived: ['el.load_pct', 'q', ...SOUTH.map(p => p.key)],
    }
  }
}
