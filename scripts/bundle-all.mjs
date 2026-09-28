// LSA-9600SP 全部项目的离线一键安装文件：一个 .run（自解压 bash + tar 负载），子站主机与 EG 通用，装时选角色。
//
//   pnpm bundle -- --sp <子站离线包目录> [--eg <EG 发布件目录>] [--out <输出目录>]
//
//   --sp   后端库 scripts/pack-offline.sh --web <前端 dist> 的产物（images.tar.gz、lsa9600sp-backend/、web/）—— 由后端会话打
//   --eg   本库 pnpm pack:eg -- --images --debs 的产物；不给就现打一份（当前提交）
//   --out  缺省 dist/bundle/
//
// 负载 lsa9600sp-bundle/：setup.sh（安装入口）、sp/、eg/、debs/（Docker、compose 插件、chrony；两种角色共用）、docs/、
//   VERSION、MANIFEST.txt、SHA256SUMS（覆盖负载里每个文件）。
// 安全：负载里不许有任何密钥 / 凭据 —— 打包前扫一遍待打文件、打完再扫一遍 tar 清单，碰到就失败、不出文件。
// tar 在一次性 alpine 容器里打（Linux 权限位、LF、UTF-8 文件名都对；Windows 的 tar 会丢执行位）。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...o })
const out = (cmd, args, o = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...o }).trim()

/** 负载里不许出现的（协调会话定的清单）：私钥、.env、各柜 eg.yaml、TB 系统管理员口令、SSH 密钥、provision 产物、证书目录、VM 凭据 */
const FORBIDDEN = [
  [/\.key$/i, '私钥 .key'],
  // .env、.env.local 等都不许；样板 .env.example / .env.prod.example 可以
  [/(^|\/)\.env(?!(\.[^/]*)?\.example$)(\.[^/]*)?$/, '.env'],
  [/(^|\/)eg\.ya?ml$/i, 'eg.yaml'],
  [/tb-sysadmin/i, 'tb-sysadmin'],
  [/id_(ed25519|rsa|ecdsa)/i, 'SSH 密钥'],
  [/(^|\/)tb\/provision\/out\/./, 'tb/provision/out/ 下的文件'],
  [/(^|\/)dist\/eg\//, 'dist/eg/'],
  [/(^|\/)docker\/tls\/./, 'docker/tls/ 下的文件'],
  [/(^|\/)vm\/secrets(\/|$)/, 'vm/secrets'],
  [/(^|\/)initial-password\.txt$/, 'initial-password.txt'],
  [/(^|\/)(password|secrets?)\.txt$/i, '口令文件'],
]
/** 扫一遍：有违禁的打印出来并返回 false */
function scan(paths, what) {
  const bad = []
  for (const p of paths) for (const [re, label] of FORBIDDEN) if (re.test(p)) bad.push(`${label}：${p}`)
  if (bad.length) {
    console.error(`\n安全检查不过（${what}）—— 负载里不能带这些：\n  ${bad.join('\n  ')}`)
    return false
  }
  console.log(`  安全检查（${what}）：${paths.length} 项，无密钥 / 凭据`)
  return true
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, base, acc)
    else acc.push(relative(base, p).split('\\').join('/'))
  }
  return acc
}

/** 同盘硬链接（几 GB 不用真拷），跨盘退回拷贝 */
function place(src, dst) {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    linkSync(src, dst)
  } catch {
    cpSync(src, dst)
  }
}
function placeTree(srcDir, dstDir, skip = () => false) {
  for (const f of walk(srcDir)) if (!skip(f)) place(join(srcDir, f), join(dstDir, f))
}

// ---------- 输入 ----------
const SP = opt('sp') && resolve(opt('sp'))
if (!SP) {
  console.error('用法：pnpm bundle -- --sp <子站离线包目录> [--eg <EG 发布件目录>] [--out <目录>]')
  process.exit(2)
}
for (const f of ['images.tar.gz', 'lsa9600sp-backend/docker/.env.prod.example', 'lsa9600sp-backend/scripts/up.sh', 'web/index.html'])
  if (!existsSync(join(SP, f))) throw new Error(`子站离线包 ${SP} 里没有 ${f}（要 pack-offline.sh --web <前端 dist> 的产物）`)

let EG = opt('eg') && resolve(opt('eg'))
if (!EG) {
  console.log('没给 --eg：现打 EG 发布件（pack:eg -- --images --debs）\n')
  // 版本号在打之前取（与 pack-eg 同一算法）：打的过程中有人提交，HEAD 会变
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  const rev = out('git', ['rev-parse', '--short', 'HEAD'])
  const dirty = out('git', ['status', '--porcelain']) ? '-dirty' : ''
  EG = resolve(ROOT, 'dist', `eg-${pkg.version}-${rev}${dirty}`)
  run('node', ['scripts/pack-eg.mjs', '--images', '--debs'])
}
for (const f of ['install.sh', 'compose.yaml', 'IMAGES.txt', 'images-amd64.tar.gz', 'VERSION'])
  if (!existsSync(join(EG, f))) throw new Error(`EG 发布件 ${EG} 里没有 ${f}（要 pack:eg -- --images --debs 的产物）`)
if (!readdirSync(join(EG, 'debs')).some(f => f.endsWith('.deb'))) throw new Error(`EG 发布件 ${EG} 里没有离线 deb（pack:eg -- --debs）`)

const spVer = readFileSync(join(SP, 'lsa9600sp-backend/docker/.env.prod.example'), 'utf8').match(/^APP_VERSION=(.+)$/m)[1].trim()
const egVer = readFileSync(join(EG, 'VERSION'), 'utf8').trim()
const spRev = (() => {
  try {
    return out('git', ['rev-parse', '--short', 'HEAD'], { cwd: SP })
  } catch {
    return '?'
  }
})()
const feRev = existsSync(join(SP, 'web/FRONTEND_REV')) ? readFileSync(join(SP, 'web/FRONTEND_REV'), 'utf8').trim() : '?'
const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const VERSION = `${spVer}-${day}`
const NAME = `LSA-9600SP-${VERSION}-offline`
const OUT = resolve(opt('out') ?? resolve(ROOT, 'dist', 'bundle'))
const STAGE = resolve(ROOT, 'dist', '.stage-bundle')
const B = join(STAGE, 'lsa9600sp-bundle')

console.log(`LSA-9600SP 离线一键安装 ${VERSION}`)
console.log(`  子站 ${spVer}（后端 ${spRev}，前端 ${feRev}）← ${SP}`)
console.log(`  EG   ${egVer} ← ${EG}\n`)

// ---------- 负载 ----------
console.log('1. 整理负载')
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(B, { recursive: true })
// 子站：离线包原样（它自带的 SHA256SUMS / 安装说明 丢掉，统一用外层的）
placeTree(SP, join(B, 'sp'), f => f === 'SHA256SUMS' || f === '安装说明.txt')
mkdirSync(join(B, 'sp/lsa9600sp-backend/tb/provision/out'), { recursive: true })
// EG：发布件去掉 debs/（放到外层共用）
placeTree(EG, join(B, 'eg'), f => f.startsWith('debs/'))
placeTree(join(EG, 'debs'), join(B, 'debs'))
mkdirSync(join(B, 'eg/config'), { recursive: true })
// 文档
mkdirSync(join(B, 'docs'), { recursive: true })
cpSync(resolve(ROOT, 'docs/EG部署手册.md'), join(B, 'docs/EG部署手册.md'))
const spDoc = join(SP, 'lsa9600sp-backend/docs/子站部署手册.md')
if (existsSync(spDoc)) cpSync(spDoc, join(B, 'docs/子站部署手册.md'))
writeFileSync(join(B, 'setup.sh'), readFileSync(resolve(ROOT, 'deploy/bundle/setup.sh'), 'utf8').replace(/\r\n/g, '\n'))
writeFileSync(join(B, 'VERSION'), VERSION + '\n')
const egImages = readFileSync(join(EG, 'IMAGES.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => `    ${l.split(' ')[0]}  ${l.split(' ')[1]}`)
const spEnv = readFileSync(join(SP, 'lsa9600sp-backend/docker/.env.prod.example'), 'utf8')
const ev = k => spEnv.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '?'
writeFileSync(
  join(B, 'MANIFEST.txt'),
  [
    `LSA-9600SP 离线一键安装 ${VERSION}（${new Date().toISOString()}）`,
    `  子站 ${spVer}：后端 ${spRev}、前端 ${feRev}；ThingsBoard ${ev('TB_VERSION')}、PostgreSQL ${ev('PG_VERSION')}、mediamtx ${ev('MEDIAMTX_VERSION')}、Nginx ${ev('NGINX_VERSION')}`,
    `  EG ${egVer}：`,
    ...egImages,
    `  离线包（Ubuntu 24.04 amd64）：${readdirSync(join(B, 'debs')).filter(f => /^(docker-ce|docker-ce-cli|containerd\.io|docker-compose-plugin|chrony)_/.test(f)).join('、')}`,
    '',
  ].join('\n'),
)
writeFileSync(
  join(B, '安装说明.txt'),
  `LSA-9600SP 离线一键安装 ${VERSION}

整个系统就这一个文件，子站主机和各柜 EG 都用它，装的时候选角色。目标机：x86_64，Ubuntu 24.04（其它发行版先自行装好 Docker）。

  子站主机：sudo bash ${NAME}.run --role sp            （本机站内 IP 自动取，或 --ip 指定；口令随机生成，见 /opt/lsa9600sp/初始账号口令.txt）
  EG：      sudo bash ${NAME}.run --role eg --lan1 <摄像机网口>（单网口不给）
            → 给子站授权开隧道：sudo bash ${NAME}.run --role eg --sp-key <子站公钥>
            → 子站主机上 scripts/provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<EG> …、scripts/pack-eg.sh --sp <子站> --only <柜号>，拿到 eg.yaml 与 sp-ca.pem 后：
            sudo bash ${NAME}.run --role eg --eg-config <放 eg.yaml 的目录>
  只解包：  bash ${NAME}.run --extract <目录>

不带 --role 就交互选。重跑同一个（或更新的）安装文件 = 升级：子站保留 docker/.env，EG 保留 config/ 与 .env，旧版可回退（EG：install.sh --rollback）。
详见 docs/子站部署手册.md、docs/EG部署手册.md。
`,
)

const files = walk(B)
if (!scan(files, '待打文件')) process.exit(1)

// ---------- tar ----------
console.log('\n2. 打包（alpine 容器）')
mkdirSync(OUT, { recursive: true })
const RUN = `${NAME}.run`
const stubSrc = readFileSync(resolve(ROOT, 'deploy/bundle/stub.sh'), 'utf8').replace(/\r\n/g, '\n')
writeFileSync(join(STAGE, 'stub.sh'), stubSrc.endsWith('\n') ? stubSrc : stubSrc + '\n')
const sh = [
  'set -e',
  'apk add --no-cache tar coreutils sed >/dev/null',
  'cd /stage/lsa9600sp-bundle',
  // 负载里的大部分是指向两个源目录的硬链接：这里不改任何文件（源目录只读）。LF 已由两边的打包脚本保证、这里只查；
  // 执行位由 tar --mode 与 setup.sh 统一给
  "cr=$(printf '\\r'); if find . -type f \\( -name '*.sh' -o -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.example' \\) -exec grep -l \"$cr\" {} + | grep .; then echo '上面这些是 CRLF 换行，到 Linux 上跑不起来' >&2; exit 1; fi",
  'find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS',
  'echo "  SHA256SUMS：$(wc -l < SHA256SUMS) 个文件"',
  `cp /stage/stub.sh /out/${RUN}.tmp`,
  `tar -c --owner=0 --group=0 --numeric-owner --mode=u=rwX,go=rX -C /stage lsa9600sp-bundle >> /out/${RUN}.tmp`,
  // 打完再扫一遍 tar 清单（以 tar 里实际有的为准）
  `skip=$(awk '/^__LSA_PAYLOAD_BELOW__$/ { print NR + 1; exit }' /out/${RUN}.tmp)`,
  `tail -n +$skip /out/${RUN}.tmp | tar -t > /stage/list.txt`,
  'echo "  tar 清单：$(wc -l < /stage/list.txt) 项"',
  `mv /out/${RUN}.tmp /out/${RUN}`,
  `cd /out && sha256sum ${RUN} > ${RUN}.sha256 && ls -l ${RUN}`,
].join(' && ')
run('docker', ['run', '--rm', '-v', `${STAGE}:/stage`, '-v', `${OUT}:/out`, 'alpine:3.20', 'sh', '-c', sh], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })

const listed = readFileSync(join(STAGE, 'list.txt'), 'utf8').split('\n').filter(Boolean)
if (!scan(listed, 'tar 清单')) {
  rmSync(join(OUT, RUN), { force: true })
  rmSync(join(OUT, `${RUN}.sha256`), { force: true })
  process.exit(1)
}
// 重打到同一目录时先删旧的（Windows 上直接覆盖会 unlink 失败）
rmSync(join(OUT, `${NAME}-安装说明.txt`), { force: true })
cpSync(join(B, '安装说明.txt'), join(OUT, `${NAME}-安装说明.txt`))
const size = statSync(join(OUT, RUN)).size
console.log(`\n完成：${join(OUT, RUN)}（${(size / 1024 ** 3).toFixed(2)} GB）`)
console.log(`  校验：${basename(RUN)}.sha256；说明：${NAME}-安装说明.txt`)
