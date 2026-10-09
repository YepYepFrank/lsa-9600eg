// EG 发布件（I5 / G6，docs/EG部署手册.md）：一份发布件所有 EG 通用；每台 EG 自己的 eg.yaml（含令牌）由子站生成、单独拷。
//
//   pnpm pack:eg                 出 dist/eg-<版本>/：compose、安装脚本、Mosquitto 配置、自定义连接器、磁盘检查；应用镜像构建上下文
//   pnpm pack:eg -- --images     连同全部镜像（构建 lsa-eg-app 镜像、拉其余镜像，导出 images-amd64.tar.gz；要联网、几分钟）
//   pnpm pack:eg -- --debs       连同 Docker 与 chrony 的离线 deb（Ubuntu 24.04 amd64，在一次性 ubuntu:24.04 容器里下；要联网）
//   pnpm pack:eg -- --images --debs   离线全量（G6：装到裸 Ubuntu 上不联网）
//   pnpm pack:eg -- --test       另出测试件 dist/eg-<版本>-test/（仿真器 + RTSP 测试源，虚拟样机验收用，现场不装；不进 IMAGES.txt）
//
// 镜像只出 amd64（X26A 是 x86_64，开发计划 §1）。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = process.env.LSA_BACKEND ?? resolve(ROOT, '../lsa-9600sp-backend')
const IMAGES = process.argv.includes('--images')
const DEBS = process.argv.includes('--debs')
const TEST = process.argv.includes('--test')
/** 转换程序镜像（I11）：--conv <本机已有的镜像 tag>，随发布件走（images-conv.tar.gz、CONV_IMAGE.txt） */
const CONV = (() => {
  const i = process.argv.indexOf('--conv')
  return i >= 0 ? process.argv[i + 1] : null
})()
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
const out = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim()

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const rev = out('git', ['rev-parse', '--short', 'HEAD'])
const dirty = out('git', ['status', '--porcelain']) ? '-dirty' : ''
const VERSION = `${pkg.version}-${rev}${dirty}`
const DIST = resolve(ROOT, 'dist', `eg-${VERSION}`)
const STAGE = resolve(ROOT, 'dist', '.stage-app')

/** 第三方镜像：与 deploy/eg/compose.yaml 的缺省版本一致 */
const THIRD = ['postgres:16', 'thingsboard/tb-node:4.2.2.5', 'eclipse-mosquitto:2.1.2', 'thingsboard/tb-gateway:3.8.5', 'bluenviron/mediamtx:1.21.1']

console.log(`EG 发布件 ${VERSION}\n`)
for (const p of ['packages/model', 'packages/points']) {
  if (!existsSync(resolve(BACKEND, p, 'package.json'))) throw new Error(`找不到后端库的 ${p}（${BACKEND}；可设 LSA_BACKEND）`)
}

// 1. 管理页
console.log('1. 构建本地管理页')
run('pnpm', ['-F', '@lsa-eg/admin-web', 'build'], { shell: process.platform === 'win32' })

// 2. 应用镜像（agent + video）的构建上下文：EG 工作区的子集 + 后端两个包（vendored，link: 改 workspace:*）
console.log('\n2. 应用镜像构建上下文')
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
const skip = src => !/[\\/](node_modules|dist)([\\/]|$)/.test(src) && !/[\\/]src[\\/]_tmp/.test(src)
cpSync(resolve(ROOT, 'apps/agent'), resolve(STAGE, 'apps/agent'), { recursive: true, filter: skip })
cpSync(resolve(ROOT, 'apps/video'), resolve(STAGE, 'apps/video'), { recursive: true, filter: skip })
cpSync(resolve(ROOT, 'packages/config'), resolve(STAGE, 'packages/config'), { recursive: true, filter: skip })
cpSync(resolve(BACKEND, 'packages/model'), resolve(STAGE, 'packages/lsa-model'), { recursive: true, filter: skip })
cpSync(resolve(BACKEND, 'packages/points'), resolve(STAGE, 'packages/lsa-points'), { recursive: true, filter: skip })
cpSync(resolve(ROOT, 'apps/admin-web/dist'), resolve(STAGE, 'web'), { recursive: true })
cpSync(resolve(ROOT, 'pnpm-lock.yaml'), resolve(STAGE, 'pnpm-lock.yaml'))
// 各包的 tsconfig 都 extends ../../tsconfig.base.json，运行时 swc 按它编译（缺了 agent 起不来，I5 冒烟测试发现）
cpSync(resolve(ROOT, 'tsconfig.base.json'), resolve(STAGE, 'tsconfig.base.json'))
cpSync(resolve(ROOT, 'deploy/eg/app.Dockerfile'), resolve(STAGE, 'Dockerfile'))
const agentPkg = JSON.parse(readFileSync(resolve(STAGE, 'apps/agent/package.json'), 'utf8'))
for (const k of ['@lsa/model', '@lsa/points']) agentPkg.dependencies[k] = 'workspace:*'
writeFileSync(resolve(STAGE, 'apps/agent/package.json'), JSON.stringify(agentPkg, null, 2) + '\n')
writeFileSync(resolve(STAGE, 'package.json'), JSON.stringify({ name: 'lsa9600eg-app', private: true, version: VERSION, type: 'module', packageManager: pkg.packageManager }, null, 2) + '\n')
writeFileSync(resolve(STAGE, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n")
writeFileSync(resolve(STAGE, '.dockerignore'), '**/node_modules\n')
// 后端库的提交号记下来（两边要配套）
const backendRev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: BACKEND, encoding: 'utf8' }).trim()
console.log(`  → ${STAGE}（后端包取自 ${backendRev}）`)

// 3. 发布件
console.log('\n3. 发布件')
rmSync(DIST, { recursive: true, force: true })
mkdirSync(resolve(DIST, 'config'), { recursive: true })
for (const f of ['compose.yaml', 'mosquitto.conf', 'install.sh', 'diskcheck.sh']) cpSync(resolve(ROOT, 'deploy/eg', f), resolve(DIST, f))
cpSync(resolve(ROOT, 'deploy/tb-gateway/extensions/lsa'), resolve(DIST, 'extensions/lsa'), { recursive: true, filter: s => !/__pycache__/.test(s) })
// 装到 Linux 上：脚本与配置一律 LF（Windows 上打包时防 CRLF，子站 Linux 复测踩过）
for (const f of ['compose.yaml', 'mosquitto.conf', 'install.sh', 'diskcheck.sh', 'extensions/lsa/lsa_self_connector.py']) {
  const p = resolve(DIST, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
}
writeFileSync(resolve(DIST, 'VERSION'), VERSION + '\n')
writeFileSync(
  resolve(DIST, 'README.txt'),
  `LSA-9600EG 发布件 ${VERSION}（EG 库 ${rev}${dirty}，后端包 ${backendRev}）\n\n` +
    '装法见 EG 库 docs/EG部署手册.md。简要：\n' +
    '  1. 整个目录拷到 EG 的 /opt/lsa-eg\n' +
    '  2. sudo bash install.sh --lan1 <摄像机网口>   （没有 Docker 先装 debs/ 里的离线包、导入镜像、起本地 TB）\n' +
    '  3. 子站经 SSH 隧道跑 provision:eg，把生成的 eg.yaml（及 sp-ca.pem）拷到 config/\n' +
    '  4. sudo bash install.sh              （起全部）\n' +
    '升级：新发布件整个拷过来覆盖后再跑 sudo bash install.sh；回退：sudo bash install.sh --rollback\n',
)
console.log(`  → ${DIST}`)

// 4. 镜像
if (IMAGES) {
  console.log('\n4. 镜像（amd64）')
  const appImg = `lsa-eg-app:${VERSION}`
  run('docker', ['build', '--platform', 'linux/amd64', '-t', appImg, STAGE])
  // 本机已有就不拉（与开发编排用的是同一份；拉不下来时也能出包），没有才拉
  const has = img => {
    try {
      return out('docker', ['image', 'inspect', '-f', '{{.Architecture}}', img]) === 'amd64'
    } catch {
      return false
    }
  }
  for (const img of THIRD) if (!has(img)) run('docker', ['pull', '-q', '--platform', 'linux/amd64', img])
  // 镜像清单：确切的 tag、仓库 digest、镜像 ID（install.sh 导入后逐个核对 ID）；不用 latest
  const lines = [appImg, ...THIRD].map(img => {
    if (/:latest$/.test(img)) throw new Error(`发布件不用 latest：${img}`)
    const id = out('docker', ['image', 'inspect', '-f', '{{.Id}}', img])
    const repo = img.slice(0, img.lastIndexOf(':'))
    const digests = JSON.parse(out('docker', ['image', 'inspect', '-f', '{{json .RepoDigests}}', img])) ?? []
    const digest = (digests.find(d => d.startsWith(repo + '@')) ?? '-').split('@').pop()
    return `${img} ${digest} ${id}`
  })
  writeFileSync(resolve(DIST, 'IMAGES.txt'), '# 镜像 tag、仓库 digest（本地构建的为 -）、镜像 ID —— install.sh 导入后按 ID 核对\n' + lines.join('\n') + '\n')
  console.log(lines.map(l => '  ' + l).join('\n'))
  const tar = resolve(DIST, 'images-amd64.tar')
  run('docker', ['save', '-o', tar, appImg, ...THIRD])
  run('gzip', ['-1', '-f', tar])
  console.log(`  → ${tar}.gz`)
  if (CONV) {
    if (/:latest$/.test(CONV) || !CONV.includes(':')) throw new Error(`转换程序镜像要带确切的 tag（不用 latest）：${CONV}`)
    const id = out('docker', ['image', 'inspect', '-f', '{{.Id}}', CONV])
    writeFileSync(resolve(DIST, 'CONV_IMAGE.txt'), `# 转换程序镜像（install.sh 读第一行；镜像 ID ${id}）\n${CONV}\n`)
    writeFileSync(resolve(DIST, 'IMAGES.txt'), readFileSync(resolve(DIST, 'IMAGES.txt'), 'utf8') + `${CONV} - ${id}\n`)
    const ct = resolve(DIST, 'images-conv.tar')
    run('docker', ['save', '-o', ct, CONV])
    run('gzip', ['-1', '-f', ct])
    console.log(`  转换程序 ${CONV} → ${ct}.gz`)
  }
} else {
  console.log('\n（没带 --images：发布件里没有镜像。EG 能联网拉镜像时可以这样装，应用镜像要另行构建：docker build -t lsa-eg-app:<版本> dist/.stage-app）')
}
// 5. Docker 与 chrony 的离线包：在干净的 ubuntu:24.04 容器里只下不装（下的是容器里没有的全部依赖，比服务器版多，多了不碍事）
if (DEBS) {
  console.log('\n5. 离线 deb（Docker CE、compose 插件、chrony；Ubuntu 24.04 amd64）')
  const debs = resolve(DIST, 'debs')
  mkdirSync(debs, { recursive: true })
  const sh = [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null',
    'install -m 0755 -d /etc/apt/keyrings',
    'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
    'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list',
    'apt-get update -qq',
    'rm -f /var/cache/apt/archives/*.deb',
    'apt-get install -y -qq --download-only --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin chrony',
    'cp /var/cache/apt/archives/*.deb /out/',
    'ls /out | wc -l',
  ].join(' && ')
  run('docker', ['run', '--rm', '--platform', 'linux/amd64', '-v', `${debs}:/out`, 'ubuntu:24.04', 'bash', '-c', sh])
  console.log(`  → ${debs}`)
}
// 6. 测试件：emu 镜像（应用镜像的构建上下文 + packages/emu）、RTSP 测试源镜像、compose.test.yaml、test.sh
if (TEST) {
  console.log('\n6. 测试件（现场不装）')
  const stageT = resolve(ROOT, 'dist', '.stage-test')
  const distT = resolve(ROOT, 'dist', `eg-${VERSION}-test`)
  rmSync(stageT, { recursive: true, force: true })
  rmSync(distT, { recursive: true, force: true })
  cpSync(STAGE, stageT, { recursive: true })
  cpSync(resolve(ROOT, 'packages/emu'), resolve(stageT, 'packages/emu'), { recursive: true, filter: skip })
  const emuPkg = JSON.parse(readFileSync(resolve(stageT, 'packages/emu/package.json'), 'utf8'))
  for (const k of ['@lsa/model', '@lsa/points']) emuPkg.dependencies[k] = 'workspace:*'
  writeFileSync(resolve(stageT, 'packages/emu/package.json'), JSON.stringify(emuPkg, null, 2) + '\n')
  const emuImg = `lsa-eg-emu:${VERSION}`
  const camImg = 'bluenviron/mediamtx:1.21.1-ffmpeg'
  run('docker', ['build', '--platform', 'linux/amd64', '-t', emuImg, stageT])
  try {
    out('docker', ['image', 'inspect', camImg])
  } catch {
    run('docker', ['pull', '-q', '--platform', 'linux/amd64', camImg])
  }
  mkdirSync(distT, { recursive: true })
  const tar = resolve(distT, 'images-test-amd64.tar')
  run('docker', ['save', '-o', tar, emuImg, camImg])
  run('gzip', ['-1', '-f', tar])
  for (const [from, to] of [['deploy/test/compose.test.yaml', 'compose.test.yaml'], ['deploy/test/test.sh', 'test.sh'], ['deploy/dev/camera.yml', 'camera.yml']]) {
    writeFileSync(resolve(distT, to), readFileSync(resolve(ROOT, from), 'utf8').replace(/\r\n/g, '\n'))
  }
  writeFileSync(resolve(distT, 'VERSION'), VERSION + '\n')
  console.log(`  → ${distT}（拷到 EG 的 /opt/lsa-eg/test/，sudo bash test/test.sh up）`)
}
console.log('\n完成。')
