/* I1 自检：EG 样机换成独立 ThingsBoard CE（后端库 docs/EG独立TB调整方案.md §5 I1）。
 *
 *   pnpm i1:verify
 *
 * 前提：pnpm dev:up（本地 TB、PostgreSQL、Mosquitto、IoT Gateway）、后端库 provision:eg 已对本地 TB 建好实体、
 * pnpm dev:config 拷来的 eg.yaml 带 tb 账号；dev:emu、dev:agent 在跑。
 * 验收：AH03 数据进本地 TB、本地 7 类告警能触发（仿真器打弧光）、本地 TB 内存实测。
 * I1 期间子站上 AH03 没有数据是正常的（I2 才上送）。 */
import { readFileSync, utimesSync } from 'node:fs'
import { resolve } from 'node:path'
import mqtt from 'mqtt'
import { BUS_TOPIC, loadConfig } from '@lsa-eg/config'
import { agent, BUS, check, containerMemMb, docker, done, EMU, env, post, sleep, Tb, until } from './verify/lib.js'

const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const ALARM_TYPES = ['过温', '绝对超温', '局放异常', '弧光异常', '环境', '过载', '烟气']

async function main() {
  console.log('I1 自检：EG 样机的本地 ThingsBoard\n')
  const cfg = loadConfig()
  const code = cfg.cabinet.code

  console.log('1. 配置')
  check(!!cfg.tb?.user && !!cfg.tb?.password, 'eg.yaml 带本地 TB 账号（provision:eg 建的）', cfg.tb?.user ?? '没有')
  check(!!cfg.station.mqtt && !!cfg.station.token, 'eg.yaml 带子站上送地址与令牌（I2 用）', cfg.station.mqtt ?? '没有')
  const gw = JSON.parse(readFileSync(resolve(cfg.dir, 'gateway/config/tb_gateway.json'), 'utf8'))
  check(gw.thingsboard.host === new URL(cfg.local.mqtt.tb).hostname, 'IoT Gateway 配置指向本地 TB', `${gw.thingsboard.host}:${gw.thingsboard.port}`)

  console.log('\n2. 容器')
  const state = (c: string) => docker('inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', c).trim() || '不存在'
  for (const c of ['lsa-eg-postgres', 'lsa-eg-tb', 'lsa-eg-mosquitto', 'lsa-eg-gateway']) {
    const s = state(c)
    check(s.startsWith('running') && !s.includes('unhealthy'), `容器 ${c} 在跑`, s)
  }
  const edge = state(`lsa-edge-${code.toLowerCase()}`)
  check(!edge.startsWith('running'), `本柜的 TB Edge 容器已停（lsa-edge-${code.toLowerCase()}）`, edge)
  const gwLog = docker('logs', '--since', '30m', 'lsa-eg-gateway')
  check(/connected to platform eg-tb/.test(gwLog) || /connected to platform/.test(gwLog), 'IoT Gateway 已连本地 TB')

  console.log('\n3. 本地 TB 的实体（provision:eg）')
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const names = [cfg.eg.name, ...cfg.devices.map(d => d.name)]
  const missing: string[] = []
  for (const n of names) {
    try {
      await tb.id(n)
    } catch {
      missing.push(n)
    }
  }
  check(!missing.length, `${names.length} 台设备都建了（名字与 eg.yaml 一致）`, missing.join('、'))
  const profiles = await tb.get<{ data: { name: string; profileData?: { alarms?: { alarmType: string }[] | null } }[] }>('/api/deviceProfiles?pageSize=100&page=0')
  const types = new Set(profiles.data.flatMap(p => (p.profileData?.alarms ?? []).map(a => a.alarmType)))
  const lack = ALARM_TYPES.filter(t => !types.has(t))
  check(!lack.length, '设备配置里有 7 类告警规则', lack.length ? `缺 ${lack.join('、')}` : [...types].join('、'))

  console.log('\n4. 数据进本地 TB')
  const now = Date.now()
  for (const d of cfg.devices.filter(x => x.kind !== 'camera')) {
    const keys = await tb.get<string[]>(`/api/plugins/telemetry/DEVICE/${await tb.id(d.name)}/keys/timeseries`)
    const v = await tb.latest(d.name, keys.filter(k => k !== 'q' && !k.startsWith('dev.')).slice(0, 40))
    const newest = Math.max(0, ...Object.values(v).map(p => p?.ts ?? 0))
    check(now - newest < 10_000, `本地 TB 上 ${d.name} 数据新鲜`, `${keys.length} 个 key，最新一条距今 ${((now - newest) / 1000).toFixed(1)} s`)
  }
  const eg = await tb.latest(cfg.eg.name, ['eg.cpu', 'eg.state'])
  check(!!eg['eg.cpu'] && now - eg['eg.cpu'].ts < 15_000, `本地 TB 上 ${cfg.eg.name} 的自身指标新鲜（经 LsaSelfConnector）`, `eg.state=${eg['eg.state']?.value}`)
  // 设备侧时间戳：发一条 5 分钟前的探针，本地 TB 上应按原时刻落位
  const cam = cfg.devices.find(d => d.kind === 'camera') ?? cfg.devices[0]!
  const probeTs = Math.floor((now - 5 * 60_000) / 1000) * 1000
  const val = Math.round(Math.random() * 1e6)
  const c = await mqtt.connectAsync(BUS, { clientId: `i1-verify-${val}` })
  await c.publishAsync(BUS_TOPIC.telemetry(cam.name), JSON.stringify({ ts: probeTs, values: { 'i1.probe': val } }), { qos: 1 })
  await c.endAsync()
  const got = await until(async () => {
    const r = await tb.get<Record<string, { ts: number; value: string }[]>>(
      `/api/plugins/telemetry/DEVICE/${await tb.id(cam.name)}/values/timeseries?keys=i1.probe&startTs=${probeTs - 1}&endTs=${probeTs + 1}`,
    )
    return r['i1.probe']?.find(p => Number(p.value) === val)
  }, 20_000, 1000)
  check(got?.ts === probeTs, '设备侧时间戳原样进本地 TB', got ? `差 ${got.ts - probeTs} ms` : '20 s 内没到')
  await fetch(`${LOCAL_TB}/api/plugins/telemetry/DEVICE/${await tb.id(cam.name)}/timeseries/delete?keys=i1.probe&deleteAllDataForKeys=true&deleteLatest=true`, {
    method: 'DELETE',
    headers: tb.headers,
  })

  console.log('\n5. 本地告警：仿真器打一次弧光')
  const t0 = Date.now()
  const arc = (await post(`${EMU}/emu/arc?intensity=520&ms=30`)) as { device: string }
  check(!!arc.device, '仿真器打了弧光', arc.device)
  const alarm = await until(async () => (await tb.alarms(arc.device)).find(a => a.type === '弧光异常' && a.createdTime >= t0 - 5000), 20_000, 1000)
  check(!!alarm, '本地 TB 在 20 s 内建了「弧光异常」告警', alarm ? `${alarm.severity}，${((alarm.createdTime - t0) / 1000).toFixed(1)} s` : '没有')
  if (alarm) {
    // 弧光规则：强度在限值以下持续 60 s 即恢复（仿真器平时每 2 s 报 uv.int 背景值）
    const cleared = await until(
      async () => (await tb.alarms(arc.device)).find(a => a.id.id === alarm.id.id && (a.status.startsWith('CLEARED') || a.cleared)),
      120_000,
      5000,
    )
    check(!!cleared, '60 s 无放电后本地自动恢复', cleared ? `${Math.round((Date.now() - t0) / 1000)} s` : '2 分钟内没恢复')
  }

  console.log('\n6. EG 自身连接器稳定（I1 连通性测试发现的缺陷：重载后多实例互踢、eg.state 抖）')
  const w0 = new Date().toISOString()
  await sleep(120_000)
  const took = docker('logs', '--since', w0, 'lsa-eg-mosquitto')
    .split('\n')
    .filter(l => l.includes('tb-gateway-self') && l.includes('taken over')).length
  check(took === 0, 'LsaSelfConnector 只有一个会话（2 分钟内没有 session taken over）', `${took} 次`)
  const states = await tb.history(cfg.eg.name, 'eg.state', Date.parse(w0), Date.now())
  const bad = states.filter(p => p.value !== 'online')
  check(states.length >= 20 && !bad.length, '2 分钟内本地 TB 上 eg.state 一直是 online（不抖）', `${states.length} 条，非 online ${bad.length} 条`)

  console.log('\n6b. IoT Gateway 重载连接器后 EG 自身数据不断（I4 发现：重载时关旧实例卡死网关主线程）')
  // IoT Gateway 每 60 s 按文件 stat 查一次配置，变了就重载全部连接器；只改修改时间就能触发
  const r0 = new Date().toISOString()
  utimesSync(resolve(cfg.dir, 'gateway/config/lsa_self.json'), new Date(), new Date())
  const reloaded = await until(async () => /LSA EG 自身: 订阅本机总线/.test(docker('logs', '--since', r0, 'lsa-eg-gateway')), 100_000, 2000)
  check(!!reloaded, '改配置文件后 IoT Gateway 重载了 EG 自身连接器（新实例订阅上了）')
  const tR = Date.now()
  await sleep(15_000)
  const fresh = (await tb.latest(cfg.eg.name, ['eg.cpu']))['eg.cpu']
  check(!!fresh && fresh.ts > tR, '重载后 EG 自身指标照常进本地 TB', fresh ? `最新一条距今 ${((Date.now() - fresh.ts) / 1000).toFixed(1)} s` : '没有')
  const probe = `p${Date.now()}`
  const pc = await mqtt.connectAsync(BUS, { clientId: `i1-attr-${probe}`, protocolVersion: 5 })
  await pc.publishAsync(BUS_TOPIC.attributes(cfg.eg.name), JSON.stringify({ i1Probe: probe }), { qos: 1 })
  await pc.endAsync()
  const attrOk = await until(async () => ((await tb.attr(cfg.eg.name, 'CLIENT_SCOPE', 'i1Probe')) === probe ? true : null), 15_000, 1000)
  check(!!attrOk, 'EG 自身属性也进本地 TB（cfg、egAgentVersion 走这条）')
  await sleep(20_000)
  const again = docker('logs', '--since', new Date(tR).toISOString(), 'lsa-eg-mosquitto')
    .split('\n')
    .filter(l => l.includes('tb-gateway-self') && l.includes('taken over')).length
  check(again === 0, '重载之后没有反复 session taken over', `${again} 次`)

  console.log('\n7. 资源（开发机实测）')
  await sleep(1000)
  const tbMem = containerMemMb('lsa-eg-tb')
  const pgMem = containerMemMb('lsa-eg-postgres')
  check(tbMem !== null && tbMem < 1400, '本地 TB 内存', `${tbMem?.toFixed(0)} MB（Edge 时代 770–810 MB）`)
  check(pgMem !== null, '本地 PostgreSQL 内存', `${pgMem?.toFixed(0)} MB`)
  const comps = await agent<{ key: string; state: string; memMb: number | null }[]>(cfg.dir, '/api/components')
  const tbc = comps.find(x => x.key === 'tb')
  check(tbc?.state === 'running', '本地管理页的组件列表认得本地 TB', `${tbc?.memMb} MB`)

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
