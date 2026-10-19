// 给一键安装文件签名（0.18.2）：在 <run> 旁边出分离签名 <run>.sig（ssh-keygen -Y sign，ed25519），签完马上用仓库里的发布公钥验一遍。
//
//   node scripts/sign-release.mjs <LSA-9600SP-…-offline.run> [--key <私钥>] [--signers <allowed_signers>]
//
//   --key      发布私钥；缺省环境变量 LSA_RELEASE_SIGN_KEY，再缺省 ~/.lsa9600/release-sign/lsa9600-release_ed25519
//              私钥只在打包机：不进仓库、不进包（bundle-all 的违禁扫描也拦 id_ed25519 / .key）。丢了或换人打包：见 docs/子站批量升级EG.md §6
//   --signers  验签用的公钥表，缺省 deploy/eg/release-signers（随 EG 发布件装到 /opt/lsa-eg/、随一键安装文件装到子站 /opt/lsa9600sp/）
//              签完验不过（私钥和仓库里的公钥不是一对）就删掉 .sig、退出 1
// bundle-all.mjs 出完 .run 自动调这里；老的 .run 补签也直接用。
// 身份 / 命名空间（lsa9600-release）和 EG 升级入口 lsa-eg-upgrade、子站 upgrade-egs.sh 一致，改要三处一起改。
import { execFileSync } from 'node:child_process'
import { existsSync, openSync, closeSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SIG_ID = 'lsa9600-release'
export const SIG_NS = 'lsa9600-release'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const defaultKey = () => process.env.LSA_RELEASE_SIGN_KEY || join(homedir(), '.lsa9600/release-sign/lsa9600-release_ed25519')
export const defaultSigners = () => resolve(ROOT, 'deploy/eg/release-signers')

/** 签名并验一遍；返回签名用的 key 指纹（SHA256:…）。失败抛错（.sig 已删） */
export function signRun(run, { key = defaultKey(), signers = defaultSigners() } = {}) {
  if (!existsSync(run)) throw new Error(`没有安装文件：${run}`)
  if (!existsSync(key)) throw new Error(`没有发布私钥：${key}（--key 或 LSA_RELEASE_SIGN_KEY 指定；测试包不签用 bundle-all --no-sign）`)
  const sig = `${run}.sig`
  rmSync(sig, { force: true })  // ssh-keygen 不覆盖已有的 .sig
  execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', SIG_NS, run], { stdio: ['ignore', 'inherit', 'inherit'] })
  const fd = openSync(run, 'r')
  try {
    const out = execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', SIG_ID, '-n', SIG_NS, '-s', sig], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' })
    return out.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? '?'
  } catch (e) {
    rmSync(sig, { force: true })
    throw new Error(`签完验不过（私钥和 ${signers} 里的公钥不是一对？）：${String(e.stderr || e.message).trim()}`)
  } finally {
    closeSync(fd)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  const run = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
  if (!run) { console.error('用法：node scripts/sign-release.mjs <.run> [--key <私钥>] [--signers <allowed_signers>]'); process.exit(2) }
  try {
    const fp = signRun(resolve(run), { key: opt('key') ?? defaultKey(), signers: opt('signers') ?? defaultSigners() })
    console.log(`已签名：${run}.sig（${fp}，已用发布公钥验过）`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
