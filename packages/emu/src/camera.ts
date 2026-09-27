/* 仿真摄像机（G4 摄像机测温约定 §6）：本柜那台双目摄像机的「区域测温 + 四路视频 + 原生报警」。
 *
 *   视频：RTSP 测试源（deploy/dev 的 camera 容器，mediamtx + ffmpeg 按需出画面）；断流经它的 API 把那一路的 runOnDemand 摘掉。
 *   测温：R1–R3 与全画面，用与子站模拟器同一套发生器（@lsa/points 的 samTmax / envT，温升随负荷与日波动变；
 *        AH03 的「6 小时内爬升到越限」照样出现在热点隔室对应的区域上）。
 *   eg-video 的 sim 驱动每 2 s 取 GET /emu/cam/state。
 *
 * 区域温度的算法先放在这里；子站模拟器也要按区域出（后端），到时挪进 @lsa/points 共用。 */
import { gen as g, type CabPlan } from '@lsa/points'

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

const FRAME = { w: 640, h: 512 }
const DEFAULT_REGIONS: RegionDef[] = [
  { name: 'R1', type: 'region', enabled: true, coords: { x: 50, y: 90, width: 160, height: 150 } },
  { name: 'R2', type: 'region', enabled: true, coords: { x: 240, y: 90, width: 160, height: 150 } },
  { name: 'R3', type: 'region', enabled: true, coords: { x: 430, y: 90, width: 160, height: 150 } },
]
const PATHS = { visible: 'visible', visibleSub: 'visible-sub', thermal: 'thermal', thermalSub: 'thermal-sub' } as const
type Ch = keyof typeof PATHS

const frac = (x: number) => x - Math.floor(x)
const r1 = (v: number) => Math.round(v * 10) / 10

export class CameraSim {
  private regions: RegionDef[] = structuredClone(DEFAULT_REGIONS)
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
  ) {}

  state(ts = Date.now()): CamState {
    const streams = Object.fromEntries(
      // 真摄像机不会告诉你哪一路坏了：地址照给，断流只体现在测试源那一路 DESCRIBE 失败
      (Object.keys(PATHS) as Ch[]).map(ch => [ch, `${this.rtspBase}/${PATHS[ch]}`]),
    ) as CamState['streams']
    return { online: !this.dead, frame: FRAME, streams, regions: this.regions, temps: this.dead ? null : this.temps(ts), alarm: this.alarm }
  }

  private temps(ts: number): NonNullable<CamState['temps']> {
    const p = this.plan.params
    const env = g.envT(p, ts)
    const out: NonNullable<CamState['temps']>['regions'] = []
    let gmax = -Infinity
    let gmin = Infinity
    let gx = 0
    let gy = 0
    this.regions.forEach((r, i) => {
      if (!r.enabled) return
      const seed = g.hash(`${p.code}|R${i + 1}`)
      // hash 是整数，frac(整数 × k) 恒为 0：先归一到 0–1
      const u = (seed >>> 0) / 4294967296
      // 区域 i 对着第 i 个隔室（隔室少于 3 个时轮流）；同一隔室的第二个区域温升再打个折
      const room = i % Math.max(1, this.rooms)
      const base = g.samTmax(p, room, ts)
      const factor = i < this.rooms ? 1 : 0.85 + 0.1 * u
      let max = r1(env + (base - g.ENV_T) * factor + g.noise(seed, Math.floor(ts / 2000)) * 0.15)
      const inj = this.hot.get(r.name)
      if (inj && inj.until > ts) max = inj.max
      else if (inj) this.hot.delete(r.name)
      const min = r1(Math.max(env - 1, max - 6 - 4 * frac(u * 7)))
      const c = r.coords as Record<string, number>
      if (r.type === 'point') {
        out.push({ name: r.name, pt: max })
      } else {
        const [x0, y0, w, h] =
          r.type === 'line'
            ? [Math.min(c['startX']!, c['endX']!), Math.min(c['startY']!, c['endY']!), Math.abs(c['endX']! - c['startX']!) || 1, Math.abs(c['endY']! - c['startY']!) || 1]
            : r.type === 'polygon'
              ? bbox((c['points'] as unknown as { x: number; y: number }[]) ?? [])
              : [c['x']!, c['y']!, c['width']!, c['height']!]
        const maxX = Math.round(x0! + w! * (0.3 + 0.4 * frac(u * 3 + ts / 600_000)))
        const maxY = Math.round(y0! + h! * (0.3 + 0.4 * frac(u * 5 + ts / 900_000)))
        out.push({ name: r.name, max, min, maxX, maxY })
        if (max > gmax) [gmax, gx, gy] = [max, maxX, maxY]
      }
      gmin = Math.min(gmin, min)
    })
    if (!Number.isFinite(gmax)) [gmax, gx, gy] = [r1(env + 2), FRAME.w / 2, FRAME.h / 2]
    // 全画面：热点常在某个区域里，偶尔在区域外略高一点；最低温是柜体背景
    return { ts, glob: { max: r1(gmax + 0.6), min: r1(Math.min(gmin, env) - 1.5), maxX: gx + 3, maxY: gy - 2 }, regions: out }
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

function bbox(pts: { x: number; y: number }[]): [number, number, number, number] {
  if (!pts.length) return [0, 0, 1, 1]
  const xs = pts.map(p => p.x)
  const ys = pts.map(p => p.y)
  return [Math.min(...xs), Math.min(...ys), Math.max(1, Math.max(...xs) - Math.min(...xs)), Math.max(1, Math.max(...ys) - Math.min(...ys))]
}
