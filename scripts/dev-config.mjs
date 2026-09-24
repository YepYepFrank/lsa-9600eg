// 开发机：准备 run/ 下的两份配置（开发计划 §6.2）
//
//   pnpm dev:config               默认 AH03
//   pnpm dev:config -- AH05       换一面柜
//
// eg.yaml 从子站后端仓库拷（那边先 pnpm eg:config -- --only <柜号>）；
// local.yaml 写开发环境的地址：总线是本仓库 compose 里的 mosquitto，Edge 是子站开发环境里本柜的 Edge 容器。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = process.env.LSA_BACKEND ?? resolve(ROOT, '../lsa-9600sp-backend')
const code = (process.argv.slice(2).find(a => a !== '--') ?? 'AH03').toUpperCase()

const src = resolve(BACKEND, 'tb/provision/out/eg', code, 'eg.yaml')
if (!existsSync(src)) {
  console.error(`没有 ${src}\n先在后端仓库跑：pnpm eg:config -- --only ${code} --sp host.docker.internal`)
  process.exit(1)
}
const run = resolve(ROOT, 'run')
mkdirSync(run, { recursive: true })
copyFileSync(src, resolve(run, 'eg.yaml'))

// 开发环境里各柜 Edge 的本地库建在子站的 PostgreSQL 里（tb_edge_<柜号>），口令在后端 docker/.env
const pgPass = (() => {
  try {
    return /^PG_PASSWORD=(.*)$/m.exec(readFileSync(resolve(BACKEND, 'docker/.env'), 'utf8'))?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
})()

const local = `# 开发机的 EG 本地配置（scripts/dev-config.mjs 生成）。地址是容器网络里的名字，给 IoT Gateway 用；
# 宿主机上的 eg-agent、emu 由 scripts/dev.mjs 用环境变量改连 127.0.0.1:11883
mqtt:
  bus: mqtt://mosquitto:1883
  edge: mqtt://edge-${code.toLowerCase()}:1883
http:
  port: 9100
# 开发机没有站内时钟源，对时偏差拿公网 NTP 测（现场留空 = 子站主机）
ntp:
  server: ntp.aliyun.com
net:
  uplink: ''
docker:
  api: npipe:////./pipe/docker_engine
  containers:
    edge: lsa-edge-${code.toLowerCase()}
    gateway: lsa-eg-gateway
    mosquitto: lsa-eg-mosquitto
    mediamtx: lsa-eg-mediamtx
edgeDb: postgres://postgres:${encodeURIComponent(pgPass)}@127.0.0.1:5432/tb_edge_${code.toLowerCase()}
camera:
  onvif: ''
  user: admin
  password: ''
  rtsp:
    visible: ''
    thermal: ''
    visibleSub: ''
    thermalSub: ''
`
writeFileSync(resolve(run, 'local.yaml'), local, 'utf8')
writeFileSync(resolve(run, 'dev-cabinet'), code, 'utf8')
console.log(`run/eg.yaml ← ${src}`)
console.log(`run/local.yaml：总线 mosquitto、Edge edge-${code.toLowerCase()}（子站开发环境的容器）`)
console.log(`子站模拟器要让出这面柜：pnpm sim -- --except ${code}`)
