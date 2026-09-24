/* G0 自检：开发样机的链路通不通。
 *
 *   pnpm g0:verify
 *
 * 前提：pnpm dev:config && pnpm dev:up；pnpm dev:emu、pnpm dev:agent 在跑；
 * 子站开发环境（TB、本柜 Edge）在跑，子站模拟器以 --except <柜号> 让出这面柜。
 *
 * 链路：emu ─► mosquitto ─► IoT Gateway ─► 本柜 Edge ─► 子站 TB；eg-agent 也在总线上。 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import mqtt from 'mqtt'
import { BUS_TOPIC, loadConfig } from '@lsa-eg/config'
import { agent } from './verify/lib.js'

const env = (k: string, d: string) => process.env[k] ?? d
const TB = env('TB_URL', 'http://localhost:8080')
const AGENT = env('EG_AGENT_URL', 'http://127.0.0.1:9100')
const BUS = env('EG_BUS_MQTT', 'mqtt://127.0.0.1:11883')
const SIM = env('SIM_URL', 'http://localhost:3100')
/** 数据新鲜的判据：快档 2 s，给 IoT Gateway + Edge + gRPC 一共留 8 s */
const FRESH_MS = 10_000

let pass = 0
let fail = 0
function check(ok: boolean, name: string, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function tbLogin(): Promise<Record<string, string>> {
  const r = await fetch(`${TB}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: env('TB_TENANT_USER', 'admin@lsa9600sp.local'), password: env('TB_TENANT_PASSWORD', 'lsa9600sp') }),
  })
  const { token } = (await r.json()) as { token: string }
  return { 'X-Authorization': `Bearer ${token}` }
}

/** 往本机总线发一条过去时刻的探针，等它出现在子站，再删掉（不留在子站库里） */
async function probe(H: Record<string, string>, device: string, now: number): Promise<{ ok: boolean; detail: string }> {
  const ts = Math.floor((now - 5 * 60_000) / 1000) * 1000
  const val = Math.round(Math.random() * 1e6)
  const client = await mqtt.connectAsync(BUS, { clientId: `g0-verify-${val}` })
  await client.publishAsync(BUS_TOPIC.telemetry(device), JSON.stringify({ ts, values: { 'g0.probe': val } }), { qos: 1 })
  await client.endAsync()
  const dev = (await (await fetch(`${TB}/api/tenant/devices?deviceName=${encodeURIComponent(device)}`, { headers: H })).json()) as { id: { id: string } }
  let got: { ts: number; value: string } | undefined
  for (let i = 0; i < 20 && !got; i++) {
    await sleep(1000)
    const r = (await (
      await fetch(`${TB}/api/plugins/telemetry/DEVICE/${dev.id.id}/values/timeseries?keys=g0.probe&startTs=${ts - 1}&endTs=${ts + 1}`, { headers: H })
    ).json()) as Record<string, { ts: number; value: string }[]>
    got = r['g0.probe']?.find(p => Number(p.value) === val)
  }
  await fetch(`${TB}/api/plugins/telemetry/DEVICE/${dev.id.id}/timeseries/delete?keys=g0.probe&deleteAllDataForKeys=true&deleteLatest=true`, {
    method: 'DELETE',
    headers: H,
  })
  return { ok: got?.ts === ts, detail: got ? `ts 差 ${got.ts - ts} ms` : '20 s 内没到' }
}

function dockerLogs(container: string, since?: string): string {
  try {
    const args = ['logs', ...(since ? ['--since', since] : ['--tail', '400']), container]
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '')
  }
}

async function main() {
  console.log('G0 自检：EG 开发样机\n')

  // 1. 配置
  const cfg = loadConfig()
  check(cfg.schema === 1 && !!cfg.eg.token && cfg.devices.length > 0, 'eg.yaml 可读', `${cfg.eg.name}，${cfg.devices.length} 台下挂设备`)
  const gwDir = resolve(cfg.dir, 'gateway/config')
  const gwFiles = ['tb_gateway.json', 'mqtt.json', 'lsa_self.json', 'logs.json', '.firstlaunch']
  check(gwFiles.every(f => existsSync(resolve(gwDir, f))), 'IoT Gateway 配置已生成', gwDir)
  const gw = JSON.parse(readFileSync(resolve(gwDir, 'tb_gateway.json'), 'utf8'))
  check(gw.thingsboard.security.accessToken === cfg.eg.token, 'IoT Gateway 用本 EG 的访问令牌连 Edge', `${gw.thingsboard.host}:${gw.thingsboard.port}`)
  check(gw.thingsboard.remoteConfiguration === false, 'IoT Gateway 远程配置已关（配置只有 eg-agent 一个来源）')

  // 2. 容器
  for (const c of ['lsa-eg-mosquitto', 'lsa-eg-gateway', `lsa-edge-${cfg.cabinet.code.toLowerCase()}`]) {
    let state = ''
    try {
      state = execFileSync('docker', ['inspect', '-f', '{{.State.Status}}', c], { encoding: 'utf8' }).trim()
    } catch {
      state = '不存在'
    }
    check(state === 'running', `容器 ${c} 在跑`, state)
  }
  const gwLog = dockerLogs('lsa-eg-gateway')
  check(/connected to platform/.test(gwLog), 'IoT Gateway 已连 Edge')
  check(new RegExp(`subscription success to topic lsa/${cfg.devices[0]!.name}/telemetry`).test(gwLog), 'IoT Gateway 按设备清单订阅本机总线')
  check(/Import LsaSelfConnector/.test(gwLog), 'IoT Gateway 加载了 EG 自身连接器（LsaSelfConnector）')

  // 3. eg-agent
  const st = await agent<{ bus: { connected: boolean }; devices: { name: string; kind: string; ageSec: number | null; keys: number }[]; unknownDevices: string[] }>(
    cfg.dir,
    '/api/status',
  ).catch(() => null)
  check(!!st, 'eg-agent 可达', AGENT)
  if (st) {
    check(st.bus.connected, 'eg-agent 已连本机总线')
    const sensors = st.devices.filter(d => d.kind !== 'camera')
    const stale = sensors.filter(d => d.ageSec === null || d.ageSec > 30)
    check(!stale.length, 'eg-agent 收到各传感器数据', stale.length ? `没数据：${stale.map(d => d.name).join('、')}` : `${sensors.length} 台`)
    check(!st.unknownDevices.length, '总线上没有清单外的设备名', st.unknownDevices.join('、'))
  }

  // 4. 子站：各设备的数据新鲜、时间戳是设备侧的
  const H = await tbLogin()
  const now = Date.now()
  for (const d of cfg.devices.filter(x => x.kind !== 'camera')) {
    const dev = (await (await fetch(`${TB}/api/tenant/devices?deviceName=${encodeURIComponent(d.name)}`, { headers: H })).json()) as { id: { id: string } }
    const keys = (await (await fetch(`${TB}/api/plugins/telemetry/DEVICE/${dev.id.id}/keys/timeseries`, { headers: H })).json()) as string[]
    const want = keys.filter(k => !k.startsWith('dev.') && k !== 'q' && k !== 'el.load_pct').slice(0, 40)
    const v = (await (await fetch(`${TB}/api/plugins/telemetry/DEVICE/${dev.id.id}/values/timeseries?keys=${want.join(',')}`, { headers: H })).json()) as Record<string, { ts: number }[]>
    const newest = Math.max(...Object.values(v).map(a => a[0]?.ts ?? 0))
    check(now - newest < FRESH_MS, `子站 ${d.name} 数据新鲜`, `最新一条距今 ${((now - newest) / 1000).toFixed(1)} s`)
  }

  // EG 自身指标（eg-agent 每 5 s 发）：子站靠它判 EG 在线、判 Edge 是否卡住
  const egDev = (await (await fetch(`${TB}/api/tenant/devices?deviceName=${encodeURIComponent(cfg.eg.name)}`, { headers: H })).json()) as { id: { id: string } }
  const egV = (await (await fetch(`${TB}/api/plugins/telemetry/DEVICE/${egDev.id.id}/values/timeseries?keys=eg.cpu,eg.mem,eg.state`, { headers: H })).json()) as Record<
    string,
    { ts: number; value: string }[]
  >
  const egAge = now - (egV['eg.cpu']?.[0]?.ts ?? 0)
  check(egAge < 15_000, `子站 ${cfg.eg.name} 的自身指标新鲜（eg-agent 发）`, `eg.cpu=${egV['eg.cpu']?.[0]?.value ?? '—'}，距今 ${(egAge / 1000).toFixed(1)} s`)

  // 设备侧时间戳：往总线发一条 5 分钟前的探针，子站上应按原时刻落位。
  // 下挂设备走 IoT Gateway 的 MQTT 连接器；EG 自己走自定义连接器 LsaSelfConnector（网关自己的会话）
  const cam = cfg.devices.find(d => d.kind === 'camera') ?? cfg.devices[0]!
  const since = new Date().toISOString()
  for (const [dev, what] of [
    [cam.name, '下挂设备'],
    [cfg.eg.name, 'EG 自身'],
  ] as const) {
    const r = await probe(H, dev, now)
    check(r.ok, `${what}（${dev}）设备侧时间戳原样到达子站`, r.detail)
  }
  const after = dockerLogs('lsa-eg-gateway', since)
  check(!/disconnected by server/.test(after), 'IoT Gateway 发 EG 自身数据时会话没被 Edge 断开', /disconnected by server/.test(after) ? '日志里有 disconnected by server' : '')

  // 5. 子站模拟器已让出这面柜（否则两路数据打架）
  const sim = await fetch(`${SIM}/sim/status`)
    .then(r => r.json() as Promise<{ cabinets: { code: string }[]; handed?: { code: string; linkUp: boolean | null }[] }>)
    .catch(() => null)
  if (sim) {
    check(!sim.cabinets.some(c => c.code === cfg.cabinet.code), `子站模拟器没在采 ${cfg.cabinet.code}`)
    const h = sim.handed?.find(x => x.code === cfg.cabinet.code)
    check(!!h && h.linkUp !== false, `子站模拟器为 ${cfg.cabinet.code} 转发上行`, h ? `linkUp=${h.linkUp}` : '没有 --except')
  } else check(false, '子站模拟器控制面可达', `${SIM}（Edge 的上行经它转发）`)

  console.log(`\n${pass} 项通过，${fail} 项失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.message : e)
  process.exit(1)
})
