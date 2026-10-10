/* restv1 真机驱动的自检（EG 0.5，清单 I18）：起 restv1-mock.ts（照厂家 V1.8 与清单 4.4 版答复），用 eg-video 的 Restv1Driver 逐项测。
 * 不碰样机、不连子站；测试账号口令每次随机生成（不用厂家默认口令）。
 *
 *   pnpm restv1:verify
 *
 * 测：登录（MD5 小写、只占一个会话、并发共用一次登录）、流地址四路、区域配置（四种类型、polygon 坐标换算、停用的不算、按名 / 按 ID 编号）、
 *     温度（全画面与各区 max / min / 坐标、avg / center，point 类型 {value,x,y}）、报警状态（只取正在报警的、不带数值）、
 *     令牌到期前重取、中途失效（10009）重取一次、一直 10009 → TOKEN、口令不对 → AUTH（报错里没有口令和它的 MD5）、
 *     报警 / 区域接口出错 → partial（温度照常）、测温接口出错 → API、超时 → TIMEOUT、连不上 → CONNECT、抓拍 base64 → JPEG、回的不是 JPEG → DATA。 */
import { createHash, randomBytes } from 'node:crypto'
import { Restv1Driver, RESTV1_FRAME, alarmText, coordsOf } from '../../../apps/video/src/restv1.js'
import { numberRegions, type DriverError, type RegionDef } from '../../../apps/video/src/driver-base.js'
import { camRegionLimit } from '@lsa-eg/config'
import { defaultRegions } from './camera.js'
import { startRestv1Mock, type MockRegion } from './restv1-mock.js'

let pass = 0
let fail = 0
function check(ok: boolean, what: string, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${what}`)
  } else {
    fail++
    console.log(`  ✗ ${what}${detail ? `  —— ${detail}` : ''}`)
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function thrown(p: Promise<unknown>): Promise<DriverError | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as DriverError
  }
}

const USER = `lsa-test-${randomBytes(3).toString('hex')}`
const PASS = `T${randomBytes(9).toString('base64url')}`
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const REGIONS: MockRegion[] = [
  { regionEnable: true, regionName: 'R1', regionType: 'region', region: { x: 50, y: 90, width: 160, height: 150 } },
  { regionEnable: true, regionName: '', regionType: 'line', region: { startX: 10, startY: 10, endX: 200, endY: 50 } },
  { regionEnable: true, regionName: '', regionType: 'polygon', region: { pointNum: 3, point: [{ x: 1, y: 2 }, { x: 30, y: 4 }, { x: 15, y: 40 }] } },
  { regionEnable: true, regionName: '', regionType: 'point', region: { x: 64, y: 66 } },
  { regionEnable: false, regionName: '', regionType: 'region', region: { x: 0, y: 0, width: 10, height: 10 } },
]

async function main() {
  console.log('restv1 真机驱动自检（模拟摄像机，照 restv1 V1.8 与厂家答复 CAM1–CAM8）\n')
  const mock = await startRestv1Mock({ user: USER, password: PASS, regions: REGIONS })
  const drv = (o: Partial<{ password: string; timeoutMs: number; base: string }> = {}) => new Restv1Driver({ base: o.base ?? mock.url, user: USER, password: o.password ?? PASS, timeoutMs: o.timeoutMs ?? 2000 })

  console.log('1. 纯函数')
  check(JSON.stringify(coordsOf('polygon', { pointNum: 2, point: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })) === '{"points":[{"x":1,"y":2},{"x":3,"y":4}]}', 'polygon 坐标 {pointNum, point[]} → {points[]}')
  check(JSON.stringify(coordsOf('region', { x: 1, y: 2, width: 3, height: 4 })) === '{"x":1,"y":2,"width":3,"height":4}', 'region 坐标原样')
  check(alarmText({ globTemp: { alarm: true }, regionTemp: [{ alarm: false }, { alarm: true }], firePoint: { alarm: true }, diffTemp: [{ alarm: true, difference: { regionA: 1, regionB: 3 } }] }) === '全局温度、R2 区域温度、温差 R1–R3、火点', '报警只取 alarm = true 的、区号按 ID + 1')
  check(alarmText({ globTemp: { alarm: false, value: 99 } }) === '' && alarmText(undefined) === '', '没有报警 → 空串（不带数值，数值变了不算变化）')

  console.log('\n2. 登录、流地址')
  const d = drv()
  const s = await d.streams()
  check(mock.state.logins === 1, `登录一次（MD5 小写；模拟摄像机只认小写）：登录 ${mock.state.logins} 次`)
  const keys = Object.keys(s.map).sort().join(',')
  check(keys === 'thermal,thermalSub,visible,visibleSub', `四路流地址：${keys}`)
  check(s.map.visible?.uri.endsWith('/visible') === true && s.map.thermalSub?.uri.endsWith('/thermal-sub') === true, `通道 0 = 可见光、1 = 热像（${s.map.visible?.uri}、${s.map.thermalSub?.uri}）`)
  const det = d.detail()
  check(det.firmware === 'V1.8-mock' || det.firmware === null, `固件版本读到（登录后异步读）：${det.firmware}`)
  check(!JSON.stringify(det).includes(PASS) && !JSON.stringify(det).includes(md5(PASS)), 'detail() 里没有口令、也没有口令的 MD5')

  console.log('\n3. 区域与温度')
  const m = await d.measure()
  check(m.frame.w === RESTV1_FRAME.w && m.frame.h === 480, `坐标画面 ${m.frame.w}×${m.frame.h}（厂家 CAM5：640×480）`)
  check(m.regions.length === 5 && m.regions.map(r => r.name).join(',') === 'R1,R2,R3,R4,R5', `区域按名对应、没名字的按 ID + 1 编号：${m.regions.map(r => `${r.name}/${r.type}${r.enabled ? '' : '(停用)'}`).join(' ')}`)
  check(JSON.stringify(m.regions[2]!.coords) === '{"points":[{"x":1,"y":2},{"x":30,"y":4},{"x":15,"y":40}]}', 'polygon 区域坐标换成 {points}')
  const t = m.temps!
  check(typeof t.glob.max === 'number' && t.glob.maxX === 320 && t.glob.maxY === 200 && t.glob.avg === 30.5 && t.glob.center === 31.2, `全画面：max ${t.glob.max} @(${t.glob.maxX},${t.glob.maxY})、min ${t.glob.min}、avg ${t.glob.avg}、center ${t.glob.center}`)
  const byName = new Map(t.regions.map(r => [r.name, r]))
  const r1 = byName.get('R1')!
  check(r1 && r1.max !== undefined && r1.min !== undefined && r1.maxX !== undefined && r1.avg !== undefined && r1.center !== undefined && r1.pt === undefined, `矩形区 R1：max ${r1?.max} min ${r1?.min} avg ${r1?.avg} center ${r1?.center} 最高点 (${r1?.maxX},${r1?.maxY})`)
  const r4 = byName.get('R4')
  check(!!r4 && r4.pt !== undefined && r4.max === undefined && r4.avg === undefined, `point 区 R4：只有 pt ${r4?.pt}（{value, x, y} 的 value）`)
  check(!byName.has('R5'), '停用的区（R5）不出温度')
  check(m.alarm === '' && !m.partial, '没有报警、没有 partial')

  console.log('\n4. 报警轮询')
  mock.state.alarms = { globTemp: true, regionTemp: [1], firePoint: false }
  check((await d.measure()).alarm === '全局温度、R2 区域温度', '报警状态：全局温度、R2 区域温度')
  mock.state.alarms = { globTemp: false, regionTemp: [], firePoint: false }
  check((await d.measure()).alarm === '', '恢复后为空（厂家推送不发恢复，所以用轮询）')

  console.log('\n5. 令牌')
  const logins0 = mock.state.logins
  mock.state.tokens.clear()
  const m2 = await d.measure()
  check(!!m2.temps && mock.state.logins === logins0 + 1, `中途失效（10009）：重新登录一次后照常（登录 ${logins0} → ${mock.state.logins}）`)
  const short = await startRestv1Mock({ user: USER, password: PASS, tokenLifeS: 6 })
  const ds = drv({ base: short.url })
  await ds.measure()
  await sleep(1500)
  await ds.measure()
  check(short.state.logins === 2, `到期前重取（有效期 6 s、提前 5 s）：1.5 s 后再测，登录 ${short.state.logins} 次`)
  await short.close()
  const par = await startRestv1Mock({ user: USER, password: PASS })
  const dp = drv({ base: par.url })
  await Promise.all([dp.measure(), dp.measure(), dp.streams(), dp.measure(), dp.snap('ir')])
  check(par.state.logins === 1 && par.state.maxConcurrent === 1, `并发 5 个请求共用一次登录：登录 ${par.state.logins} 次、同时有效的会话最多 ${par.state.maxConcurrent} 个（摄像机上限 2，留 1 个给现场调试）`)
  await par.close()
  mock.state.fail = { '/measurement/globTemp': 10009 }
  const eTok = await thrown(d.measure())
  check(eTok?.code === 'TOKEN', `一直回 10009 → TOKEN：${eTok?.message}`)
  mock.state.fail = {}

  console.log('\n6. 口令不对')
  const eAuth = await thrown(drv({ password: `${PASS}x` }).measure())
  check(eAuth?.code === 'AUTH', `口令不对 → AUTH：${eAuth?.message}`)
  const msg = `${eAuth?.message} ${eAuth?.stack}`
  check(!msg.includes(PASS) && !msg.includes(md5(`${PASS}x`)) && !msg.includes(md5(PASS)), '报错里没有口令、也没有口令的 MD5')

  console.log('\n7. 接口出错')
  mock.state.fail = { '/alarm/status': 19999 }
  const mA = await d.measure()
  check(!!mA.temps && mA.partial?.length === 1 && mA.partial[0]!.what === 'alarm', `报警状态接口报错 → 温度照常、partial：${mA.partial?.[0]?.error}`)
  // 会话上限 2：再开两台驱动占满，第三台登录被拒 → API（不是 AUTH，提示调试工具占着）
  mock.state.tokens.clear()
  await drv().streams()
  await drv().streams()
  const eFull = await thrown(drv().streams())
  check(eFull?.code === 'API' && /2 个会话/.test(eFull.message), `会话满了登录被拒 → API、提示关掉调试工具：${eFull?.message}`)
  mock.state.tokens.clear()
  mock.state.fail = { '/measurement/region': 'http500' }
  const fresh = drv()
  const eR = await thrown(fresh.measure())
  check(eR?.code === 'API' && /measurement\/region/.test(eR.message), `区域配置从没读到过就出错 → 整次失败 API：${eR?.message}`)
  mock.state.fail = {}
  await fresh.measure()
  mock.state.fail = { '/measurement/region': 19999 }
  ;(fresh as unknown as { regionCache: { at: number } }).regionCache.at = 0
  const mR = await fresh.measure()
  check(!!mR.temps && mR.partial?.[0]?.what === 'region' && mR.regions.length === 5, `读到过之后区域配置出错 → 用上次的、partial：${mR.partial?.[0]?.error}`)
  mock.state.fail = { '/measurement/regionTemp': 19999 }
  const eT = await thrown(d.measure())
  check(eT?.code === 'API', `测温接口报错 → API：${eT?.message}`)
  mock.state.tokens.clear() // 前面几台驱动各占了会话（上限 2），清掉免得新驱动登录被拒
  mock.state.fail = { '/measurement/globTemp': 'hang' }
  const t0 = Date.now()
  const eH = await thrown(drv({ timeoutMs: 600 }).measure())
  check(eH?.code === 'TIMEOUT' && Date.now() - t0 < 3000, `接口不回 → TIMEOUT（${Date.now() - t0} ms）：${eH?.message}`)
  mock.state.fail = {}

  console.log('\n8. 抓拍')
  const jpg = await d.snap('visible')
  check(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 10, `可见光抓拍：base64 → JPEG ${jpg.length} 字节`)
  const ir = await d.snap('ir')
  check(ir[0] === 0xff && mock.state.snapIds.join(',') === '0,1', `热像抓拍走通道 1（可见光 0）：${ir.length} 字节，通道 ${mock.state.snapIds.join(' / ')}`)
  mock.state.fail = { '/channel/snap': 'nojpeg' }
  const eJ = await thrown(d.snap('ir'))
  check(eJ?.code === 'DATA', `回的不是 JPEG → DATA：${eJ?.message}`)
  mock.state.fail = {}

  console.log('\n9. 测温区数（I18：本柜配了几个就几个，1–12，缺省 3）')
  const regs = (n: number) => ({ regions: Object.fromEntries(Array.from({ length: n }, (_, i) => [`R${i + 1}`, { label: `区 ${i + 1}` }])) })
  check(camRegionLimit(undefined) === 3 && camRegionLimit({}) === 3 && camRegionLimit(regs(1)) === 1 && camRegionLimit(regs(5)) === 5 && camRegionLimit(regs(12)) === 12 && camRegionLimit(regs(15)) === 12,
    `区数 = eg.yaml CAM 属性 regions.R<n> 的个数：没有 → 3、1 → 1、5 → 5、12 → 12、15 → 12（夹到 1–12）`)
  const grid = defaultRegions(12)
  const inFrame = grid.every(r => { const c = r.coords as { x: number; y: number; width: number; height: number }; return c.x >= 0 && c.y >= 0 && c.x + c.width <= 640 && c.y + c.height <= 480 })
  check(grid.length === 12 && grid[11]!.name === 'R12' && inFrame && defaultRegions(3).length === 3 && defaultRegions(2).length === 2, `仿真器缺省区域：12 个按 4 × 3 网格铺在 640×480 里，≤ 3 个用共用的那几个`)
  const unnamed: RegionDef[] = Array.from({ length: 6 }, (_, i) => ({ name: `区域${i}`, type: 'region', coords: {}, enabled: i !== 1 }))
  check(numberRegions(unnamed, 3).map(x => `${x.id}=${x.def.name}`).join(' ') === 'R1=区域0 R2=区域2 R3=区域3', `没按 R<n> 起名：取前 limit 个启用的按顺序编（停用的跳过）`)
  const named12 = defaultRegions(12) as RegionDef[]
  check(numberRegions(named12, 3).map(x => x.id).join(',') === 'R1,R2,R3' && numberRegions(named12, 12).length === 12, `按名对应：摄像机上有 R1–R12，limit 3 只取 R1–R3，limit 12 全取`)
  const m12 = await startRestv1Mock({ user: USER, password: PASS, regions: defaultRegions(12).map(r => ({ regionEnable: true, regionName: '', regionType: 'region' as const, region: r.coords })) })
  const t12 = (await drv({ base: m12.url }).measure())
  check(t12.regions.length === 12 && t12.temps!.regions.length === 12 && t12.regions[11]!.name === 'R12' && t12.temps!.regions[11]!.avg !== undefined, `真机 12 个区（ID 0–11、没起名）→ R1–R12，各区都有温度和 avg / center`)
  await m12.close()

  console.log('\n10. 摄像机连不上')
  const url = mock.url
  await mock.close()
  const eC = await thrown(drv({ base: url }).measure())
  check(eC?.code === 'CONNECT', `连不上 → CONNECT：${eC?.message}`)
  const eC2 = await thrown(d.measure())
  check(eC2?.code === 'CONNECT', `已登录的驱动也报 CONNECT：${eC2?.message}`)

  console.log(`\n${pass} 项通过，${fail} 项失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
