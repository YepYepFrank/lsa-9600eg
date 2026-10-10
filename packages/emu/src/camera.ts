/* 仿真摄像机（G4 摄像机测温约定 §6）：本柜那台双目摄像机的「区域测温 + 四路视频 + 原生报警」。
 *
 *   视频：RTSP 测试源（deploy/dev 的 camera 容器，mediamtx + ffmpeg 按需出画面）；断流经它的 API 把那一路的 runOnDemand 摘掉。
 *   测温：R1–R<n> 与全画面（n = eg.yaml CAM 属性 regions.R<n> 的个数，1–12，缺省 3；I18），用与子站模拟器同一个发生器（@lsa/points 的 camTemps，温升随负荷与日波动变；
 *        AH03 的「6 小时内爬升到越限」照样出现在热点隔室对应的区域上）。
 *   eg-video 的 sim 驱动每 2 s 取 GET /emu/cam/state。
 */
import { camTemps, DEFAULT_REGIONS as SHARED_REGIONS, FRAME as SHARED_FRAME, type CabPlan } from '@lsa/points'

export interface RegionDef {
  name: string
  type: 'point' | 'line' | 'region' | 'polygon'
  coords: Record<string, unknown>
  enabled: boolean
}

export interface CamState {
  online: boolean
  frame: { w: number; h: number }
  streams: Record<'visible' | 'visibleSub' | 'thermal' | 'thermalSub', string | null>
  regions: RegionDef[]
  temps: {
    ts: number
    glob: { max: number; min: number; maxX: number; maxY: number }
    regions: { name: string; max?: number; min?: number; maxX?: number; maxY?: number; pt?: number }[]
  } | null
  alarm: string
}

const FRAME = { ...SHARED_FRAME }
const DEFAULT_REGIONS: RegionDef[] = structuredClone(SHARED_REGIONS)
/** n 个缺省测温区：不超过 3 个用共用的那三个（与子站模拟器一致），更多的按 4 × 3 网格铺满热像画面（I18，最多 12） */
export function defaultRegions(n: number): RegionDef[] {
  if (n <= DEFAULT_REGIONS.length) return structuredClone(DEFAULT_REGIONS.slice(0, Math.max(1, n)))
  const cw = FRAME.w / 4
  const ch = FRAME.h / 3
  return Array.from({ length: Math.min(12, n) }, (_, i) => ({
    name: `R${i + 1}`,
    type: 'region' as const,
    enabled: true,
    coords: { x: Math.round((i % 4) * cw + 10), y: Math.round(Math.floor(i / 4) * ch + 10), width: Math.round(cw - 20), height: Math.round(ch - 20) },
  }))
}
const PATHS = { visible: 'visible', visibleSub: 'visible-sub', thermal: 'thermal', thermalSub: 'thermal-sub' } as const
type Ch = keyof typeof PATHS


export class CameraSim {
  private regions: RegionDef[]
  private readonly off = new Set<Ch>()
  private dead = false
  private alarm = '{}'
  /** 注入过温：区域名 → 保持到何时、多少度 */
  private readonly hot = new Map<string, { until: number; max: number }>()

  constructor(
    private readonly plan: CabPlan,
    private readonly rooms: number,
    /** 摄像机 RTSP 基址（从 EG mediamtx 容器看），如 rtsp://admin:lsa-cam@camera:8554 */
    private readonly rtspBase: string,
    /** 测试源 mediamtx 的 API（断流用），如 http://127.0.0.1:19998 */
    private readonly api: string,
    /** 本柜配了几个测温区（eg.yaml CAM 属性 regions.R<n> 的个数，缺省 3） */
    regionCount = 3,
  ) {
    this.regions = defaultRegions(regionCount)
  }

  state(ts = Date.now()): CamState {
    const streams = Object.fromEntries(
      // 真摄像机不会告诉你哪一路坏了：地址照给，断流只体现在测试源那一路 DESCRIBE 失败
      (Object.keys(PATHS) as Ch[]).map(ch => [ch, `${this.rtspBase}/${PATHS[ch]}`]),
    ) as CamState['streams']
    return { online: !this.dead, frame: FRAME, streams, regions: this.regions, temps: this.dead ? null : this.temps(ts), alarm: this.alarm }
  }

  /** 温度：与子站模拟器同一个发生器（@lsa/points camTemps）；注入的过温在有效期内覆盖区域最高温 */
  private temps(ts: number): NonNullable<CamState['temps']> {
    return camTemps(this.plan.params, this.rooms, this.regions, ts, name => {
      const inj = this.hot.get(name)
      if (inj && inj.until > ts) return inj.max
      if (inj) this.hot.delete(name)
      return undefined
    })
  }

  overtemp(region: string, max: number, s: number): void {
    this.hot.set(region, { until: Date.now() + s * 1000, max })
  }

  setRegions(r: RegionDef[]): void {
    this.regions = r
  }

  setAlarm(state: string): void {
    this.alarm = state
  }

  async setDead(on: boolean): Promise<void> {
    this.dead = on
    for (const ch of Object.keys(PATHS) as Ch[]) await this.patchSource(ch, !on && !this.off.has(ch))
  }

  async setStream(ch: Ch | 'all', on: boolean): Promise<void> {
    for (const c of ch === 'all' ? (Object.keys(PATHS) as Ch[]) : [ch]) {
      if (on) this.off.delete(c)
      else this.off.add(c)
      await this.patchSource(c, on && !this.dead)
    }
  }

  /** 测试源上某一路的出画面命令摘掉 / 恢复：摘掉后对它 DESCRIBE 就是 404，像摄像机那一路坏了 */
  private readonly saved = new Map<Ch, string>()
  private async patchSource(ch: Ch, on: boolean): Promise<void> {
    const name = PATHS[ch]
    try {
      if (!on) {
        if (!this.saved.has(ch)) {
          const cur = (await (await fetch(`${this.api}/v3/config/paths/get/${name}`)).json()) as { runOnDemand?: string }
          if (cur.runOnDemand) this.saved.set(ch, cur.runOnDemand)
        }
        await fetch(`${this.api}/v3/config/paths/patch/${name}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runOnDemand: '' }) })
      } else if (this.saved.has(ch)) {
        await fetch(`${this.api}/v3/config/paths/patch/${name}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runOnDemand: this.saved.get(ch) }) })
        this.saved.delete(ch)
      }
    } catch (e) {
      console.warn(`测试源 ${name} ${on ? '恢复' : '断流'}失败（${this.api} 连不上？）：${(e as Error).message}`)
    }
  }
}

