/* EG 的配置：两份文件，按归属分开（开发计划 §6.2）。
 *
 *   eg.yaml     子站下发：本柜是谁、下挂哪些设备、设备名、额定电流、这台 EG 的访问令牌。
 *               子站 `pnpm eg:config` 生成，EG 上只读（改要回子站改 tb/model.yaml 再生成）。
 *   local.yaml  EG 本地：本机总线与本地 TB 的地址、摄像机地址与账号、管理页端口。本地管理页可改。
 *
 * EG 本地跑独立 TB CE（后端库 docs/EG独立TB调整方案.md）：
 *   eg.yaml 的 station 段多了子站 MQTT 地址与令牌（上送用，§8.1）、tb 段是本地 TB 的租户账号（provision:eg 建的，agent 读本地告警、写设备配置用）；
 *   eg.token 是本地 TB 上 EG 网关设备的令牌（IoT Gateway 连本地 TB 用）。
 *   local.yaml 的本地 TB 项叫 mqtt.tb / tb.http / docker.containers.tb（legacy() 照读更早的写法）。
 *
 * 目录由 EG_CONFIG_DIR 指定；开发时默认仓库下的 run/（不进仓库）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

export type DeviceKind = 'eg' | 'sam' | 'meter' | 'pm' | 'camera'
export type Group = 'mv' | 'tr' | 'lv'

export interface DeviceConf {
  name: string
  kind: DeviceKind
  label: string
  attrs: Record<string, unknown>
}

/** eg.yaml（子站下发），字段与后端 tb/provision/src/eg-config.ts 一致 */
export interface EgFile {
  schema: number
  generatedAt: string
  station: {
    name: string
    label: string
    /** 子站 TB 的 MQTT（上送遥测，§8.1）：开发 mqtt://127.0.0.1:1883，现场 mqtts://<子站>:8883 */
    mqtt?: string
    /** 子站上 EG-<柜号> 网关设备的访问令牌：上送、X-EG-Token、验子站签的票据都用它 */
    token?: string
    /** 子站扩展服务的 HTTP 基址（告警事件 POST <http>/ext/eg/<柜号>/events，§8.2）；缺省 http://<sp.host>（经子站 Nginx） */
    http?: string
  }
  sp: { host: string }
  cabinet: { code: string; name: string; group: Group; kind: string; rated: number; riseLimit: number; rooms: string[]; index: number }
  eg: { name: string; token: string; attrs: Record<string, unknown> }
  devices: DeviceConf[]
  /** 本地 TB 的租户管理员（provision:eg 建）；没有时 agent 不读本地告警、不写设备配置 */
  tb?: { user: string; password: string }
}

/** local.yaml（EG 本地） */
export interface LocalFile {
  mqtt: {
    /** 本机总线（Mosquitto）：同事的转换程序、agent、IoT Gateway 都连它 */
    bus: string
    /** 本地 TB 的 MQTT（IoT Gateway 用 eg.token 连它） */
    tb: string
  }
  /** 本地 TB 的 REST（agent 读本地告警、写设备配置） */
  tb: { http: string }
  /** 上送 outbox（EG独立TB调整方案 §2.2）：保留上限两者先到为准；补传限速（样本 / 秒），免得恢复时压垮子站 */
  outbox: { maxAgeDays: number; maxMb: number; backfillRate: number }
  http: { port: number }
  /** 对时：SNTP 查询的服务器，测 eg.clk_offset 用（EG 自己的对时由系统 chrony 做）。空 = 子站主机 */
  ntp: { server: string }
  /** 上行网口名（算 eg.up_kbps）；空 = 按默认路由自动找 */
  net: { uplink: string }
  /** 本机容器：看状态、取日志、重启（只开放本地 TB 与 IoT Gateway 的重启）。api：unix:///var/run/docker.sock、npipe:////./pipe/docker_engine、http://docker-proxy:2375 */
  docker: { api: string; containers: { tb: string; gateway: string; mosquitto: string; mediamtx: string } }
  /** EG 本机 mediamtx（G4，docs/G4视频接口约定.md）：配置由 eg-video 生成到 <配置目录>/mediamtx/mediamtx.yml */
  video: {
    /** 子站从这里拉流：rtsp://<EG 上行 IP>:<rtspPort>/<柜号>[-sub|-ir|-ir-sub]（开发样机 18554，与子站的 8554 错开） */
    rtspPort: number
    /** eg-video 访问 mediamtx API 的地址（读各路状态与码率） */
    api: string
    /** mediamtx API 的监听地址：EG 上宿主机网络只听本机；开发样机在容器里要听 :9997 再映射出来 */
    apiListen: string
    /** 能读流的地址（IP / CIDR）；空 = 子站主机（sp.host）+ 本机 */
    readFrom: string[]
    /** 能调 API 的地址；空 = 本机 */
    apiFrom: string[]
    /** 按需拉：没有读者后多久断开上一级（摄像机） */
    closeAfter: string
    /** mediamtx 回放服务（裁证据片段，G5）：eg-video 访问的地址 / 监听地址（EG 上只听本机） */
    playback: string
    playbackListen: string
  }
  /** 循环录像与证据（G5，docs/G5证据约定.md §6；都待确认） */
  evidence: {
    /** 循环录像（两路子码流常录）留多久 */
    ringHours: number
    /** 视频证据前 / 后窗 */
    preS: number
    postS: number
    /** 录波前 / 后窗 */
    wavePreS: number
    wavePostS: number
    /** 锁定片段（未上传）在 EG 上留多久 */
    lockedDays: number
    /** 已上传的 EG 本地副本再留多久 */
    uploadedKeepDays: number
    /** 数据盘水位 %：超 highWater 提前删最旧的循环段；只剩锁定文件还超 fullWater 就报满、新锁定标缺证 */
    highWater: number
    fullWater: number
    /** 重要证据（自动上传子站）：级别或类型命中其一 */
    autoUpload: { severities: string[]; types: string[] }
  }
  camera: {
    /** 摄像机驱动（G4 摄像机测温约定 §1）：sim = 仿真摄像机（流、区域、温度、报警都从仿真器取）；
     *  onvif / rtsp = 只有视频（ONVIF 查流地址 / 只用手填），不测温。真机驱动归 H */
    driver: 'sim' | 'onvif' | 'rtsp'
    /** sim 驱动的仿真器地址，如 http://127.0.0.1:3190/emu/cam */
    api: string
    /** 区域温升 ir.R<n>.rise = ir.R<n>.max − env.t：两个输入的源时间差超过这么多秒就不出值（缺省 15 = 1.5 × env.t 周期，约定 §3） */
    riseToleranceS: number
    /** ONVIF 设备服务地址，如 http://192.168.10.64/onvif/device_service */
    onvif: string
    user: string
    password: string
    /** 各路 RTSP；空 = 由 ONVIF 查得 */
    rtsp: { visible: string; thermal: string; visibleSub: string; thermalSub: string }
  }
}

export interface EgConfig extends EgFile {
  /** local.yaml 原样（写给同一 compose 网络里的容器看的地址，IoT Gateway 配置按它生成） */
  local: LocalFile
  /** 本进程自己连的地址：local.yaml 的值，开发时可被环境变量覆盖（进程跑在宿主机、总线在容器里） */
  conn: { bus: string; tb: string; tbHttp: string; httpPort: number; stationHttp: string; mtxApi: string; camHost: string }
  dir: string
}

export const SUPPORTED_SCHEMA = 1

export const LOCAL_DEFAULTS: LocalFile = {
  mqtt: { bus: 'mqtt://mosquitto:1883', tb: 'mqtt://tb:1883' },
  tb: { http: 'http://tb:8080' },
  outbox: { maxAgeDays: 7, maxMb: 2048, backfillRate: 2000 },
  http: { port: 80 },
  ntp: { server: '' },
  net: { uplink: '' },
  docker: {
    api: 'unix:///var/run/docker.sock',
    containers: { tb: 'lsa-eg-tb', gateway: 'lsa-eg-gateway', mosquitto: 'lsa-eg-mosquitto', mediamtx: 'lsa-eg-mediamtx' },
  },
  video: { rtspPort: 8554, api: 'http://127.0.0.1:9997', apiListen: '127.0.0.1:9997', readFrom: [], apiFrom: [], closeAfter: '10s', playback: 'http://127.0.0.1:9996', playbackListen: '127.0.0.1:9996' },
  evidence: {
    ringHours: 24,
    preS: 30,
    postS: 60,
    wavePreS: 10,
    wavePostS: 20,
    lockedDays: 30,
    uploadedKeepDays: 7,
    highWater: 85,
    fullWater: 95,
    autoUpload: { severities: ['CRITICAL'], types: ['弧光异常', '过温'] },
  },
  camera: { driver: 'rtsp', api: '', riseToleranceS: 15, onvif: '', user: 'admin', password: '', rtsp: { visible: '', thermal: '', visibleSub: '', thermalSub: '' } },
}

/** 仓库根（有 pnpm-workspace.yaml 的那层）；装到 EG 上后没有就返回 null */
export function repoRoot(): string | null {
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(d, 'pnpm-workspace.yaml'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

export function configDir(): string {
  const fromEnv = process.env['EG_CONFIG_DIR']
  if (fromEnv) return resolve(fromEnv)
  return resolve(repoRoot() ?? process.cwd(), 'run')
}

/** 读两份配置。local.yaml 没有就按默认值生成一份；环境变量 EG_BUS_MQTT / EG_TB_MQTT / EG_TB_HTTP / EG_HTTP_PORT / EG_STATION_HTTP / EG_MTX_API / EG_CAM_HOST 只改本进程自己的连接（开发用） */
export function loadConfig(dir = configDir()): EgConfig {
  const egPath = resolve(dir, 'eg.yaml')
  if (!existsSync(egPath)) throw new Error(`没有 ${egPath} —— 在子站上跑 pnpm eg:config 生成后拷过来（开发机：pnpm dev:config）`)
  const eg = parse(readFileSync(egPath, 'utf8')) as EgFile
  if (eg.schema !== SUPPORTED_SCHEMA) throw new Error(`eg.yaml 格式版本 ${eg.schema}，本程序只认 ${SUPPORTED_SCHEMA}`)

  const localPath = resolve(dir, 'local.yaml')
  let local: LocalFile
  if (existsSync(localPath)) {
    local = merge(LOCAL_DEFAULTS, legacy(parse(readFileSync(localPath, 'utf8')) ?? {}))
  } else {
    local = structuredClone(LOCAL_DEFAULTS)
    saveLocal(local, dir)
  }
  const env = process.env
  const conn = {
    bus: env['EG_BUS_MQTT'] || local.mqtt.bus,
    tb: env['EG_TB_MQTT'] || local.mqtt.tb,
    tbHttp: env['EG_TB_HTTP'] || local.tb.http,
    httpPort: Number(env['EG_HTTP_PORT'] || local.http.port),
    stationHttp: (env['EG_STATION_HTTP'] || eg.station.http || `http://${eg.sp.host}`).replace(/\/$/, ''),
    mtxApi: (env['EG_MTX_API'] || local.video.api).replace(/\/$/, ''),
    // eg-video 自己直连摄像机（探测、抓图）时把流地址里的「主机:端口」换成它 —— 开发时摄像机测试源在容器里，宿主机上的 eg-video 走映射端口
    camHost: env['EG_CAM_HOST'] || '',
  }
  return { ...eg, local, conn, dir }
}

export function saveLocal(local: LocalFile, dir = configDir()): void {
  mkdirSync(dir, { recursive: true })
  const head = '# EG 本地配置（本地管理页可改）。子站下发的部分在 eg.yaml，不要在这里重复\n'
  writeFileSync(resolve(dir, 'local.yaml'), head + stringify(local), 'utf8')
}

/** 本机总线主题（《EG 内部 MQTT 格式》）：lsa/<设备名>/telemetry | attributes */
export const BUS_TOPIC = {
  telemetry: (dev: string) => `lsa/${dev}/telemetry`,
  attributes: (dev: string) => `lsa/${dev}/attributes`,
  telemetryAll: 'lsa/+/telemetry',
  attributesAll: 'lsa/+/attributes',
} as const

/** 从主题取设备名；不是本机总线主题返回 null */
export function deviceOfTopic(topic: string): { device: string; kind: 'telemetry' | 'attributes' } | null {
  const m = /^lsa\/([^/]+)\/(telemetry|attributes)$/.exec(topic)
  return m ? { device: m[1]!, kind: m[2] as 'telemetry' | 'attributes' } : null
}

/** 更早的 local.yaml 写法：mqtt.edge → mqtt.tb，docker.containers.edge → tb，edgeDb 丢掉（开发机上的旧文件；G6 部署包之后可删） */
function legacy(raw: unknown): unknown {
  if (!isObj(raw)) return raw
  const r = structuredClone(raw) as Record<string, any>
  if (isObj(r['mqtt']) && r['mqtt']['edge'] && !r['mqtt']['tb']) r['mqtt']['tb'] = r['mqtt']['edge']
  if (isObj(r['mqtt'])) delete r['mqtt']['edge']
  const c = isObj(r['docker']) ? r['docker']['containers'] : null
  if (isObj(c) && c['edge'] && !c['tb']) c['tb'] = c['edge']
  if (isObj(c)) delete c['edge']
  delete r['edgeDb']
  return r
}

/** 验子站签的票据、上送鉴权用的令牌：子站上 EG 网关设备的令牌（eg.yaml station.token）；
 *  没有时退回 eg.token（本地 TB 上 EG 设备的令牌；provision:eg 把两者设成同一个） */
export function stationToken(cfg: Pick<EgFile, 'station' | 'eg'>): string {
  return cfg.station.token || cfg.eg.token
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? structuredClone(base) : over) as T
  const out: Record<string, unknown> = structuredClone(base) as Record<string, unknown>
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v
  return out as T
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
