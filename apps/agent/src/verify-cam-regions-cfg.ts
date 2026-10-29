/* 0.9.0 自检：配置下发带的测温区（子站「测温区设置」改过的部位名 / 个数 / 温升来源，apply/cam-regions-cfg.ts）。
 *   parseCamRegions：只取本单元那份、校验区号 / 部位名 / env；
 *   applyCamRegions：写 / 删 cam-regions.json、摄像机属性就地换、只改名不重启、个数或 env 变了要重启；
 *   loadConfig：cam-regions.json 叠到 eg.yaml 摄像机属性上（单元号不对、格式坏了不叠）；camRegionLimit 跟着变；
 *   configHash：不带 camRegions 与老哈希一致，带了算进去。
 *
 *   pnpm -F @lsa-eg/agent verify:cam-regions-cfg */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAM_REGIONS_FILE, camRegionLimit, loadConfig, type EgConfig } from '@lsa-eg/config'
import { applyCamRegions, ensureCamRegionsFile, parseCamRegions } from './apply/cam-regions-cfg.js'
import { configHash } from './apply/apply.service.js'

let pass = 0
let fail = 0
function check(ok: boolean, what: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${what}`)
}
function throws(f: () => unknown, re: RegExp): string | null {
  try {
    f()
    return null
  } catch (e) {
    const m = String((e as Error).message)
    return re.test(m) ? m : null
  }
}

const doc = {
  schema: 2,
  generatedAt: '2026-11-01T00:00:00Z',
  station: { name: 'SP-1', label: '1# 配电室', mqtt: 'mqtt://127.0.0.1:1', token: 'tok-DP4-B' },
  sp: { host: '127.0.0.1' },
  cabinet: { code: 'DP4', name: '4# 柜', group: 'mv', kind: '出线', rated: 630, riseLimit: 50, rooms: ['断路器室'], index: 4 },
  unit: { id: 'B', code: 'DP4-B', at: '断路器室', index: 2 },
  eg: { name: 'EG-DP4-B', token: 'tok-DP4-B', attrs: { cab: 'DP4', unit: 'DP4-B' } },
  devices: [
    { name: 'SAM-DP4-B', kind: 'sam', label: 'SAM', attrs: { cab: 'DP4', unit: 'DP4-B' } },
    { name: 'CAM-DP4-B', kind: 'camera', label: '双目', attrs: { cab: 'DP4', unit: 'DP4-B', regions: { R1: { label: '断路器室触头', env: 'SAM-DP4-B' }, R2: { label: '电缆室接头', env: 'SAM-DP4-B' }, R3: { label: '断路器室母排连接处', env: 'SAM-DP4-B' } } } },
  ],
}
const dirs: string[] = []
function fresh(): EgConfig {
  const d = mkdtempSync(join(tmpdir(), 'lsa-camreg-'))
  dirs.push(d)
  writeFileSync(join(d, 'eg.yaml'), JSON.stringify(doc))
  return loadConfig(d)
}
const camOf = (c: EgConfig) => c.devices.find(d => d.kind === 'camera')!
const regionsOf = (c: EgConfig) => camOf(c).attrs['regions'] as Record<string, { label: string; env?: string | null }>

console.log('配置下发带的测温区（0.9.0）\n')

console.log('1. parseCamRegions')
const keys = ['DP4-B', 'DP4']
check(parseCamRegions({}, keys) === null, '没带 camRegions（老子站）：null')
check(parseCamRegions({ camRegions: { 'DP4-A': { R1: { label: 'x' } } } }, keys) === null, '只有别的单元的：null（这台没在网页改过）')
const four = parseCamRegions({ camRegions: { 'DP4-B': { R4: { label: ' 避雷器 ', env: 'SAM-DP4-B' }, R1: { label: '触头', env: 'SAM-DP4-B' } } } }, keys)
check(JSON.stringify(four) === JSON.stringify({ R1: { label: '触头', env: 'SAM-DP4-B' }, R4: { label: '避雷器', env: 'SAM-DP4-B' } }), `取本单元、按区号排、部位名去空格：${JSON.stringify(four)}`)
check(JSON.stringify(parseCamRegions({ camRegions: { DP4: { R1: { label: '柜号那份' } } } }, keys)) === '{"R1":{"label":"柜号那份"}}', '单元号没有、柜号有（legacy 柜）：取柜号那份')
for (const [body, re] of [
  [{ camRegions: [] }, /要是对象/],
  [{ camRegions: { 'DP4-B': { R13: { label: 'x' } } } }, /R13 不对/],
  [{ camRegions: { 'DP4-B': { R1: { label: '' } } } }, /label 要是 1–32/],
  [{ camRegions: { 'DP4-B': { R1: { label: 'x'.repeat(33) } } } }, /label 要是 1–32/],
  [{ camRegions: { 'DP4-B': { R1: { label: 'x', env: 3 } } } }, /env 要是/],
  [{ camRegions: { 'DP4-B': {} } }, /一个区都没有/],
] as const) {
  const m = throws(() => parseCamRegions(body as Record<string, unknown>, keys), re)
  check(!!m, `拒：${m ?? JSON.stringify(body)}`)
}

console.log('2. applyCamRegions 与 loadConfig 叠加')
{
  const c = fresh()
  check(camRegionLimit(camOf(c).attrs) === 3 && regionsOf(c)['R2']!.label === '电缆室接头', '起点：eg.yaml 的三个区')
  const rename = { R1: { label: '断路器室触头', env: 'SAM-DP4-B' }, R2: { label: '电缆仓接头', env: 'SAM-DP4-B' }, R3: { label: '断路器室母排连接处', env: 'SAM-DP4-B' } }
  const a = applyCamRegions(c, rename)
  check(!a.restart && !!a.text?.includes('R2 电缆仓接头') && regionsOf(c)['R2']!.label === '电缆仓接头', `只改名：不重启，摄像机属性就地换了（${a.text}）`)
  check(existsSync(join(c.dir, CAM_REGIONS_FILE)) && (JSON.parse(readFileSync(join(c.dir, CAM_REGIONS_FILE), 'utf8')) as { unit: string }).unit === 'DP4-B', 'cam-regions.json 写了（带单元号）')
  check(regionsOf(loadConfig(c.dir))['R2']!.label === '电缆仓接头', '重读配置（重启后）：叠上了网页改的名字')
  check(applyCamRegions(c, rename).text === null, '同样的再来一次：什么都不做')
  const add = applyCamRegions(c, { ...rename, R4: { label: '避雷器', env: 'SAM-DP4-B' } })
  check(add.restart && camRegionLimit(camOf(c).attrs) === 4 && camRegionLimit(camOf(loadConfig(c.dir)).attrs) === 4, `加了 R4：要重启，个数 4（${add.text}）`)
  const env = applyCamRegions(c, { ...rename, R4: { label: '避雷器', env: '' } })
  check(env.restart, 'R4 的温升来源改了：要重启')
  const back = applyCamRegions(c, null)
  check(back.restart && !existsSync(join(c.dir, CAM_REGIONS_FILE)) && regionsOf(c)['R2']!.label === '电缆室接头' && camRegionLimit(camOf(c).attrs) === 3, `子站不再带（恢复模型缺省）：删文件、回到 eg.yaml 的三个区，要重启（${back.text}）`)
  check(applyCamRegions(c, null).text === null, '本来就没有：什么都不做')
  writeFileSync(join(c.dir, CAM_REGIONS_FILE), JSON.stringify({ unit: 'DP4-A', regions: { R1: { label: '别人的' } } }))
  check(regionsOf(loadConfig(c.dir))['R1']!.label === '断路器室触头', '文件里是别的单元号：不叠')
  writeFileSync(join(c.dir, CAM_REGIONS_FILE), '{坏了')
  check(regionsOf(loadConfig(c.dir))['R1']!.label === '断路器室触头', '文件坏了：不叠，照 eg.yaml')
  check(ensureCamRegionsFile(c, rename) && regionsOf(loadConfig(c.dir))['R2']!.label === '电缆仓接头', '开机核对：已生效配置里有、文件坏了 → 补写')
  check(!ensureCamRegionsFile(c, rename), '开机核对：一致就不写')
}

console.log('3. configHash')
{
  const base = { thresholds: [{ key: 'rise' }], rules: [{ id: 'EG-rise', on: true }], extras: { pdCnt: 3, commPeriods: 5 }, caps: null, devComm: null, meters: null, gas: null }
  check(configHash(base) === configHash({ ...base, camRegions: null }), '不带 camRegions：哈希跟老的一样（升级后不当新内容）')
  check(configHash(base) !== configHash({ ...base, camRegions: { R1: { label: 'a' } } }), '带了：算进哈希')
  check(configHash({ ...base, camRegions: { R1: { label: 'a' } } }) !== configHash({ ...base, camRegions: { R1: { label: 'b' } } }), '只改名也算新内容')
}

for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log(`\n${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
