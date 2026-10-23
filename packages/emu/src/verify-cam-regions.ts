/* 0.8.0 自检：给没画测温区的摄像机写缺省 R1–R3（apps/video/src/cam-regions.ts），用 restv1-mock 跑：
 *   空区写入（读回核对、regionTemp 有数、别的区不动）、已有启用的区拒绝、--force 覆盖、备份 / 恢复、
 *   接口报错 10001 / 10008 / 10009（一直 10009 → TOKEN；中途令牌失效重登一次照常）、写到一半出错按备份写回、距离范围、读回不一致。
 * 0.8.1：照现场真机（mock style b37：rectangle、没有本地参数、出厂 0×0）写、换写法、全局测温参数、--force 要 --yes、试写 probe、恢复只写变了的 / 0×0 退路。
 * 测试账号口令每次随机生成（不用厂家默认口令）。
 *
 *   pnpm -F @lsa-eg/emu verify:cam-regions */
import { randomBytes } from 'node:crypto'
import { Restv1Driver } from '../../../apps/video/src/restv1.js'
import { applyDefaultRegions, defaultRegionRows, DEFAULT_STRIPS, probeRegions, restoreRegions, styleOf, writableOf } from '../../../apps/video/src/cam-regions.js'
import { B37_FACTORY, startRestv1Mock, type MockRegion } from './restv1-mock.js'

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

async function rig(regions: MockRegion[], opt: { style?: 'doc' | 'b37'; rejectZero?: boolean } = {}) {
  const user = `t${randomBytes(3).toString('hex')}`
  const password = randomBytes(9).toString('base64url')
  const m = await startRestv1Mock({ user, password, regions, ...opt })
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
    check(rr.ok && rr.written.join(',') === '0,1,2' && rr.skipped === 9, `按备份写回：只写变了的 R1–R3（9 个一样的没写）、读回一致（${rr.mismatch.join('；') || '无'}）`)
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
    const nf = await applyDefaultRegions(d, { camera: m.url, force: true, waitTempMs: 0 })
    check(!nf.ok && !!nf.error?.includes('R1 位置（区号 0）现在 「母排」启用') && !!nf.error?.includes('再加 --yes') && posts() === 2 && m.state.regions[0]!.regionName === '母排', `--force 没给 --yes：列出会覆盖的、不写（${nf.error}）`)
    const f = await applyDefaultRegions(d, { camera: m.url, force: true, yes: true, waitTempMs: 0 })
    check(f.ok && m.state.regions[0]!.regionName === 'R1' && f.backup.regions[0]!['regionName'] === '母排' && f.notes.some(x => x.includes('--force 覆盖了')), '--force --yes：覆盖 R1–R3，备份里留着「母排」，说明里写了覆盖了什么')
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
    const r = await applyDefaultRegions(d, { camera: m.url, force: true, yes: true, waitTempMs: 0 })
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

  console.log('9. 现场真机（b37：rectangle、没有本地参数、出厂 0×0）：照读回的写法一次写进；辐射率走全局')
  {
    const { m, d, posts } = await rig(B37_FACTORY, { style: 'b37' })
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(r.ok && r.style?.rectType === 'rectangle' && r.style.local === false && posts() === 5, `写法 rectangle、不带本地参数，R1 一次就收（POST ${posts() - 2} 次 = 3 个区；${r.mismatch.join('；') || '读回一致'}）`)
    check(r.backup.glob?.['radrate'] === 1 && m.state.glob.radrate === 1, '备份里带全局测温参数（辐射率 1），没给 --set-global 不动它')
    check(r.notes.some(x => x.includes('现在辐射率 1') && x.includes('--set-global')), `说明里报全局辐射率、提示 --set-global（${r.notes.join('；')}）`)
    const g = await applyDefaultRegions(d, { camera: m.url, force: true, yes: true, setGlobal: true, distance: 3, waitTempMs: 0 })
    check(g.ok && m.state.glob.radrate === 0.95 && m.state.glob.detectdist === 3 && m.state.glob.envtemp === 22 && m.state.glob.humidity === 30, `--set-global：全局辐射率 0.95、距离 3 m，环境温度 / 湿度不动（${g.notes.join('；')}）`)
    const rr = await restoreRegions(d, g.backup)
    check(rr.ok && m.state.glob.radrate === 1 && m.state.glob.detectdist === 2 && rr.notes.some(x => x.includes('全局测温参数也写回了')), `恢复：全局测温参数写回辐射率 1 / 2 m（${rr.notes.join('；')}）`)
    await m.close()
  }
  {
    const { m, d } = await rig(B37_FACTORY, { style: 'b37' })
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    const rr = await restoreRegions(d, r.backup)
    check(rr.ok && m.state.regions.slice(0, 3).every((x, i) => x.regionName === `Area${i + 1}` && x.regionEnable === false && x.region['width'] === 0), `恢复：R1–R3 回到出厂（Area1–3、0×0、没启用）（${rr.mismatch.join('；') || '一致'}）`)
    await m.close()
  }

  console.log('10. 现场的样子：用户手画的 Area6（区号 5）启用着')
  {
    const field = B37_FACTORY.map((x, i) => (i === 5 ? { ...x, regionEnable: true, region: { x: 320, y: 132, width: 206, height: 169 } } : x))
    const { m, d, posts } = await rig(field, { style: 'b37' })
    const r0 = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(!r0.ok && !!r0.error?.includes('Area6/rectangle') && posts() === 1, `不加 --force：拒（${r0.error}）`)
    const r1 = await applyDefaultRegions(d, { camera: m.url, force: true, waitTempMs: 0 })
    check(!r1.ok && !!r1.error?.includes('「Area6」启用 rectangle x320 y132 206×169（区号 5）') && !!r1.error?.includes('不动') && posts() === 2, `--force 不加 --yes：列出 R1–R3 位置、Area6 不动，没写（${r1.error}）`)
    const r2 = await applyDefaultRegions(d, { camera: m.url, force: true, yes: true, waitTempMs: 0 })
    check(r2.ok && m.state.regions[5]!.regionName === 'Area6' && m.state.regions[5]!.regionEnable === true && m.state.regions[5]!.region['width'] === 206, `--force --yes：写了 R1–R3，Area6 原样（${r2.mismatch.join('；') || '读回一致'}）`)
    await m.close()
  }

  console.log('11. 恢复：出厂 0×0 摄像机不收原样 → 没启用的改成停用')
  {
    const { m, d } = await rig(B37_FACTORY, { style: 'b37', rejectZero: true })
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    const rr = await restoreRegions(d, r.backup)
    check(r.ok && rr.ok && rr.written.join(',') === '0,1,2' && rr.notes.filter(x => x.includes('改成停用')).length === 3, `R1–R3 都改成停用、核对一致（${rr.notes[0] ?? ''}）`)
    check(m.state.regions.slice(0, 3).every((x, i) => x.regionName === `Area${i + 1}` && x.regionEnable === false), '名字回到 Area1–3、没启用（坐标留着，不测温）')
    await m.close()
  }

  console.log('12. 写法读不准时换着试：读回写的 region（像文档），摄像机却只收 rectangle')
  {
    const { m, d } = await rig(B37_FACTORY, { style: 'b37' })
    const orig = d.regionsRaw.bind(d)
    d.regionsRaw = async () => (await orig()).map(x => ({ ...x, regionType: 'region' }))
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(r.ok && r.style?.rectType === 'rectangle' && r.style.local === false && r.notes.some(x => x.includes('改用 regionType "rectangle"、不带本地参数')), `R1 试到 rectangle、不带才收，R2 / R3 照它写（${r.notes.find(x => x.includes('改用')) ?? ''}）`)
    await m.close()
  }
  {
    const { m, d } = await rig(B37_FACTORY, { style: 'b37' })
    m.state.fail['POST /measurement/region'] = 10001
    const r = await applyDefaultRegions(d, { camera: m.url, waitTempMs: 0 })
    check(!r.ok && !!r.error?.includes('几种写法摄像机都不收') && r.rolledBack === '一个都还没写，不用写回', `哪种都 10001：报出来、一个都没写（${(r.error ?? '').slice(0, 60)}…）`)
    await m.close()
  }

  console.log('13. 试写 probe：一个空区上写一次、读回、马上写回')
  {
    const field = B37_FACTORY.map((x, i) => (i === 0 ? { ...x, regionEnable: true, regionName: '母排' } : x))
    const { m, d } = await rig(field, { style: 'b37' })
    const before = JSON.stringify(m.state.regions)
    const p = await probeRegions(d, { camera: m.url })
    check(p.ok && p.slot === 1 && p.tries.length === 1 && !!p.tries[0]!.accepted && p.works?.rectType === 'rectangle', `第一个没启用的区（区号 1）上试，rectangle、不带本地参数一次就收（${p.tries.map(t => t.style).join('；')}）`)
    check(p.tries[0]!.readback?.['regionName'] === 'PROBE' && p.unchanged && JSON.stringify(m.state.regions) === before && p.restored === 'R2 已写回', `读回是 PROBE；写回后摄像机跟试之前一模一样（${p.restored}）`)
    check(!!p.backup.glob && m.state.glob.radrate === 1, '试写不动全局测温参数（备份里带着）')
    await m.close()
  }
  {
    const { m, d } = await rig(B37_FACTORY, { style: 'b37', rejectZero: true })
    const p = await probeRegions(d, { camera: m.url })
    check(p.ok && p.unchanged && !!p.restored?.includes('改成停用') && m.state.regions[0]!.regionEnable === false && m.state.regions[0]!.regionName === 'Area1', `0×0 写不回：改成停用、名字回 Area1，算一样（${p.restored}）`)
    await m.close()
  }
  {
    const all = B37_FACTORY.map(x => ({ ...x, regionEnable: true }))
    const { m, d, posts } = await rig(all, { style: 'b37' })
    const p = await probeRegions(d, { camera: m.url })
    check(!p.ok && !!p.error?.includes('没有空位') && posts() === 1, `12 个区都启用：不试（${p.error}）`)
    await m.close()
  }
  check(styleOf([{ regionType: 'rectangle', regionEnable: false }]).local === false && styleOf([{ regionType: 'region', localParam: {} }]).local === true, 'styleOf：看读回有没有本地参数、矩形字样')
  check(!('localParam' in writableOf({ regionEnable: true, localParam: {}, localMeasureParam: true }, false)), '摄像机没有本地参数时写回不带这两个字段')

  console.log(`\n${n - fails} 项通过，${fails} 项失败`)
  process.exit(fails ? 1 : 0)
}
void main().catch(e => {
  console.error(e)
  process.exit(1)
})
