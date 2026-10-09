// 转换程序测试套件打包：出 dist/lsa-eg-conv-kit-<日期>-<提交>.zip，发给做传感器转换程序的同事。
//
//   pnpm conv-kit:pack                 套件（install.sh / install.ps1 / compose / 检查工具 / 点表）+ EG内部MQTT格式.md
//   pnpm conv-kit:pack -- --image      另带 Mosquitto 镜像 images/eclipse-mosquitto-2.1.2.tar（约 14 MB，对方没外网时用）
//
// 打包前先从 @lsa/points 重新导出 spec.json（点表改了检查工具跟着变）。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KIT = join(ROOT, 'tools', 'conv-kit')
const MOSQUITTO = 'eclipse-mosquitto:2.1.2'
const withImage = process.argv.includes('--image')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
const out = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim()

run('pnpm', ['-F', '@lsa-eg/emu', 'exec', 'tsx', 'src/conv-kit-spec.ts'], { shell: process.platform === 'win32' })

const rev = out('git', ['rev-parse', '--short', 'HEAD']) + (out('git', ['status', '--porcelain', '--', 'tools/conv-kit', 'docs/EG内部MQTT格式.md']) ? '-dirty' : '')
const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const name = `lsa-eg-conv-kit-${day}-${rev}`
const stage = join(ROOT, 'dist', name)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(KIT, stage, { recursive: true, filter: src => !/[\\/](data|images|__pycache__)([\\/]|$)/.test(src.slice(KIT.length)) && !src.endsWith('.gitignore') })
cpSync(join(ROOT, 'docs', 'EG内部MQTT格式.md'), join(stage, 'EG内部MQTT格式.md'))
// 行尾：发到 Linux 上跑的一律 LF（CRLF 的 install.sh 在 bash 里直接报错），.ps1 用 CRLF（Windows PowerShell 5.1）
for (const f of readdirSync(stage, { recursive: true }).map(String)) {
  const p = join(stage, f)
  if (!/\.(sh|py|ya?ml|conf|json|md|ps1)$/.test(f) || !statSync(p).isFile()) continue
  const lf = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  writeFileSync(p, f.endsWith('.ps1') ? lf.replace(/\n/g, '\r\n') : lf)
}
if (withImage) {
  mkdirSync(join(stage, 'images'), { recursive: true })
  run('docker', ['save', MOSQUITTO, '-o', join(stage, 'images', 'eclipse-mosquitto-2.1.2.tar')])
}

const zip = join(ROOT, 'dist', `${name}.zip`)
rmSync(zip, { force: true })
// 用 Python 的 zipfile 打 zip（套件本来就要 Python；Windows 自带的 tar.exe 遇到中文文件名会崩）。.sh 在 zip 里标可执行
const PY = process.platform === 'win32' ? 'python' : 'python3'
run(PY, ['-I', '-c', `
import os, sys, zipfile
root, name, zp = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, _, fs in os.walk(os.path.join(root, name)):
        for f in sorted(fs):
            full = os.path.join(d, f)
            arc = os.path.relpath(full, root).replace(os.sep, '/')
            info = zipfile.ZipInfo.from_file(full, arc)
            info.external_attr = (0o755 if f.endswith(('.sh', '.py')) else 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED if f.endswith('.tar') else zipfile.ZIP_DEFLATED
            with open(full, 'rb') as fh:
                z.writestr(info, fh.read())
`, join(ROOT, 'dist'), name, zip])
if (!existsSync(zip)) throw new Error('没打出 zip')
console.log(`\n已出 ${zip}（${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB${withImage ? '，含 Mosquitto 镜像' : ''}）`)
