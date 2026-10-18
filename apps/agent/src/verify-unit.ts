/* 0.18.0 舱室 EG 身份自检（舱室 EG 方案 v0.5 §8.1）：EG 0.7.0 的身份只认 eg.yaml 顶层 unit.code。
 *
 *   pnpm unit:verify
 *
 *   1. 读配置：schema 2 取 unit；schema 1 按 unit.code = 柜号；schema 2 没有 unit.code、不认的 schema 都拒绝
 *   2. eg.attrs.unit、devices[].attrs.unit 不解析，和 unit.code 不一致只给提示
 *   3. 票据 c 比 unit.code：给单元号的票据过，给柜号的（拆柜前的老票据）不过
 *   4. caps / meters 取键：先单元号、再柜号；柜号键（拆了的柜过渡期发整柜）里别的单元的电表跳过，单元号键里不是本机的电表报错
 *   5. IoT Gateway clientId = tb-gateway-<单元号> */
import 'reflect-metadata'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, unitWarnings, type EgConfig } from '@lsa-eg/config'
import { signTicket, verifyTicket } from './auth/ticket.js'
import { parseCaps } from './caps/caps.js'
import { parseMeters } from './meters/meters.service.js'
import { renderGatewayConfig } from './gateway/render.js'

let pass = 0
let fail = 0
function check(ok: boolean, what: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${what}`)
}
function throws(f: () => unknown, re: RegExp): boolean {
  try {
    f()
    return false
  } catch (e) {
    return re.test(String((e as Error).message))
  }
}

const cabinet = { code: 'AH01', name: '1#进线柜', group: 'mv', kind: '进线', rated: 630, riseLimit: 50, rooms: ['断路器室', '电缆室'], index: 1 }
const base = (extra: Record<string, unknown>) => ({
  schema: 1,
  generatedAt: '2026-10-18T00:00:00Z',
  station: { name: 'SP-1', label: '1# 配电室', mqtt: 'mqtt://127.0.0.1:1', token: 'tok-AH01-A' },
  sp: { host: '127.0.0.1' },
  cabinet,
  eg: { name: 'EG-AH01', token: 'tok-AH01-A', attrs: { cab: 'AH01' } },
  devices: [{ name: 'SAM-AH01-A', kind: 'sam', label: 'SAM-A', attrs: { cab: 'AH01' } }],
  ...extra,
})
const dirs: string[] = []
function load(doc: Record<string, unknown>): EgConfig {
  const d = mkdtempSync(join(tmpdir(), 'lsa-unit-'))
  dirs.push(d)
  writeFileSync(join(d, 'eg.yaml'), JSON.stringify(doc)) // JSON 也是合法的 YAML
  return loadConfig(d)
}

console.log('舱室 EG 身份自检（eg.yaml schema 2 / unit.code）\n')

console.log('1. 读配置')
const s1 = load(base({}))
check(s1.unit.code === 'AH01' && s1.unit.at === '' && s1.unit.index === 1, `schema 1：unit.code = 柜号 AH01，at 空，index 取柜序号（${JSON.stringify(s1.unit)}）`)
const unitA = { id: 'A', code: 'AH01-A', at: '断路器室', index: 31 }
const s2 = load(base({
  schema: 2,
  unit: unitA,
  eg: { name: 'EG-AH01-A', token: 'tok-AH01-A', attrs: { cab: 'AH01', unit: 'AH01-A', samId: 'A', room: '断路器室' } },
  devices: [
    { name: 'SAM-AH01-A', kind: 'sam', label: 'SAM-A', attrs: { cab: 'AH01', unit: 'AH01-A' } },
    { name: 'PM-AH01', kind: 'meter', label: '电表', attrs: { cab: 'AH01', unit: 'AH01-A' } },
  ],
}))
check(s2.unit.code === 'AH01-A' && s2.unit.id === 'A' && s2.unit.at === '断路器室' && s2.unit.index === 31, 'schema 2：unit 原样取（AH01-A · 断路器室 · 31）')
check(s2.cabinet.code === 'AH01', 'schema 2：cabinet 仍是真实的柜 AH01')
check(throws(() => load(base({ schema: 2 })), /没有 unit\.code/), 'schema 2 没有 unit：拒绝')
check(throws(() => load(base({ schema: 3, unit: unitA })), /只认 1 \/ 2/), 'schema 3：拒绝（只认 1 / 2）')

console.log('\n2. attrs.unit 只核对、不解析')
check(unitWarnings(s2).length === 0, 'eg.attrs.unit、devices[].attrs.unit 与 unit.code 一致：没有提示')
const odd = load(base({
  schema: 2,
  unit: unitA,
  eg: { name: 'EG-AH01-A', token: 't', attrs: { unit: 'AH01-B' } },
  devices: [{ name: 'SAM-AH01-A', kind: 'sam', label: 'SAM-A', attrs: { unit: 'AH01-B' } }],
}))
const w = unitWarnings(odd)
check(odd.unit.code === 'AH01-A' && w.length === 2 && w.every(x => x.includes('AH01-B')), `不一致：身份仍是 unit.code AH01-A，给 2 条提示（${w.length}）`)
check(unitWarnings(s1).length === 0, 'schema 1：不提示')

console.log('\n3. 票据 c 比 unit.code')
const now = Date.now()
const claims = (c: string) => ({ c, u: 'ext', n: '自检', r: 'maint' as const, iat: now, exp: now + 60_000, j: Math.random().toString(16).slice(2) })
const okT = verifyTicket('tok-AH01-A', signTicket('tok-AH01-A', claims('AH01-A')), s2.unit.code, now)
check(!('error' in okT), '给 AH01-A 的票据：本 EG（AH01-A）认')
const badT = verifyTicket('tok-AH01-A', signTicket('tok-AH01-A', claims('AH01')), s2.unit.code, now)
check('error' in badT && /给 AH01 的/.test(badT.error), '给柜号 AH01 的票据：本 EG（AH01-A）不认')
const legacyT = verifyTicket('tok-AH01-A', signTicket('tok-AH01-A', claims('AH01')), s1.unit.code, now)
check(!('error' in legacyT), 'schema 1：给柜号的票据照旧认')

console.log('\n4. caps / meters 取键')
const capKeys = { pm6: ['PM6:*'] }
const keys = [s2.unit.code, s2.cabinet.code]
const cUnit = parseCaps({ caps: { 'AH01-A': { pm6: 'confirmed' }, AH01: { pm6: 'unsupported' } }, capKeys }, keys)
check(cUnit?.caps['pm6'] === 'confirmed', 'caps 有单元号键：取单元号那份')
const cCab = parseCaps({ caps: { AH01: { pm6: 'pending' } }, capKeys }, keys)
check(cCab?.caps['pm6'] === 'pending', 'caps 只有柜号键（老子站）：取柜号那份')
check(throws(() => parseCaps({ caps: { AH02: {} }, capKeys }, keys), /没有本 EG（AH01-A \/ AH01）/), 'caps 两个键都没有：报错')
const mUnit = parseMeters({ 'AH01-A': { 'PM-AH01': { ct: 40 } } }, keys, ['PM-AH01'])
check(mUnit?.['PM-AH01']?.ct === 40, 'meters 单元号键：取本机电表')
check(throws(() => parseMeters({ 'AH01-A': { 'PM2-AH01': { ct: 40 } } }, keys, ['PM-AH01']), /本机 eg\.yaml 里没有这台电表/), 'meters 单元号键里有不是本机的电表：报错')
const mCab = parseMeters({ AH01: { 'PM-AH01': { ct: 40 }, 'PM2-AH01': { ct: 80 } } }, keys, ['PM-AH01'])
check(mCab?.['PM-AH01']?.ct === 40 && !('PM2-AH01' in (mCab ?? {})), 'meters 只有柜号键（整柜）：只取本机的，别的单元的电表跳过')
check(parseMeters({ AH02: {} }, keys, ['PM-AH01']) === null, 'meters 两个键都没有：用 eg.yaml 初值（null）')

console.log('\n5. IoT Gateway clientId')
const gw = mkdtempSync(join(tmpdir(), 'lsa-unit-gw-'))
dirs.push(gw)
renderGatewayConfig(s2, gw)
const text = readdirSync(gw).map(f => readFileSync(join(gw, f), 'utf8')).join('\n')
check(text.includes('"tb-gateway-AH01-A"') && !text.includes('"tb-gateway-AH01"'), 'clientId = tb-gateway-AH01-A（不是柜号）')

for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过${fail ? `，${fail} 项不通过` : ''}`)
process.exit(fail ? 1 : 0)
