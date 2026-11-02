/* 0.19.5 自检：本地 TB 没就绪（PENDING）时，配置下发带的测温区也马上生效。
 *   以前 applyCamRegions 排在写本地 TB 之后，PENDING 走不到，部位名要等 TB 起来；
 *   现在放在 TB 之前；个数变了要重启 agent 时排着的配置已落盘；重启后开机核对不把排队那份的文件改回去。
 *
 *   pnpm -F @lsa-eg/agent verify:cam-regions-pending */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAM_REGIONS_FILE, loadConfig, type EgConfig } from '@lsa-eg/config'
import { ApplyService } from './apply/apply.service.js'

process.env['EG_NO_SELF_RESTART'] = '1'

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
  station: { name: 'SP-1', label: '1# 配电室', mqtt: 'mqtt://127.0.0.1:1', token: 'tok-DP4-B' },
  sp: { host: '127.0.0.1' },
  cabinet: { code: 'DP4', name: '4# 柜', group: 'mv', kind: '出线', rated: 630, riseLimit: 50, rooms: ['断路器室'], index: 4 },
  unit: { id: 'B', code: 'DP4-B', at: '断路器室', index: 2 },
  eg: { name: 'EG-DP4-B', token: 'tok-DP4-B', attrs: { cab: 'DP4', unit: 'DP4-B' } },
  devices: [{ name: 'CAM-DP4-B', kind: 'camera', label: '双目', attrs: { cab: 'DP4', unit: 'DP4-B', regions: { R1: { label: '触头' }, R2: { label: '接头' }, R3: { label: '母排' } } } }],
}

const dir = mkdtempSync(join(tmpdir(), 'lsa-campend-'))
writeFileSync(join(dir, 'eg.yaml'), JSON.stringify(doc))
const cfg: EgConfig = loadConfig(dir)
const down = { available: true, get: () => Promise.reject(new Error('connect ECONNREFUSED')), req: () => Promise.reject(new Error('connect ECONNREFUSED')) }
const quiet = { publishAttributes: () => undefined, write: () => undefined, set: () => undefined, setThresholds: () => undefined, effective: () => ({}) }
const svc = () => new ApplyService(cfg, down as never, quiet as never, quiet as never, quiet as never, quiet as never, quiet as never)
const who = { user: 'sp', name: '子站', ip: '127.0.0.1' }
const body = (version: string, regions: Record<string, unknown>) => ({ version, thresholds: [{ key: 'ir.max', warn: 70, alarm: 90 }], rules: [], camRegions: { 'DP4-B': regions } })
const file = join(dir, CAM_REGIONS_FILE)
const labels = () => JSON.parse(readFileSync(file, 'utf8')).regions as Record<string, { label: string }>

const main = async () => {
  console.log('1. 本地 TB 没就绪')
  const a = svc()
  const r = await a.apply(body('c-1', { R1: { label: '新部位' }, R2: { label: '接头' }, R3: { label: '母排' }, R4: { label: '加的' } }), who)
  check(r.status === 'PENDING', `回执 PENDING（${r.status}：${r.error ?? ''}）`)
  check(existsSync(file) && labels()['R1']?.label === '新部位' && labels()['R4']?.label === '加的', 'cam-regions.json 已经写了（部位名、个数）')
  check(existsSync(join(dir, 'pending-config.json')), '配置排着队（落盘，重启后接着重试）')

  console.log('2. agent 重启（个数变了）')
  writeFileSync(join(dir, 'applied-config.json'), JSON.stringify({ version: 'c-0', camRegions: { R1: { label: '旧部位' } } }))
  const b = svc()
  check(labels()['R1']?.label === '新部位', '有排着的配置：开机核对不按已生效的改回去（否则每次重试都要再重启）')
  rmSync(join(dir, 'pending-config.json'))
  const c = svc()
  check(labels()['R1']?.label === '旧部位', '没有排着的：开机核对照旧按已生效的补写')
  for (const s of [a, b, c]) clearInterval((s as unknown as { timer: NodeJS.Timeout }).timer)
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n结果：✓ ${pass}，✗ ${fail}`)
  process.exit(fail ? 1 : 0)
}
void main()
