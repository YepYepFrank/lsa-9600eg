/* G0 自检：开发样机的链路通不通（EG 本地跑独立 TB CE，开发计划 v0.4）。
 *
 *   pnpm g0:verify
 *
 * 前提：pnpm dev:config && pnpm dev:up；pnpm dev:emu、pnpm dev:agent 在跑；本地 TB 已 provision:eg。
 * 链路：emu ─► mosquitto ─► IoT Gateway ─► EG 本地 TB；eg-agent 也在总线上，打开上送时经 outbox 送子站 TB。
 * agent 以 EG_UPLINK=off 起时，子站那几项跳过（只验本地一段）。 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import mqtt from 'mqtt'
import { BUS_TOPIC, loadConfig } from '@lsa-eg/config'
import { agent, BUS, check, docker, done, env, SIM, sleep, Tb } from './verify/lib.js'

const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
/** 数据新鲜的判据：快档 2 s，给 IoT Gateway + 本地 TB（或 outbox + 子站 TB）留 8 s */
const FRESH_MS = 10_000

/** 往本机总线发一条过去时刻的探针，等它在 tb 上按原时刻出现，再删掉 */
async function probe(tb: Tb, device: string, now: number): Promise<{ ok: boolean; detail: string }> {
  const ts = Math.floor((now - 5 * 60_000) / 1000) * 1000
  const val = Math.round(Math.random() * 1e6)
  const client = await mqtt.connectAsync(BUS, { clientId: `g0-verify-${val}` })
  await client.publishAsync(BUS_TOPIC.telemetry(device), JSON.stringify({ ts, values: { 'g0.probe': val } }), { qos: 1 })
  await client.endAsync()
  const id = await tb.id(device)
  let got: { ts: number; value: string } | undefined
  for (let i = 0; i < 20 && !got; i++) {
    await sleep(1000)
    const r = await tb.get<Record<string, { ts: number; value: string }[]>>(`/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=g0.probe&startTs=${ts - 1}&endTs=${ts + 1}`)
    got = r['g0.probe']?.find(p => Number(p.value) === val)
  }
  await fetch(`${tb.base}/api/plugins/telemetry/DEVICE/${id}/timeseries/delete?keys=g0.probe&deleteAllDataForKeys=true&deleteLatest=true`, { method: 'DELETE', headers: tb.headers })
  return { ok: got?.ts === ts, detail: got ? `ts 差 ${got.ts - ts} ms` : '20 s 内没到' }
}

async function main() {
  console.log('G0 自检：EG 开发样机\n')

  console.log('1. 配置')
  const cfg = loadConfig()
  check(cfg.schema === 1 && !!cfg.eg.token && cfg.devices.length > 0, 'eg.yaml 可读', `${cfg.eg.name}，${cfg.devices.length} 台下挂设备`)
  const gwDir = resolve(cfg.dir, 'gateway/config')
  check(['tb_gateway.json', 'mqtt.json', 'lsa_self.json', 'logs.json', '.firstlaunch'].every(f => existsSync(resolve(gwDir, f))), 'IoT Gateway 配置已生成', gwDir)
  const gw = JSON.parse(readFileSync(resolve(gwDir, 'tb_gateway.json'), 'utf8'))
  check(gw.thingsboard.security.accessToken === cfg.eg.token && gw.thingsboard.host === new URL(cfg.local.mqtt.tb).hostname, 'IoT Gateway 用本 EG 的令牌连本地 TB', `${gw.thingsboard.host}:${gw.thingsboard.port}`)
  check(gw.thingsboard.remoteConfiguration === false, 'IoT Gateway 远程配置已关（配置只有 eg-agent 一个来源）')

  console.log('\n2. 容器')
  for (const c of ['lsa-eg-postgres', 'lsa-eg-tb', 'lsa-eg-mosquitto', 'lsa-eg-gateway']) {
    const s = docker('inspect', '-f', '{{.State.Status}}', c).trim() || '不存在'
    check(s === 'running', `容器 ${c} 在跑`, s)
  }
  const gwLog = docker('logs', '--tail', '2000', 'lsa-eg-gateway')
  check(/connected to platform/.test(gwLog), 'IoT Gateway 已连本地 TB')
  check(new RegExp(`subscription success to topic lsa/${cfg.devices[0]!.name}/telemetry`).test(gwLog), 'IoT Gateway 按设备清单订阅本机总线')
  check(/LsaSelfConnector/.test(gwLog), 'IoT Gateway 加载了 EG 自身连接器（LsaSelfConnector）')

  console.log('\n3. eg-agent')
  const st = await agent<{ bus: { connected: boolean }; devices: { name: string; kind: string; ageSec: number | null }[]; unknownDevices: string[] }>(cfg.dir, '/api/status').catch(() => null)
  check(!!st, 'eg-agent 可达')
  if (st) {
    check(st.bus.connected, 'eg-agent 已连本机总线')
    const sensors = st.devices.filter(d => d.kind !== 'camera')
    const stale = sensors.filter(d => d.ageSec === null || d.ageSec > 30)
    check(!stale.length, 'eg-agent 收到各传感器数据', stale.length ? `没数据：${stale.map(d => d.name).join('、')}` : `${sensors.length} 台`)
    check(!st.unknownDevices.length, '总线上没有清单外的设备名', st.unknownDevices.join('、'))
  }
  const uplink = (await agent<{ uplink: { state: string } }>(cfg.dir, '/api/diag').catch(() => null))?.uplink.state ?? 'none'

  const now = Date.now()
  const tbs: [string, Tb][] = [['本地 TB', await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()]]
  if (uplink !== 'none') tbs.push(['子站 TB', await new Tb().login()])
  else console.log('\n（上送没开：子站那几项跳过）')
  for (const [label, tb] of tbs) {
    console.log(`\n4. ${label}：各设备数据新鲜、设备侧时间戳原样落位`)
    for (const d of cfg.devices.filter(x => x.kind !== 'camera')) {
      const keys = (await tb.get<string[]>(`/api/plugins/telemetry/DEVICE/${await tb.id(d.name)}/keys/timeseries`)).filter(k => !k.startsWith('dev.') && k !== 'q' && k !== 'el.load_pct').slice(0, 40)
      const v = await tb.latest(d.name, keys)
      const newest = Math.max(0, ...Object.values(v).map(p => p?.ts ?? 0))
      check(now - newest < FRESH_MS, `${label}上 ${d.name} 数据新鲜`, `最新一条距今 ${((now - newest) / 1000).toFixed(1)} s`)
    }
    const eg = await tb.latest(cfg.eg.name, ['eg.cpu'])
    check(!!eg['eg.cpu'] && now - eg['eg.cpu'].ts < 15_000, `${label}上 ${cfg.eg.name} 的自身指标新鲜（eg-agent 发）`)
    // 下挂设备走 IoT Gateway 的 MQTT 连接器（本地）/ outbox（子站）；EG 自己走 LsaSelfConnector（本地）
    const cam = cfg.devices.find(d => d.kind === 'camera') ?? cfg.devices[0]!
    for (const [dev, what] of [
      [cam.name, '下挂设备'],
      [cfg.eg.name, 'EG 自身'],
    ] as const) {
      const r = await probe(tb, dev, now)
      check(r.ok, `${what}（${dev}）设备侧时间戳原样到${label}`, r.detail)
    }
  }

  console.log('\n5. 子站模拟器让出了这面柜（否则两路数据打架）')
  const sim = await fetch(`${SIM}/sim/status`)
    .then(r => r.json() as Promise<{ cabinets?: { code: string }[] }>)
    .catch(() => null)
  if (sim?.cabinets) check(!sim.cabinets.some(c => c.code === cfg.cabinet.code), `子站模拟器没在出 ${cfg.cabinet.code}`)
  else console.log(`  · 子站模拟器控制面 ${SIM} 不可达或没有柜清单，跳过`)

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.message : e)
  process.exit(1)
})
