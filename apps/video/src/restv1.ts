/* 真机摄像机驱动 restv1（厂家「双目摄像头接口 restful 文档 restv1 V1.8」，docs/厂家资料/；EG 0.5，待确认事项清单 I18）。
 * 厂家答复（清单 4.4 版 CAM1–CAM8，docs/G4摄像机测温约定.md §0）：
 *   - 登录 POST /restv1/token {user: MD5(用户名), key: MD5(口令)}，MD5 用 32 位小写；回 accessToken、expireTime（剩余秒数）；
 *     之后每个请求头带 accessToken。到期前重取；任何接口回 10009（权限过期）就立即重取一次再试，还不行算 TOKEN 失败。
 *     整个驱动只用一个令牌（摄像机最多 2 个会话同时连，另一个留给现场调试）；并发的请求共用同一次登录。
 *   - 流地址 GET /restv1/channel/rtsp/:id（0 可见光、1 热像）→ rtspUrlMain / rtspUrlSub。
 *   - 区域配置 GET /restv1/measurement/region（ID 0–11 对应平台 R1–R12；类型 point / line / region / polygon），60 s 刷新一次；
 *     温度 GET /restv1/measurement/globTemp、/restv1/measurement/regionTemp：1 s 刷新，允许每秒轮询（CAM4）。
 *     avg = 平均温、center = 中心点温度（CAM2）；point 类型回 {value, x, y}。坐标是热像主码流 640×480 的像素、原点左上（CAM3、CAM5）。
 *   - 报警 GET /restv1/alarm/status 每秒轮询（推送不发恢复、不支持 HTTPS，不用；CAM6），只取「正在报警」的项、不带数值（免得数值一变就当成变化）。
 *   - 抓拍 GET /restv1/channel/snap/:id → snapData（base64 JPG）。
 * 口令只在内存里（取自 local.yaml），任何报错、日志、detail() 都不带口令和它的 MD5。 */
import { createHash } from 'node:crypto'
import { DriverError, type CameraDriver, type Measurement, type RegionDef, type StreamInfo } from './driver-base.js'
import type { ChannelKey } from './onvif.js'

/** 热像主码流分辨率（厂家 CAM5：640×480，不是 640×512）—— 区域坐标所在的画面 */
export const RESTV1_FRAME = { w: 640, h: 480 } as const
/** 区域配置多久重读一次（测温每秒一次，配置很少变） */
const REGION_REFRESH_MS = 60_000
/** 令牌提前这么久重取：剩余时间的 10%，最少 5 s、最多 60 s */
const renewMargin = (lifeMs: number) => Math.min(60_000, Math.max(5_000, lifeMs * 0.1))
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

const CODE_TEXT: Record<number, string> = {
  10001: '参数超限或参数格式错误',
  10008: '设备不支持此功能',
  10009: '权限过期或无此权限',
  19999: '接口调用异常',
}

interface Envelope<T> {
  code?: number
  msg?: string
  data?: T
}
interface TempPoint {
  value?: number
  x?: number
  y?: number
}
interface RegionRow {
  regionEnable?: boolean
  regionName?: string
  regionType?: string
  region?: Record<string, unknown>
}
interface RegionTempRow {
  enable?: boolean
  max?: TempPoint
  min?: TempPoint
  avg?: TempPoint
  center?: TempPoint
  point?: TempPoint
}
interface AlarmItem {
  active?: boolean
  alarm?: boolean
  difference?: { regionA?: number; regionB?: number }
}

export interface Restv1Opts {
  /** 摄像机地址：http://主机[:端口]（没写协议按 http） */
  base: string
  user: string
  password: string
  /** 普通请求超时（ms），缺省 3000 */
  timeoutMs?: number
  /** 抓拍超时（ms），缺省 10000 */
  snapTimeoutMs?: number
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const TYPES = new Set(['point', 'line', 'region', 'polygon'])

/** restv1 的区域坐标 → 约定 §4 的 coords（polygon 的 {pointNum, point:[…]} 改成 {points:[…]}，其余原样） */
export function coordsOf(type: string, region: Record<string, unknown> | undefined): Record<string, unknown> {
  const r = region ?? {}
  if (type === 'polygon') {
    const pts = Array.isArray(r['point']) ? (r['point'] as unknown[]) : Array.isArray(r['points']) ? (r['points'] as unknown[]) : []
    return { points: pts.filter((p): p is { x: number; y: number } => !!p && typeof p === 'object' && num((p as { x?: unknown }).x) !== undefined && num((p as { y?: unknown }).y) !== undefined).map(p => ({ x: p.x, y: p.y })) }
  }
  return { ...r }
}

/** /alarm/status → 正在报警的项（排好序、用「、」连起来；没有报警为空串）。只看 alarm = true 的，不带数值 */
export function alarmText(data: Record<string, unknown> | undefined): string {
  if (!data || typeof data !== 'object') return ''
  const on = (x: unknown) => !!x && typeof x === 'object' && (x as AlarmItem).alarm === true
  const list = (x: unknown) => (Array.isArray(x) ? x : [])
  const out: string[] = []
  if (on(data['globTemp'])) out.push('全局温度')
  list(data['regionTemp']).forEach((x, i) => on(x) && out.push(`R${i + 1} 区域温度`))
  list(data['diffTemp']).forEach((x, i) => {
    if (!on(x)) return
    const d = (x as AlarmItem).difference
    out.push(d && num(d.regionA) !== undefined && num(d.regionB) !== undefined ? `温差 R${d.regionA}–R${d.regionB}` : `温差 ${i + 1}`)
  })
  if (on(data['globTempRise'])) out.push('全局温升')
  list(data['tempRise']).forEach((x, i) => on(x) && out.push(`R${i + 1} 温升`))
  if (on(data['firePoint'])) out.push('火点')
  if (on(data['smartTemp'])) out.push('智能测温')
  list(data['input']).forEach((x, i) => on(x) && out.push(`报警输入 ${i + 1}`))
  return out.join('、')
}

export class Restv1Driver implements CameraDriver {
  readonly name = 'restv1'
  readonly pollMs = 1000
  private readonly base: string
  private readonly timeoutMs: number
  private readonly snapTimeoutMs: number
  private token: { value: string; expiresAt: number; lifeMs: number } | null = null
  private loginP: Promise<string> | null = null
  private logins = 0
  private regionCache: { at: number; defs: (RegionDef & { id: number })[] } | null = null
  private lastAlarm = ''
  private firmware: string | null = null
  private lastError: string | null = null

  constructor(private readonly o: Restv1Opts) {
    const b = o.base.trim().replace(/\/+$/, '')
    this.base = /^https?:\/\//i.test(b) ? b : `http://${b}`
    this.timeoutMs = o.timeoutMs ?? 3000
    this.snapTimeoutMs = o.snapTimeoutMs ?? 10_000
  }

  // ---------- 底层 ----------

  /** 发一个请求、解信封；网络错误 / 超时 / 非 2xx / 不是 JSON 都转成 DriverError（不带口令） */
  private async raw<T>(method: 'GET' | 'POST', path: string, body: unknown, token: string | null, timeoutMs: number): Promise<Envelope<T>> {
    let r: Response
    try {
      r = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { accessToken: token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } }
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new DriverError(`${path}：${timeoutMs / 1000} s 没回应`, 'TIMEOUT')
      throw new DriverError(`连不上摄像机 ${this.base}（${err.cause?.code ?? err.message}）`, 'CONNECT')
    }
    const text = await r.text().catch(() => '')
    if (r.status === 401 || r.status === 403) return { code: 10009, msg: `HTTP ${r.status}` }
    if (!r.ok) throw new DriverError(`${path}：HTTP ${r.status}`, 'API')
    try {
      return JSON.parse(text) as Envelope<T>
    } catch {
      throw new DriverError(`${path}：回的不是 JSON（${text.slice(0, 60)}）`, 'DATA')
    }
  }

  /** 登录（并发的调用共用同一次） */
  private login(): Promise<string> {
    if (this.loginP) return this.loginP
    this.loginP = (async () => {
      const env = await this.raw<{ accessToken?: string; expireTime?: number }>('POST', '/restv1/token', { user: md5(this.o.user), key: md5(this.o.password) }, null, this.timeoutMs)
      if (env.code !== 200 || !env.data?.accessToken) {
        this.token = null
        if (env.code === 10009 || env.code === 10001) throw new DriverError(`登录摄像机失败：账号或口令不对（${env.code} ${CODE_TEXT[env.code] ?? env.msg ?? ''}）`, 'AUTH')
        // 别的返回码不是口令的事（如 19999：摄像机最多 2 个会话，现场调试工具占着时会登不上）
        throw new DriverError(`登录摄像机失败：${env.code ?? '?'} ${CODE_TEXT[env.code ?? 0] ?? env.msg ?? ''}（摄像机最多 2 个会话：调试工具占着时先关掉它）`, 'API')
      }
      const life = Math.max(1, num(env.data.expireTime) ?? 3600) * 1000
      this.token = { value: env.data.accessToken, expiresAt: Date.now() + life, lifeMs: life }
      this.logins++
      if (this.firmware === null) void this.readInfo()
      return env.data.accessToken
    })().finally(() => (this.loginP = null))
    return this.loginP
  }

  private async tokenNow(): Promise<string> {
    const t = this.token
    if (t && t.expiresAt - Date.now() > renewMargin(t.lifeMs)) return t.value
    return this.login()
  }

  /** 带令牌调接口：回 10009 时重新登录再试一次；其它非 200 抛 API */
  private async call<T>(method: 'GET' | 'POST', path: string, timeoutMs = this.timeoutMs): Promise<T> {
    let env = await this.raw<T>(method, path, undefined, await this.tokenNow(), timeoutMs)
    if (env.code === 10009) {
      this.token = null
      env = await this.raw<T>(method, path, undefined, await this.login(), timeoutMs)
      if (env.code === 10009) throw new DriverError(`${path}：重新登录后仍然 10009（${CODE_TEXT[10009]}）`, 'TOKEN')
    }
    if (env.code !== 200) throw new DriverError(`${path}：${env.code ?? '?'} ${CODE_TEXT[env.code ?? 0] ?? env.msg ?? ''}`.trim(), 'API')
    if (env.data === undefined) throw new DriverError(`${path}：回的数据里没有 data`, 'DATA')
    return env.data
  }

  private async readInfo(): Promise<void> {
    try {
      const d = await this.call<{ version?: { firmwareVersion?: string }; name?: string }>('GET', '/restv1/device/info')
      this.firmware = d.version?.firmwareVersion ?? ''
    } catch {
      this.firmware = null
    }
  }

  // ---------- CameraDriver ----------

  async streams() {
    const map: Partial<Record<ChannelKey, StreamInfo>> = {}
    const notes: string[] = []
    for (const [id, main, sub] of [[0, 'visible', 'visibleSub'], [1, 'thermal', 'thermalSub']] as const) {
      const d = await this.call<{ rtspUrlMain?: string; rtspUrlSub?: string }>('GET', `/restv1/channel/rtsp/${id}`)
      if (d.rtspUrlMain) map[main] = { uri: d.rtspUrlMain, snapshot: null }
      else notes.push(`通道 ${id} 没给主码流地址`)
      if (d.rtspUrlSub) map[sub] = { uri: d.rtspUrlSub, snapshot: null }
      else notes.push(`通道 ${id} 没给子码流地址`)
    }
    return { map, note: `restv1 查到 ${Object.keys(map).length} 路${notes.length ? `（${notes.join('；')}）` : ''}` }
  }

  private async regions(force: boolean): Promise<(RegionDef & { id: number })[]> {
    if (!force && this.regionCache && Date.now() - this.regionCache.at < REGION_REFRESH_MS) return this.regionCache.defs
    const rows = await this.call<RegionRow[]>('GET', '/restv1/measurement/region')
    if (!Array.isArray(rows)) throw new DriverError('/restv1/measurement/region：data 不是数组', 'DATA')
    const defs = rows.map((r, id) => {
      const type = TYPES.has(String(r.regionType)) ? (r.regionType as RegionDef['type']) : 'region'
      return { id, name: r.regionName?.trim() || `R${id + 1}`, type, coords: coordsOf(type, r.region), enabled: r.regionEnable !== false }
    })
    this.regionCache = { at: Date.now(), defs }
    return defs
  }

  async measure(): Promise<Measurement> {
    const partial: NonNullable<Measurement['partial']> = []
    // 区域配置：读不到时用上次的（测温照常），一次都没读到过就整次失败
    let defs: (RegionDef & { id: number })[]
    try {
      defs = await this.regions(false)
    } catch (e) {
      if (!this.regionCache || (e as DriverError).code === 'AUTH' || (e as DriverError).code === 'CONNECT') throw this.remember(e)
      defs = this.regionCache.defs
      partial.push({ what: 'region', error: (e as Error).message })
    }
    const ts = Date.now()
    let glob: { max?: TempPoint; min?: TempPoint; avg?: TempPoint; center?: TempPoint }
    let rows: RegionTempRow[]
    try {
      glob = await this.call('GET', '/restv1/measurement/globTemp')
      rows = await this.call<RegionTempRow[]>('GET', '/restv1/measurement/regionTemp')
    } catch (e) {
      throw this.remember(e)
    }
    if (!Array.isArray(rows)) throw this.remember(new DriverError('/restv1/measurement/regionTemp：data 不是数组', 'DATA'))
    const gmax = num(glob.max?.value)
    const gmin = num(glob.min?.value)
    if (gmax === undefined || gmin === undefined) throw this.remember(new DriverError('/restv1/measurement/globTemp：没有最高 / 最低温', 'DATA'))
    // 区域条数变了（摄像机上加减了区域）：下一次强制重读配置
    if (rows.length !== defs.length && this.regionCache) this.regionCache.at = 0
    const regions: NonNullable<Measurement['temps']>['regions'] = []
    for (const d of defs) {
      const t = rows[d.id]
      if (!d.enabled || !t || t.enable === false) continue
      if (d.type === 'point') {
        const pt = num(t.point?.value) ?? num(t.max?.value)
        if (pt !== undefined) regions.push({ name: d.name, pt })
        continue
      }
      regions.push({
        name: d.name,
        max: num(t.max?.value),
        min: num(t.min?.value),
        maxX: num(t.max?.x),
        maxY: num(t.max?.y),
        avg: num(t.avg?.value),
        center: num(t.center?.value),
      })
    }
    // 报警：读不到时沿用上次的状态，标 partial（cam.rest DEGRADED、cam.alarm 质量码 invalid）
    let alarm = this.lastAlarm
    try {
      alarm = alarmText(await this.call<Record<string, unknown>>('GET', '/restv1/alarm/status'))
      this.lastAlarm = alarm
    } catch (e) {
      if ((e as DriverError).code === 'AUTH' || (e as DriverError).code === 'CONNECT') throw this.remember(e)
      partial.push({ what: 'alarm', error: (e as Error).message })
    }
    this.lastError = partial.length ? partial.map(p => p.error).join('；') : null
    return {
      frame: { ...RESTV1_FRAME },
      regions: defs.map(({ id: _id, ...d }) => d),
      temps: {
        ts,
        glob: { max: gmax, min: gmin, maxX: num(glob.max?.x) ?? 0, maxY: num(glob.max?.y) ?? 0, avg: num(glob.avg?.value), center: num(glob.center?.value) },
        regions,
      },
      alarm,
      ...(partial.length ? { partial } : {}),
    }
  }

  async snap(ch: 'visible' | 'ir'): Promise<Buffer> {
    const d = await this.call<{ snapData?: string }>('GET', `/restv1/channel/snap/${ch === 'ir' ? 1 : 0}`, this.snapTimeoutMs)
    const b64 = (d.snapData ?? '').replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new DriverError(`/restv1/channel/snap：回的不是 JPEG（${buf.length} 字节）`, 'DATA')
    return buf
  }

  detail() {
    const t = this.token
    return {
      base: this.base,
      token: t ? { validS: Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)) } : null,
      logins: this.logins,
      firmware: this.firmware,
      regions: this.regionCache?.defs.length ?? null,
      lastError: this.lastError,
    }
  }

  private remember(e: unknown): Error {
    this.lastError = (e as Error).message
    return e as Error
  }
}
