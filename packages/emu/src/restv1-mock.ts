/* restv1 模拟摄像机（只做自检用，不进发布件：packages/emu 只进测试件）。照厂家「restv1 V1.8」与清单 4.4 版答复（CAM1–CAM8）：
 *   POST /restv1/token          {user: md5(用户名), key: md5(口令)}（32 位小写；大写算错）→ accessToken、expireTime（剩余秒数）
 *   GET  /restv1/device/info     固件版本
 *   GET  /restv1/channel/rtsp/:id rtspUrlMain / rtspUrlSub（0 可见光、1 热像）
 *   GET  /restv1/channel/snap/:id snapData（base64 JPG）
 *   GET  /restv1/measurement/region      区域配置（ID 0–11）
 *   GET  /restv1/measurement/globTemp    全画面 max / min（带坐标）、avg、center
 *   GET  /restv1/measurement/regionTemp  各区 enable、max / min（带坐标）、avg、center；point 类型另有 point {value, x, y}
 *   GET  /restv1/alarm/status            globTemp、regionTemp[]、diffTemp[]、globTempRise、tempRise[]、firePoint、smartTemp、input[]
 * 请求头 accessToken 不对 / 过期回 {code: 10009}（HTTP 200）；最多 2 个有效会话（第三个登录回 19999），与厂家答复一致。
 * 控制（自检用）：直接改返回对象的 state；命令行起的版本另有 POST /mock/ctl（JSON：expireAll、fail、alarms、tokenLifeS、regions）。
 * 只用 Node 自带模块、没有 TS 专有语法：现场样机上可以 `node --experimental-strip-types restv1-mock.ts` 直接跑（不用装依赖）。
 *
 *   node --experimental-strip-types packages/emu/src/restv1-mock.ts --port 18091 --user <测试账号> --password <测试口令> [--rtsp rtsp://127.0.0.1:8555]
 * 测试口令自己定，**不要用厂家默认口令**。 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface MockRegion {
  regionEnable: boolean
  regionName: string
  regionType: 'point' | 'line' | 'region' | 'polygon'
  region: Record<string, unknown>
}

export interface MockState {
  user: string
  password: string
  /** 新令牌的有效期（秒） */
  tokenLifeS: number
  /** 当前有效的令牌 → 到期时刻 */
  tokens: Map<string, number>
  /** 成功登录次数 */
  logins: number
  /** 同时有效的令牌最多到过几个 */
  maxConcurrent: number
  regions: MockRegion[]
  /** 正在报警的：globTemp、regionTemp 的区号（0 起）、firePoint */
  alarms: { globTemp: boolean; regionTemp: number[]; firePoint: boolean }
  /** 某个路径（不含 /restv1 前缀，如 '/alarm/status'）故意出错：返回码、'http500'、'hang'（不回）、'nojpeg'（snap 回非 JPEG） */
  fail: Record<string, number | 'http500' | 'hang' | 'nojpeg'>
  /** 每个路径被调了几次 */
  hits: Record<string, number>
  rtspBase: string
  /** 抓拍请求的通道号（按顺序） */
  snapIds: number[]
}

export const DEFAULT_MOCK_REGIONS: MockRegion[] = [
  { regionEnable: true, regionName: 'R1', regionType: 'region', region: { x: 50, y: 90, width: 160, height: 150 } },
  { regionEnable: true, regionName: 'R2', regionType: 'region', region: { x: 240, y: 90, width: 160, height: 150 } },
  { regionEnable: true, regionName: 'R3', regionType: 'region', region: { x: 430, y: 90, width: 160, height: 150 } },
]

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
/** 最小的 JPEG 外形（FFD8 … FFD9），驱动只认文件头 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), randomBytes(32), Buffer.from([0xff, 0xd9])])
const r1 = (v: number) => Math.round(v * 10) / 10

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let s = ''
    req.on('data', d => (s += String(d)))
    req.on('end', () => resolve(s))
  })
}

/** 第 id 个区的温度（确定性：区号越大越热一点，随秒数小幅摆动） */
function regionTemp(r: MockRegion, id: number, now: number) {
  const wob = Math.sin(now / 10_000 + id) * 0.5
  const max = r1(40 + id * 2 + wob)
  const base = { enable: r.regionEnable, max: { value: max, x: 60 + id * 10, y: 100 + id * 5 }, min: { value: r1(max - 12) , x: 70, y: 110 }, avg: { value: r1(max - 5) }, center: { value: r1(max - 3) } }
  if (r.regionType === 'point') {
    const x = Number(r.region['x'] ?? 0)
    const y = Number(r.region['y'] ?? 0)
    return { ...base, point: { value: max, x, y } }
  }
  return base
}

function alarmStatus(st: MockState) {
  const item = (on: boolean) => ({ active: true, alarm: on, value: 45, threshold: { type: 'high', highTemp: 30, lowTemp: 10 } })
  return {
    globTemp: item(st.alarms.globTemp),
    regionTemp: st.regions.map((_, i) => item(st.alarms.regionTemp.includes(i))),
    diffTemp: [{ active: true, alarm: false, difference: { regionA: 1, regionB: 2, comType: 'highest' }, threshold: { t_type: 'above threshold', temp: 30 } }],
    globTempRise: { active: false, alarm: false, threshold: { r_type: 'highest', temp: 30, duration: 1 } },
    tempRise: st.regions.map(() => ({ active: false, alarm: false, threshold: { r_type: 'highest', temp: 30, duration: 1 } })),
    firePoint: { active: true, alarm: st.alarms.firePoint, value: 45, threshold: 60 },
    smartTemp: { active: false, alarm: false },
    input: [{ active: false, alarm: false }],
  }
}

export interface Restv1Mock {
  url: string
  port: number
  state: MockState
  close(): Promise<void>
}

export function startRestv1Mock(opts: { user: string; password: string; port?: number; host?: string; tokenLifeS?: number; regions?: MockRegion[]; rtspBase?: string; ctl?: boolean }): Promise<Restv1Mock> {
  const state: MockState = {
    user: opts.user,
    password: opts.password,
    tokenLifeS: opts.tokenLifeS ?? 3600,
    tokens: new Map(),
    logins: 0,
    maxConcurrent: 0,
    regions: structuredClone(opts.regions ?? DEFAULT_MOCK_REGIONS),
    alarms: { globTemp: false, regionTemp: [], firePoint: false },
    fail: {},
    hits: {},
    rtspBase: (opts.rtspBase ?? 'rtsp://127.0.0.1:8555').replace(/\/$/, ''),
    snapIds: [],
  }
  const live = () => {
    const now = Date.now()
    for (const [t, exp] of state.tokens) if (exp <= now) state.tokens.delete(t)
    return state.tokens.size
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x')
      const path = u.pathname
      if (opts.ctl && path === '/mock/ctl' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as Partial<{ expireAll: boolean; fail: MockState['fail']; alarms: MockState['alarms']; tokenLifeS: number; regions: MockRegion[] }>
        if (b.expireAll) state.tokens.clear()
        if (b.fail) state.fail = b.fail
        if (b.alarms) state.alarms = b.alarms
        if (b.tokenLifeS) state.tokenLifeS = b.tokenLifeS
        if (b.regions) state.regions = b.regions
        return json(res, { ok: true, logins: state.logins, maxConcurrent: state.maxConcurrent, hits: state.hits })
      }
      if (!path.startsWith('/restv1/')) return json(res, { code: 10001, msg: 'Invalid Parameter' }, 404)
      const p = path.slice('/restv1'.length)
      const key = p.replace(/\/\d+$/, '')
      state.hits[key] = (state.hits[key] ?? 0) + 1
      const f = state.fail[key]
      if (f === 'hang') return // 不回，测超时
      if (f === 'http500') return json(res, { msg: 'boom' }, 500)
      if (typeof f === 'number') return json(res, { code: f, msg: 'Function Call Exception' })

      if (p === '/token' && req.method === 'POST') {
        let b: { user?: string; key?: string } = {}
        try {
          b = JSON.parse(await readBody(req)) as typeof b
        } catch {
          return json(res, { code: 10001, msg: 'Invalid Parameter' })
        }
        if (b.user !== md5(state.user) || b.key !== md5(state.password)) return json(res, { code: 10009, msg: 'Invalid Permission' })
        if (live() >= 2) return json(res, { code: 19999, msg: 'Function Call Exception（会话已满）' })
        const t = randomBytes(16).toString('hex')
        state.tokens.set(t, Date.now() + state.tokenLifeS * 1000)
        state.logins++
        state.maxConcurrent = Math.max(state.maxConcurrent, live())
        return json(res, { code: 200, msg: 'Success', data: { accessToken: t, expireTime: state.tokenLifeS } })
      }
      const tok = String(req.headers['accesstoken'] ?? '')
      const exp = state.tokens.get(tok)
      if (!exp || exp <= Date.now()) return json(res, { code: 10009, msg: 'Invalid Permission' })
      const ok = (data: unknown) => json(res, { code: 200, msg: 'Success', data })
      const now = Date.now()
      if (p === '/device/info') return ok({ name: 'LSA-MOCK', vendor: 'mock', serial: 'MOCK-0001', version: { firmwareVersion: 'V1.8-mock', firmwareBuildTime: '2026-10-10' } })
      let m = /^\/channel\/rtsp\/(\d+)$/.exec(p)
      if (m) {
        const id = Number(m[1])
        if (id > 1) return json(res, { code: 10001, msg: 'Invalid Parameter' })
        const name = id === 0 ? 'visible' : 'thermal'
        return ok({ rtspUrlMain: `${state.rtspBase}/${name}`, rtspUrlSub: `${state.rtspBase}/${name}-sub` })
      }
      m = /^\/channel\/snap\/(\d+)$/.exec(p)
      if (m) state.snapIds.push(Number(m[1]))
      if (m) return ok({ snapData: f === 'nojpeg' ? Buffer.from('not a jpeg').toString('base64') : JPEG.toString('base64') })
      if (p === '/measurement/region') return ok(state.regions.map(r => ({ ...r, localMeasureParam: false, localParam: { distance: 2, emissivity: 0.95 } })))
      if (p === '/measurement/globTemp') {
        const max = r1(48.3 + Math.sin(now / 10_000) * 0.5)
        return ok({ max: { value: max, x: 320, y: 200 }, min: { value: 22.1, x: 10, y: 470 }, avg: { value: 30.5 }, center: { value: 31.2 } })
      }
      if (p === '/measurement/regionTemp') return ok(state.regions.map((r, i) => regionTemp(r, i, now)))
      if (p === '/alarm/status') return ok(alarmStatus(state))
      return json(res, { code: 10008, msg: 'Not Supported' })
    })().catch(e => json(res, { code: 19999, msg: (e as Error).message }, 500))
  })
  return new Promise(resolve => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${port}`,
        port,
        state,
        close: () =>
          new Promise<void>(r => {
            server.closeAllConnections()
            server.close(() => r())
          }),
      })
    })
  })
}

// 命令行：起一个常驻的（样机上联调 eg-video 用），带 /mock/ctl
const argv = process.argv.slice(2)
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : undefined
}
if (process.argv[1] && /restv1-mock\.(ts|js|mjs)$/.test(process.argv[1])) {
  const user = arg('user')
  const password = arg('password')
  if (!user || !password) {
    console.error('用法：restv1-mock.ts --port <端口> --user <测试账号> --password <测试口令> [--host 0.0.0.0] [--rtsp rtsp://…]（测试口令自己定，不要用厂家默认口令）')
    process.exit(2)
  }
  const m = await startRestv1Mock({ user, password, port: Number(arg('port') ?? 18091), host: arg('host') ?? '127.0.0.1', rtspBase: arg('rtsp'), ctl: true })
  console.log(`restv1 模拟摄像机：${m.url}（控制 POST ${m.url}/mock/ctl）`)
}
