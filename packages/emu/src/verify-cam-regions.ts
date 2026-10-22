/* 0.8.0 自检：给没画测温区的摄像机写缺省 R1–R3（apps/video/src/cam-regions.ts），用 restv1-mock 跑：
 *   空区写入（读回核对、regionTemp 有数、别的区不动）、已有启用的区拒绝、--force 覆盖、备份 / 恢复、
 *   接口报错 10001 / 10008 / 10009（一直 10009 → TOKEN；中途令牌失效重登一次照常）、写到一半出错按备份写回、距离范围、读回不一致。
 * 测试账号口令每次随机生成（不用厂家默认口令）。
 *
 *   pnpm -F @lsa-eg/emu verify:cam-regions */
import { randomBytes } from 'node:crypto'
import { Restv1Driver } from '../../../apps/video/src/restv1.js'
import { applyDefaultRegions, defaultRegionRows, DEFAULT_STRIPS, restoreRegions, writableOf } from '../../../apps/video/src/cam-regions.js'
import { startRestv1Mock, type MockRegion } from './restv1-mock.js'

let fails = 0
let n = 0
const check = (ok: boolean, msg: string) => {
  n++
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) fails++
}

/** 真机出厂样子：12 个区都在、都没启用，名字 Area1–Area12 */
const FACTORY: MockRegion[] = Array.from({ length: 12 }, (_, i) => ({ regionEnable: false, regionName: `Area${i + 1}`, regionType: 'region' as const, region: { x: 10 * i, y: 10, width: 20, height: 20 } }))
const EXISTING: MockRegion[] = [
  { regionEnable: true, regionName: '母排', regionType: 'region', region: { x: 100, y: 100, width: 50, height: 50 } },
  ...FACTORY.slice(1),
]

async function rig(regions: MockRegion[]) {
  const user = `t${randomBytes(3).toString('hex')}`
  const password = randomBytes(9).toString('base64url')
  const m = await startRestv1Mock({ user, password, regions })
  const d = new Restv1Driver({ base: m.url, user, password, timeoutMs: 2000 })
  return { m, d, posts: () => m.state.hits['/measurement/region'] ?? 0 }
}

async function main() {
  console.log('缺省测温区 R1–R3（0.8.0）\n')

  console.log('1. 布局')
  const rows = defaultRegionRows()
  check(rows.map(r => (r.row['region'] as { x: number }).x).join(',') === '32,229,426' && rows.every(r => r.row['regionType'] === 'region' && (r.row['region'] as { y: number; height: number }).y === 24 && (r.row['region'] as { height: number }).height === 432),
    '三竖条：x 32 / 229 / 426，y 24、高 432（四周 5% 边：x 32–608、y 24–456）')
  check(DEFAULT_STRIPS.every((r, i) => i === 0 || r.x - (DEFAULT_STRIPS[i - 1]!.x + DEFAULT_STRIPS[i - 1]!.width) === 16) && DEFAULT_STRIPS[2]!.x + DEFAULT_STRIPS[2]!.width === 608, '条与条之间 16 px 缝，右边到 608')
  check(rows.every((r, i) => r.row['regionName'] === `R${i + 1}` && r.row['localMeasureParam'] === true && JSON.stringify(r.row['localParam']) === '{"distance":2,"emissivity":0.95}'), '名字 R1 / R2 / R3、辐射率 0.95、距离缺省 2 m、localMeasureParam true')
  let bad = ''
  try { defaultRegionRows(0) } catch (e) { bad = (e as Error).message }
  check(bad.includes('(0, 1000]'), `距离 0 拒（${bad}）`)
  check((defaultRegionRows(5)[0]!.row['localParam'] as { distance: number }).distance === 5, '距离可配（5 m）')

  console.log('2. 空区（出厂 12 个区都没启用）：写入、读回、有温度、别的区不动')
  {
    const { m, d } = await rig(FACTORY)
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(r.ok && r.written.join(',') === '0,1,2' && !r.error, `写了 R1–R3、读回一致（${r.mismatch.join('；') || '无不一致'}）`)
    check(r.backup.regions.length === 12 && r.backup.regions.every(x => x['regionEnable'] === false), '写之前整份备份（12 个区、都没启用）')
    check(m.state.regions[0]!.regionName === 'R1' && m.state.regions[2]!.regionName === 'R3' && m.state.regions[3]!.regionName === 'Area4' && m.state.regions[3]!.regionEnable === false, 'R4 起没动')
    check(r.temps.length === 3 && r.temps.every(t => t.max !== null && t.avg !== null), `regionTemp 有数：${r.temps.map(t => `${t.name} ${t.max}/${t.avg}`).join('，')}`)
    console.log('3. 备份 / 恢复')
    const rr = await restoreRegions(d, r.backup)
    check(rr.ok && rr.written.length === 12, `按备份写回 12 个区、读回一致（${rr.mismatch.join('；') || '无'}）`)
    check(m.state.regions.slice(0, 3).every((x, i) => x.regionName === `Area${i + 1}` && x.regionEnable === false), 'R1–R3 回到出厂（Area1–3、没启用）')
    const empty = await restoreRegions(d, { at: 'x', camera: m.url, regions: [] })
    check(!empty.ok && !!empty.error?.includes('没有区域配置'), '空备份：拒')
    await m.close()
  }

  console.log('4. 已有启用的区：拒绝；--force 覆盖')
  {
    const { m, d, posts } = await rig(EXISTING)
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(!r.ok && !!r.error?.includes('已经有 1 个启用的测温区（母排/region）') && posts() === 1, `拒绝、一个都没写（只有一次 GET；${r.error}）`)
    check(m.state.regions[0]!.regionName === '母排', '原来的「母排」还在')
    const f = await applyDefaultRegions(d, { camera: m.url, force: true, waitTempMs: 0 })
    check(f.ok && m.state.regions[0]!.regionName === 'R1' && f.backup.regions[0]!['regionName'] === '母排', '--force：覆盖 R1–R3，备份里留着「母排」')
    const rr = await restoreRegions(d, f.backup)
    check(rr.ok && m.state.regions[0]!.regionName === '母排' && m.state.regions[0]!.regionEnable === true, '用备份恢复：「母排」回来了')
    await m.close()
  }

  console.log('5. 接口报错')
  for (const code of [10001, 10008]) {
    const { m, d } = await rig(FACTORY)
    m.state.fail['POST /measurement/region'] = code
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(!r.ok && !!r.error?.includes(String(code)) && r.written.length === 0 && r.rolledBack === '一个都还没写，不用写回' && m.state.regions[0]!.regionName === 'Area1', `写回 ${code}：报错、一个都没写成、摄像机原样（${r.error}）`)
    await m.close()
  }
  {
    const { m, d } = await rig(FACTORY)
    m.state.fail['POST /measurement/region'] = 10009
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(!r.ok && !!r.error?.includes('重新登录后仍然 10009'), `写一直回 10009：重登一次还不行 → 报 TOKEN（${r.error}）`)
    delete m.state.fail['POST /measurement/region']
    m.state.tokens.clear()
    const r2 = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(r2.ok && m.state.logins >= 2, `令牌中途失效（10009）：重登一次照常写完（登录 ${m.state.logins} 次）`)
    await m.close()
  }

  console.log('6. 写到一半出错：已写的按备份写回')
  {
    const { m, d } = await rig(EXISTING)
    const orig = d.setRegion.bind(d)
    let calls = 0
    d.setRegion = async (id: number, row: Record<string, unknown>) => {
      calls++
      if (id === 1 && row['regionName'] === 'R2') throw new Error('模拟：R2 写到一半断了')
      return orig(id, row)
    }
    const r = await applyDefaultRegions(d, { camera: m.url, force: true, waitTempMs: 0 })
    check(!r.ok && r.written.join(',') === '0' && r.rolledBack === 'R1 已写回' && m.state.regions[0]!.regionName === '母排', `R2 失败：R1 按备份写回「母排」（${r.error}；${r.rolledBack}）`)
    check(calls === 3, `调用顺序：写 R1、写 R2（失败）、写回 R1（共 ${calls} 次）`)
    await m.close()
  }

  console.log('7. 读回不一致：报出来、ok = false')
  {
    const { m, d } = await rig(FACTORY)
    const orig = d.regionsRaw.bind(d)
    let k = 0
    d.regionsRaw = async () => {
      const rows2 = await orig()
      if (++k === 2) rows2[1] = { ...rows2[1], region: { x: 0, y: 0, width: 1, height: 1 } }
      return rows2
    }
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(!r.ok && r.mismatch.some(x => x.startsWith('R2 坐标')), `R2 坐标对不上：${r.mismatch.join('；')}`)
    await m.close()
  }

  console.log('8. 真机矩形区回 "rectangle"：读回按同一种算；写回时只带文档字段')
  {
    const { m, d } = await rig(FACTORY)
    const orig = d.regionsRaw.bind(d)
    d.regionsRaw = async () => (await orig()).map(x => (x['regionType'] === 'region' ? { ...x, regionType: 'rectangle' } : x))
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(r.ok, `rectangle 读回算一致（${r.mismatch.join('；') || '无'}）`)
    check(Object.keys(writableOf({ regionEnable: true, regionName: 'x', regionType: 'region', region: {}, localMeasureParam: true, localParam: {}, extra: 1 })).length === 6, '写回只带 6 个文档字段（摄像机多回的字段不带）')
    await m.close()
  }

  console.log(`\n${n - fails} 项通过，${fails} 项失败`)
  process.exit(fails ? 1 : 0)
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
