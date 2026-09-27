// EG 发布件（I5 / G6，docs/EG部署手册.md）：一份发布件所有 EG 通用；每台 EG 自己的 eg.yaml（含令牌）由子站生成、单独拷。
//
//   pnpm pack:eg                 出 dist/eg-<版本>/：compose、安装脚本、Mosquitto 配置、自定义连接器、agent 镜像构建上下文
//   pnpm pack:eg -- --images     连同全部镜像（构建 eg-agent 镜像、拉其余镜像，导出 images-amd64.tar.gz；要联网、几分钟）
//
// 镜像只出 amd64（X26A 是 x86_64，开发计划 §1）。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = process.env.LSA_BACKEND ?? resolve(ROOT, '../lsa-9600sp-backend')
const IMAGES = process.argv.includes('--images')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
const out = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim()

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const rev = out('git', ['rev-parse', '--short', 'HEAD'])
const dirty = out('git', ['status', '--porcelain']) ? '-dirty' : ''
const VERSION = `${pkg.version}-${rev}${dirty}`
const DIST = resolve(ROOT, 'dist', `eg-${VERSION}`)
const STAGE = resolve(ROOT, 'dist', '.stage-agent')

/** 第三方镜像：与 deploy/eg/compose.yaml 的缺省版本一致 */
const THIRD = ['postgres:16', 'thingsboard/tb-node:4.2.2.5', 'eclipse-mosquitto:2.1.2', 'thingsboard/tb-gateway:3.8.5']

console.log(`EG 发布件 ${VERSION}\n`)
for (const p of ['packages/model', 'packages/points']) {
  if (!existsSync(resolve(BACKEND, p, 'package.json'))) throw new Error(`找不到后端库的 ${p}（${BACKEND}；可设 LSA_BACKEND）`)
}

// 1. 管理页
console.log('1. 构建本地管理页')
run('pnpm', ['-F', '@lsa-eg/admin-web', 'build'], { shell: process.platform === 'win32' })

// 2. agent 镜像的构建上下文：EG 工作区的子集 + 后端两个包（vendored，link: 改 workspace:*）
console.log('\n2. agent 镜像构建上下文')
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
const skip = src => !/[\\/](node_modules|dist)([\\/]|$)/.test(src) && !/[\\/]src[\\/]_tmp/.test(src)
cpSync(resolve(ROOT, 'apps/agent'), resolve(STAGE, 'apps/agent'), { recursive: true, filter: skip })
cpSync(resolve(ROOT, 'packages/config'), resolve(STAGE, 'packages/config'), { recursive: true, filter: skip })
cpSync(resolve(BACKEND, 'packages/model'), resolve(STAGE, 'packages/lsa-model'), { recursive: true, filter: skip })
cpSync(resolve(BACKEND, 'packages/points'), resolve(STAGE, 'packages/lsa-points'), { recursive: true, filter: skip })
cpSync(resolve(ROOT, 'apps/admin-web/dist'), resolve(STAGE, 'web'), { recursive: true })
cpSync(resolve(ROOT, 'pnpm-lock.yaml'), resolve(STAGE, 'pnpm-lock.yaml'))
// 各包的 tsconfig 都 extends ../../tsconfig.base.json，运行时 swc 按它编译（缺了 agent 起不来，I5 冒烟测试发现）
cpSync(resolve(ROOT, 'tsconfig.base.json'), resolve(STAGE, 'tsconfig.base.json'))
cpSync(resolve(ROOT, 'deploy/eg/agent.Dockerfile'), resolve(STAGE, 'Dockerfile'))
const agentPkg = JSON.parse(readFileSync(resolve(STAGE, 'apps/agent/package.json'), 'utf8'))
for (const k of ['@lsa/model', '@lsa/points']) agentPkg.dependencies[k] = 'workspace:*'
writeFileSync(resolve(STAGE, 'apps/agent/package.json'), JSON.stringify(agentPkg, null, 2) + '\n')
writeFileSync(resolve(STAGE, 'package.json'), JSON.stringify({ name: 'lsa9600eg-agent', private: true, version: VERSION, type: 'module', packageManager: pkg.packageManager }, null, 2) + '\n')
writeFileSync(resolve(STAGE, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n")
writeFileSync(resolve(STAGE, '.dockerignore'), '**/node_modules\n')
// 后端库的提交号记下来（两边要配套）
const backendRev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: BACKEND, encoding: 'utf8' }).trim()
console.log(`  → ${STAGE}（后端包取自 ${backendRev}）`)

// 3. 发布件
console.log('\n3. 发布件')
rmSync(DIST, { recursive: true, force: true })
mkdirSync(resolve(DIST, 'config'), { recursive: true })
for (const f of ['compose.yaml', 'mosquitto.conf', 'install.sh']) cpSync(resolve(ROOT, 'deploy/eg', f), resolve(DIST, f))
cpSync(resolve(ROOT, 'deploy/tb-gateway/extensions/lsa'), resolve(DIST, 'extensions/lsa'), { recursive: true, filter: s => !/__pycache__/.test(s) })
// 装到 Linux 上：脚本与配置一律 LF（Windows 上打包时防 CRLF，子站 Linux 复测踩过）
for (const f of ['compose.yaml', 'mosquitto.conf', 'install.sh', 'extensions/lsa/lsa_self_connector.py']) {
  const p = resolve(DIST, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
}
writeFileSync(resolve(DIST, 'VERSION'), VERSION + '\n')
writeFileSync(
  resolve(DIST, 'README.txt'),
  `LSA-9600EG 发布件 ${VERSION}（EG 库 ${rev}${dirty}，后端包 ${backendRev}）\n\n` +
    '装法见 EG 库 docs/EG部署手册.md。简要：\n' +
    '  1. 整个目录拷到 EG 的 /opt/lsa-eg\n' +
    '  2. sudo bash install.sh              （导入镜像、起本地 TB）\n' +
    '  3. 子站经 SSH 隧道跑 provision:eg，把生成的 eg.yaml（及 sp-ca.pem）拷到 config/\n' +
    '  4. sudo bash install.sh              （起全部）\n',
)
console.log(`  → ${DIST}`)

// 4. 镜像
if (IMAGES) {
  console.log('\n4. 镜像（amd64）')
  const agentImg = `lsa-eg-agent:${VERSION}`
  run('docker', ['build', '--platform', 'linux/amd64', '-t', agentImg, STAGE])
  for (const img of THIRD) run('docker', ['pull', '-q', '--platform', 'linux/amd64', img])
  const tar = resolve(DIST, 'images-amd64.tar')
  run('docker', ['save', '-o', tar, agentImg, ...THIRD])
  run('gzip', ['-1', '-f', tar])
  console.log(`  → ${tar}.gz`)
} else {
  console.log('\n（没带 --images：发布件里没有镜像。EG 能联网拉镜像时可以这样装，agent 镜像要另行构建：docker build -t lsa-eg-agent:<版本> dist/.stage-agent）')
}
console.log('\n完成。')
