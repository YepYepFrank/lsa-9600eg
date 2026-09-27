// 开发机：准备 run/ 下的两份配置（开发计划 §6.2）
//
//   pnpm dev:config               默认 AH03
//   pnpm dev:config -- AH05       换一面柜
//
// eg.yaml 从子站后端仓库拷：I 阶段起是 provision:eg 生成的 tb/provision/out/eg/<柜号>.yaml（EG独立TB调整方案 §8.1），
// 还没有就用 E 阶段 eg:config 的 tb/provision/out/eg/<柜号>/eg.yaml。
// local.yaml 写开发环境的地址：总线、本地 TB 都是本仓库 compose 里的容器（deploy/dev/compose.yaml）。
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = process.env.LSA_BACKEND ?? resolve(ROOT, '../lsa-9600sp-backend')
const code = (process.argv.slice(2).find(a => a !== '--') ?? 'AH03').toUpperCase()

const candidates = [resolve(BACKEND, 'tb/provision/out/eg', `${code}.yaml`), resolve(BACKEND, 'tb/provision/out/eg', code, 'eg.yaml')]
const src = candidates.find(p => existsSync(p))
if (!src) {
  console.error(`没有 ${candidates.join(' 或 ')}\n先在后端仓库跑 provision:eg（I 阶段）或 pnpm eg:config -- --only ${code}`)
  process.exit(1)
}
const run = resolve(ROOT, 'run')
mkdirSync(run, { recursive: true })
copyFileSync(src, resolve(run, 'eg.yaml'))

const local = `# 开发机的 EG 本地配置（scripts/dev-config.mjs 生成）。地址是容器网络里的名字，给 IoT Gateway 用；
# 宿主机上的 eg-agent、emu 由 scripts/dev.mjs 用环境变量改连 127.0.0.1:11883（总线）、127.0.0.1:18080（本地 TB）
mqtt:
  bus: mqtt://mosquitto:1883
  tb: mqtt://eg-tb:1883
tb:
  http: http://eg-tb:8080
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
    tb: lsa-eg-tb
    gateway: lsa-eg-gateway
    mosquitto: lsa-eg-mosquitto
    mediamtx: lsa-eg-mediamtx
# G4：EG mediamtx 在容器里（RTSP 18554、API 映射到 127.0.0.1:19997）；子站 mediamtx 与宿主机上的 eg-video 都经 Docker 网关进来，读权限放开
video:
  rtspPort: 18554
  api: http://127.0.0.1:19997
  apiListen: ':9997'
  readFrom: ['0.0.0.0/0']
  apiFrom: ['0.0.0.0/0']
  closeAfter: 10s
  # G5：回放服务（裁证据片段）在容器里听 :9996、映射到 127.0.0.1:19996
  playback: http://127.0.0.1:19996
  playbackListen: ':9996'
# 摄像机用仿真器（packages/emu 的 /emu/cam）+ RTSP 测试源（deploy/dev 的 camera 容器，账号 admin / lsa-cam）
camera:
  driver: sim
  api: http://127.0.0.1:3190/emu/cam
  riseToleranceS: 15
  onvif: ''
  user: admin
  password: lsa-cam
  rtsp:
    visible: ''
    thermal: ''
    visibleSub: ''
    thermalSub: ''
`
writeFileSync(resolve(run, 'local.yaml'), local, 'utf8')
writeFileSync(resolve(run, 'dev-cabinet'), code, 'utf8')
console.log(`run/eg.yaml ← ${src}`)
console.log('run/local.yaml：总线 mosquitto、本地 TB eg-tb（本仓库 deploy/dev/compose.yaml）')
console.log(`子站模拟器要让出这面柜：pnpm sim -- --except ${code}`)
