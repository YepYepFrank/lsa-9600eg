/* 0.19.5 自检：摄像机缺省 restv1 + 192.168.1.19；站点账号 camera-site.yaml 只补 local.yaml 没填的；local.yaml 600。
 *
 *   pnpm -F @lsa-eg/agent verify:camera-site */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAMERA_SITE_FILE, loadConfig, LOCAL_DEFAULTS, saveLocal } from '@lsa-eg/config'

let pass = 0
let fail = 0
function check(ok: boolean, what: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${what}`)
}

const doc = {
  schema: 2,
  generatedAt: '2026-11-02T00:00:00Z',
  station: { name: 'SP-1', label: '1# 配电室', mqtt: 'mqtt://127.0.0.1:1', token: 't' },
  sp: { host: '127.0.0.1' },
  cabinet: { code: 'DP4', name: '4# 柜', group: 'mv', kind: '出线', rated: 630, riseLimit: 50, rooms: ['断路器室'], index: 4 },
  unit: { id: 'B', code: 'DP4-B', at: '断路器室', index: 2 },
  eg: { name: 'EG-DP4-B', token: 't', attrs: { cab: 'DP4', unit: 'DP4-B' } },
  devices: [],
}
const dirs: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'lsa-camsite-'))
  dirs.push(d)
  writeFileSync(join(d, 'eg.yaml'), JSON.stringify(doc))
  return d
}
const site = (d: string, text: string) => writeFileSync(join(d, CAMERA_SITE_FILE), text)

console.log('1. 缺省')
check(LOCAL_DEFAULTS.camera.driver === 'restv1' && LOCAL_DEFAULTS.camera.restv1 === 'http://192.168.1.19', '缺省 restv1、http://192.168.1.19')
check(!LOCAL_DEFAULTS.camera.password && !LOCAL_DEFAULTS.camera.restPassword, '缺省里没有口令')
const old = fresh()
writeFileSync(join(old, 'local.yaml'), 'camera:\n  driver: rtsp\n  restv1: ""\n')
const oc = loadConfig(old).local.camera
check(oc.driver === 'rtsp' && oc.restv1 === '', '已有 local.yaml 的 EG 不受影响')

console.log('2. 站点账号只补缺失项')
const a = fresh()
site(a, 'user: u1\npassword: p1\nrestUser: u2\nrestPassword: p2\n')
const c1 = loadConfig(a).local.camera
check(c1.user === 'u1' && c1.password === 'p1' && c1.restUser === 'u2' && c1.restPassword === 'p2', '都空着：全补')
const onDisk = readFileSync(join(a, 'local.yaml'), 'utf8')
check(!onDisk.includes('p1'), '首次生成的 local.yaml 不带站点口令（只在内存里叠）')
const b = fresh()
writeFileSync(join(b, 'local.yaml'), 'camera:\n  user: mine\n  password: own\n')
site(b, 'user: u1\npassword: p1\nrestUser: u2\nrestPassword: p2\n')
const c2 = loadConfig(b).local.camera
check(c2.user === 'mine' && c2.password === 'own' && c2.restUser === 'u2' && c2.restPassword === 'p2', '本地填过取流口令：那一对不动，接口那一对照补')
const e = fresh()
site(e, '{ 坏的: [')
check(loadConfig(e).local.camera.password === '', '站点文件坏了：不补、不报错')

console.log('3. 权限')
const f = fresh()
const cfg = loadConfig(f)
chmodSync(join(f, 'local.yaml'), 0o644)
saveLocal(cfg.local, f)
if (process.platform === 'win32') console.log('  - Windows 上看不了 600（在 Linux 容器里核）')
else check((statSync(join(f, 'local.yaml')).mode & 0o777) === 0o600, 'saveLocal：老的 644 也收成 600')

for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log(`\n结果：✓ ${pass}，✗ ${fail}`)
process.exit(fail ? 1 : 0)
