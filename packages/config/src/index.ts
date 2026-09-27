/* EG 的配置：两份文件，按归属分开（开发计划 §6.2）。
 *
 *   eg.yaml     子站下发：本柜是谁、下挂哪些设备、设备名、额定电流、这台 EG 的访问令牌。
 *               子站 `pnpm eg:config` 生成，EG 上只读（改要回子站改 tb/model.yaml 再生成）。
 *   local.yaml  EG 本地：本机总线与本地 TB 的地址、摄像机地址与账号、管理页端口。本地管理页可改。
 *
 * I 阶段（后端库 docs/EG独立TB调整方案.md）：EG 跑独立 TB CE，不再是 TB Edge。
 *   eg.yaml 的 station 段多了子站 MQTT 地址与令牌（上送用，§8.1）、tb 段是本地 TB 的租户账号（provision:eg 建的，agent 读本地告警、写设备配置用）；
 *   eg.token 是本地 TB 上 EG 网关设备的令牌（IoT Gateway 连本地 TB 用）。
 *   local.yaml 的 mqtt.edge / docker.containers.edge 改名 tb，旧名照读。
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
  camera: {
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
  conn: { bus: string; tb: string; tbHttp: string; httpPort: number; stationHttp: string }
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
  camera: { onvif: '', user: 'admin', password: '', rtsp: { visible: '', thermal: '', visibleSub: '', thermalSub: '' } },
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

/** 读两份配置。local.yaml 没有就按默认值生成一份；环境变量 EG_BUS_MQTT / EG_TB_MQTT / EG_TB_HTTP / EG_HTTP_PORT / EG_STATION_HTTP 只改本进程自己的连接（开发用） */
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

/** E 阶段的 local.yaml（TB Edge）：mqtt.edge → mqtt.tb，docker.containers.edge → tb，edgeDb 不再用 */
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
 *  E 阶段的 eg.yaml 没有这一项，那时本地与子站是同一个令牌（Edge 同步下来的），用 eg.token */
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
