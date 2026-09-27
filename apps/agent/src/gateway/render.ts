/* 生成 TB IoT Gateway 的配置（开发计划 §6.1）。
 *
 *   本机总线 lsa/<设备名>/telemetry  {"ts":毫秒,"values":{...}}  或其数组
 *   本机总线 lsa/<设备名>/attributes {...}
 *     ──► IoT Gateway 的 MQTT 连接器（内置 JSON 转换器，"*" 原样转发）──► EG 本地 TB（用 eg.token；I 阶段起是独立 TB CE，E 阶段是 TB Edge）
 *
 * 用 "*" 而不是逐个 key 映射：key 名本身就是接入规范 §6 的名字，网关不做换算；
 * 载荷是 {ts, values} 时 IoT Gateway 保留设备侧时间戳（3.8.5 的 TelemetryEntry，实测源码）。
 * 规范里的 key 带点（ir.t_max），逐个映射时 ${ir.t_max} 会被当成嵌套路径，"*" 也绕开了这个问题。
 *
 * 主题按设备清单逐台订阅，不用 lsa/+/…：
 *   - 清单外的名字（同事发错）不会在 Edge 上建出野设备；
 *   - EG 自己（lsa/EG-<柜号>/…）不能走这个连接器 —— 设备名与网关同名时 Edge 会断开网关会话（G0 实测），
 *     交给自定义连接器 LsaSelfConnector 经网关自己的会话发（deploy/tb-gateway/extensions/lsa）。
 *
 * 配置由 agent 按 eg.yaml / local.yaml 生成，IoT Gateway 的远程配置关掉（配置只有一个来源）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUS_TOPIC, type EgConfig } from '@lsa-eg/config'

/** IoT Gateway 在 Mosquitto 上的会话保留多久：它停得比这久，排着的数据才会丢 */
export const SESSION_EXPIRY_S = 86_400

export interface RenderResult {
  dir: string
  files: string[]
  /** 内容真变了、重写了的文件 */
  changed: string[]
}

/** 内容没变就不写：IoT Gateway 按文件的 stat 判配置变没变，一写就重载全部连接器
 *  （agent 每次启动都生成一遍；I1 发现重载带出过 LsaSelfConnector 的重复实例） */
function writeIfChanged(file: string, text: string): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false
  writeFileSync(file, text, 'utf8')
  return true
}

export function renderGatewayConfig(cfg: EgConfig, outDir = resolve(cfg.dir, 'gateway/config')): RenderResult {
  mkdirSync(outDir, { recursive: true })
  const tb = new URL(cfg.local.mqtt.tb)
  const bus = new URL(cfg.local.mqtt.bus)

  const gateway = {
    thingsboard: {
      host: tb.hostname,
      port: Number(tb.port || 1883),
      remoteShell: false,
      remoteConfiguration: false,
      latencyDebugMode: false,
      // 网关自己的统计遥测会挂到 EG 设备上、进子站库，没人看，关掉
      statistics: { enable: false, statsSendPeriodInSeconds: 3600, customStatsSendPeriodInSeconds: 3600 },
      deviceFiltering: { enable: false, filterFile: 'list.json' },
      maxPayloadSizeBytes: 8196,
      minPackSendDelayMS: 50,
      minPackSizeToSend: 500,
      checkConnectorsConfigurationInSeconds: 60,
      handleDeviceRenaming: false,
      security: { type: 'accessToken', accessToken: cfg.eg.token },
      qos: 1,
      // 收到就发、不去重：规范要求数值不变也按周期发，子站靠它判新鲜
      reportStrategy: { type: 'ON_RECEIVED' },
      checkingDeviceActivity: { checkDeviceInactivity: false, inactivityTimeoutSeconds: 300, inactivityCheckPeriodSeconds: 10 },
    },
    // 本地 TB 就在本机，断的只会是它重启那一会儿（实测 Edge 重启 43 s 无断档）；内存队列够用，不落盘（EG 的 SSD 省着用）
    storage: { type: 'memory', read_records_count: 100, max_records_count: 100000 },
    grpc: { enabled: false },
    connectors: [
      { type: 'mqtt', name: 'LSA 本机总线', configuration: 'mqtt.json' },
      { type: 'lsa', class: 'LsaSelfConnector', name: 'LSA EG 自身', configuration: 'lsa_self.json' },
    ],
  }

  const device = (name: string) => ({
    deviceNameExpressionSource: 'constant',
    deviceNameExpression: name,
    deviceProfileExpressionSource: 'constant',
    deviceProfileExpression: 'default',
  })
  const busSecurity = bus.username
    ? { type: 'basic', username: decodeURIComponent(bus.username), password: decodeURIComponent(bus.password) }
    : { type: 'anonymous' }

  const mqttConnector = {
    broker: {
      host: bus.hostname,
      port: Number(bus.port || 1883),
      clientId: `tb-gateway-${cfg.cabinet.code}`,
      version: 5,
      maxMessageNumberPerWorker: 10,
      maxNumberOfWorkers: 100,
      // 持久会话：IoT Gateway 重启那几秒同事发的数据由 Mosquitto 替它排着（固定 clientId + 不清会话，G1 实测）
      cleanSession: false,
      cleanStart: false,
      sessionExpiryInterval: SESSION_EXPIRY_S,
      security: busSecurity,
    },
    mapping: cfg.devices.flatMap(d => [
      {
        topicFilter: BUS_TOPIC.telemetry(d.name),
        subscriptionQos: 1,
        converter: { type: 'json', deviceInfo: device(d.name), timeout: 60000, attributes: [], timeseries: ['*'] },
      },
      {
        topicFilter: BUS_TOPIC.attributes(d.name),
        subscriptionQos: 1,
        converter: { type: 'json', deviceInfo: device(d.name), timeout: 60000, attributes: ['*'], timeseries: [] },
      },
    ]),
    requestsMapping: { connectRequests: [], disconnectRequests: [], attributeRequests: [], attributeUpdates: [], serverSideRpc: [] },
  }

  const selfConnector = {
    name: 'LSA EG 自身',
    device: cfg.eg.name,
    sessionExpiry: SESSION_EXPIRY_S,
    broker: {
      host: bus.hostname,
      port: Number(bus.port || 1883),
      username: bus.username ? decodeURIComponent(bus.username) : '',
      password: bus.password ? decodeURIComponent(bus.password) : '',
    },
  }

  const files: Record<string, unknown> = {
    'tb_gateway.json': gateway,
    'mqtt.json': mqttConnector,
    'lsa_self.json': selfConnector,
    'logs.json': logsConfig(),
  }
  const changed: string[] = []
  for (const [name, body] of Object.entries(files)) if (writeIfChanged(resolve(outDir, name), JSON.stringify(body, null, 2) + '\n')) changed.push(name)
  // 镜像的启动脚本见不到这个文件就会拿默认配置覆盖整个目录
  writeIfChanged(resolve(outDir, '.firstlaunch'), '# 配置由 eg-agent 生成（lsa-9600eg apps/agent/src/gateway/render.ts），不要让镜像覆盖\n')
  return { dir: outDir, files: [...Object.keys(files), '.firstlaunch'], changed }
}

/** 日志：只打控制台（docker 收），级别 WARNING；连接与连接器 INFO，排障够用又不刷屏 */
function logsConfig() {
  const logger = (level: string) => ({ handlers: ['consoleHandler'], level, propagate: false })
  return {
    version: 1,
    disable_existing_loggers: false,
    formatters: {
      LogFormatter: { class: 'logging.Formatter', format: '%(asctime)s |%(levelname)s| [%(name)s] %(message)s', datefmt: '%Y-%m-%d %H:%M:%S' },
    },
    handlers: { consoleHandler: { class: 'logging.StreamHandler', formatter: 'LogFormatter', level: 0, stream: 'ext://sys.stdout' } },
    loggers: {
      database: logger('WARNING'),
      service: logger('INFO'),
      connector: logger('INFO'),
      converter: logger('WARNING'),
      tb_connection: logger('INFO'),
      storage: logger('WARNING'),
      extension: logger('WARNING'),
    },
    root: { level: 'ERROR', handlers: ['consoleHandler'] },
  }
}
