/* 阶段 A 自检（EG 侧，接口 v1.1）：能力下发与上报、§13 下挂设备状态、摄像机三路、eg.time_sync、规则停用 / 改名清活动告警。
 *
 *   pnpm --filter @lsa-eg/agent verify:a
 * 对着一台在跑的 EG（本机开发环境或虚拟样机）：
 *   EG_AGENT_URL  eg-agent（缺省 http://127.0.0.1:9100）
 *   EG_CONFIG_DIR 这台 EG 的 eg.yaml、initial-password.txt 所在目录（签服务票据、登本地页、登本地 TB 用）
 *   EG_TB_HTTP    这台 EG 的本地 TB（缺省 http://127.0.0.1:18080；样机上经 SSH 隧道）
 *   EMU_URL       仿真器控制面（缺省 http://127.0.0.1:3190；样机上经 SSH 隧道）
 *   LSA_BACKEND   后端库（取 tb/model.yaml 的阈值表）
 * 第 0 节是纯函数，不连任何东西也能跑：EG_A_ONLY_UNIT=1。
 * 跑完把配置恢复成不带能力的（与跑之前同一份阈值 / 规则）。 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { loadModel, type ThresholdRow } from '@lsa/model'
import { loadConfig, repoRoot, stationToken } from '@lsa-eg/config'
import { signTicket } from './auth/ticket.js'
import { capsActual, cardState, deviceEnabled, keyMatch, parseCaps, prefixOf, type CapsConfig } from './caps/caps.js'
import { AGENT, agent, check, done, EMU, env, post, sleep, Tb, until } from './verify/lib.js'

const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const MODEL = resolve(env('LSA_BACKEND', resolve(repoRoot() ?? '.', '../lsa-9600sp-backend')), 'tb/model.yaml')

function unit(): void {
  console.log('0. 能力清单的纯函数')
  check(prefixOf('PM2-AH12') === 'PM2' && prefixOf('SAM-AH12-A') === 'SAM' && prefixOf('EG') === 'EG', '设备前缀取第一个「-」之前')
  check(keyMatch('*', 'x') && keyMatch('el.*', 'el.Ia') && keyMatch('el.h*', 'el.hu.A') && !keyMatch('el.h*', 'el.Ia') && keyMatch('us.cnt', 'us.cnt') && !keyMatch('us.cnt', 'us.cnt2'), 'key：整个、末尾 *、单独 *')
  const c: CapsConfig = {
    caps: { pdCount: 'confirmed', pm6: 'unsupported', smokePpm: 'pending', meterBasic: 'confirmed', meterHarmonics: 'unsupported' },
    capKeys: { pdCount: ['SAM:us.cnt'], pm6: ['PM6:*'], smokePpm: ['PM6:smoke.ppm'], meterBasic: ['PM:el.*', 'PM2:el.*'], meterHarmonics: ['PM:el.h*'] },
  }
  check(deviceEnabled('SAM-AH12-A', c) && !deviceEnabled('PM6-AH12', c) && deviceEnabled('PM-AH12', c) && deviceEnabled('CAM-AH12', c) && deviceEnabled('EG-AH12', c), '整台不启用：PM6（pm6 unsupported、smokePpm pending）；PM 有一项 confirmed 照常；匹配不上的照常')
  check(deviceEnabled('PM6-X', null), '没下发能力 = 全部启用')
  const act = capsActual(c, ['SAM-AH12-A', 'PM-AH12', 'PM6-AH12'], (d, k) => d === 'SAM-AH12-A' && k === 'us.cnt')
  check(act['pdCount'] === 'ok' && act['pm6'] === 'nodata' && act['meterBasic'] === 'nodata', `caps.actual 判 ok / nodata：${JSON.stringify(act)}`)
  check(capsActual(c, ['SAM-AH12-A'], () => true)['pm6'] === 'absent', 'eg.yaml 里没有 PM6 → absent')
  check(cardState(['smokePpm', 'pm6'], c) === 'pending' && cardState(['meterHarmonics'], c) === 'hidden' && cardState(['pdCount'], c) === 'show' && cardState(['x'], c) === 'show', '卡片：pending → 待定，unsupported → 隐藏')
  let bad = ''
  try {
    parseCaps({ caps: { AH12: { a: 'yes' } }, capKeys: {} }, 'AH12')
  } catch (e) {
    bad = (e as Error).message
  }
  check(/confirmed/.test(bad), `校验：状态不对报错（${bad}）`)
  check(parseCaps({ version: 'x' }, 'AH12') === null, '老子站（不带 caps）→ null，照旧')
}

async function main() {
  console.log('阶段 A 自检（EG 侧，接口 v1.1）\n')
  unit()
  if (process.env['EG_A_ONLY_UNIT'] === '1') done()

  const cfg = loadConfig()
  const dir = process.env['EG_CONFIG_DIR'] ?? ''
  const code = cfg.cabinet.code
  const token = stationToken(cfg)
  const g = cfg.cabinet.group
  const base: ThresholdRow[] = loadModel(MODEL).thresholds
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const devs = cfg.devices.map(d => d.name)
  const sam = devs.find(n => n.startsWith('SAM-'))!
  const pm6 = devs.find(n => n.startsWith('PM6-'))
  const camDev = devs.find(n => n.startsWith('CAM-'))
  const ticket = () => {
    const now = Date.now()
    return signTicket(token, { c: code, u: 'ext', n: '阶段 A 自检', r: 'station', iat: now, exp: now + 60_000, j: randomBytes(8).toString('hex') })
  }
  const put = async (body: unknown) => {
    const r = await fetch(`${AGENT}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-EG-Ticket': ticket() }, body: JSON.stringify(body) })
    return (await r.json()) as { version: string; status: string; error?: string; changed?: number }
  }
  const RULES = ['EG-rise', 'EG-rise2', 'EG-tabs', 'EG-pd', 'EG-arc', 'EG-rh', 'EG-ol', 'EG-pm', 'EG-dphase', 'EG-devlost']
  const rules = (off: string[] = []) => RULES.map(id => ({ id, on: !off.includes(id) }))
  const stamp = Date.now().toString(36)
  const capsBody = (states: Record<string, string>) => ({
    caps: { [code]: states },
    capKeys: {
      thermalRegions: ['CAM:ir.*'], camVideo: ['CAM:cam.*'], envTH: ['SAM:env.*'], pdAmplitude: ['SAM:us.amp'], pdCount: ['SAM:us.cnt'],
      arcIntensity: ['SAM:uv.int'], arcEvents: ['SAM:uv.pulse'], pm6: ['PM6:*'], smokePpm: ['PM6:smoke.ppm'],
      meterBasic: ['PM:el.*', 'PM2:el.*'], meterHarmonics: ['PM:el.h*', 'PM2:el.h*'],
    },
    devComm: { failN: 5, minMs: 30_000, periods: 5 },
  })
  const ALL_ON = { thermalRegions: 'confirmed', camVideo: 'confirmed', envTH: 'confirmed', pdAmplitude: 'confirmed', pdCount: 'confirmed', arcIntensity: 'confirmed', arcEvents: 'confirmed', meterBasic: 'confirmed', meterHarmonics: 'pending' }

  console.log('\n1. 能力下发：pm6 / smokePpm 不启用（PM6 整台不上送），电表谐波 pending')
  const r1 = await put({ version: `a-${stamp}-1`, thresholds: base, rules: rules(['EG-rh']), ...capsBody({ ...ALL_ON, pm6: 'unsupported', smokePpm: 'pending' }) })
  check(r1.status === 'APPLIED', `PUT /api/config 带 caps / capKeys / devComm → ${r1.status}${r1.error ? `：${r1.error}` : ''}`)
  const ci = await agent<{ delivered: boolean; caps: Record<string, string>; actual: Record<string, string> | null; devComm: { failN: number } }>(dir, '/api/caps')
  check(ci.delivered && ci.caps['pm6'] === 'unsupported' && ci.devComm.failN === 5, `GET /api/caps 照下发的：${JSON.stringify(ci.caps)}`)
  const st = await agent<{ devices: { name: string; capsEnabled?: boolean; comm?: { comm: string } }[] }>(dir, '/api/status')
  const en = Object.fromEntries(st.devices.map(d => [d.name, d.capsEnabled]))
  if (pm6) check(en[pm6] === false && en[sam] === true, `/api/status：${pm6} 不启用、${sam} 启用`)
  const act = await until(async () => {
    const v = await tb.attr(cfg.eg.name, 'CLIENT_SCOPE', 'caps.actual')
    return typeof v === 'string' ? (JSON.parse(v) as Record<string, string>) : null
  }, 60_000, 3000)
  check(!!act && act['pdCount'] === 'ok' && act['envTH'] === 'ok', `caps.actual 属性进了本地 TB：${JSON.stringify(act)}`)
  if (pm6) check(act?.['pm6'] === 'ok', `PM6 照常采（本地有数）→ pm6 = ok（与下发的 unsupported 不一致，子站据此提示）`)

  console.log('\n2. §13 下挂设备状态')
  const comm = await until(async () => {
    const l = await tb.latest(sam, ['dev.comm', 'dev.link', 'dev.last_ok', 'dev.fails', 'dev.err'])
    return l['dev.comm'] ? l : null
  }, 90_000, 3000)
  check(!!comm && ['ONLINE', 'DEGRADED'].includes(String(comm['dev.comm']?.value)) && String(comm['dev.link']?.value) === '1', `${sam}：dev.comm = ${comm?.['dev.comm']?.value}、dev.link = ${comm?.['dev.link']?.value}、last_ok ${comm?.['dev.last_ok']?.value}、fails ${comm?.['dev.fails']?.value}`)
  if (pm6) {
    const l = await tb.latest(pm6, ['dev.comm'])
    const t0 = Date.now()
    await sleep(65_000)
    const l2 = await tb.latest(pm6, ['dev.comm'])
    check(!l2['dev.comm'] || (l2['dev.comm'].ts ?? 0) < t0, `${pm6}（能力不启用）不发 dev.*：最近一条 ${l2['dev.comm'] ? new Date(l2['dev.comm'].ts).toISOString() : '无'}（自检开始前 ${l['dev.comm'] ? '有' : '无'}）`)
  }
  console.log(`   ${sam} 整台停发 → 应 OFFLINE（fails ≥ 5 且 > max(30 s, 5 周期)），恢复 → ONLINE`)
  await post(`${EMU}/emu/dev/${sam}/dead?on=1`)
  const off = await until(async () => ((await tb.latest(sam, ['dev.comm']))['dev.comm']?.value === 'OFFLINE' ? true : null), 120_000, 3000)
  const offRow = await tb.latest(sam, ['dev.comm', 'dev.link', 'dev.fails', 'dev.err'])
  check(!!off && String(offRow['dev.link']?.value) === '0' && Number(offRow['dev.fails']?.value) >= 5 && offRow['dev.err']?.value === 'TIMEOUT', `停发后 OFFLINE、dev.link 0、fails ${offRow['dev.fails']?.value}、err ${offRow['dev.err']?.value}`)
  await post(`${EMU}/emu/dev/${sam}/dead?on=0`)
  const back = await until(async () => (['ONLINE', 'DEGRADED'].includes(String((await tb.latest(sam, ['dev.comm']))['dev.comm']?.value)) ? true : null), 90_000, 3000)
  const backRow = await tb.latest(sam, ['dev.comm', 'dev.link', 'dev.fails', 'dev.err'])
  check(!!back && String(backRow['dev.link']?.value) === '1' && Number(backRow['dev.fails']?.value) === 0 && backRow['dev.err']?.value === '', `恢复后 ${backRow['dev.comm']?.value}、dev.link 1、fails 0、err 清空`)

  console.log('\n3. 摄像机三路、对时')
  if (camDev) {
    const cam = await until(async () => {
      const l = await tb.latest(camDev, ['cam.vis', 'cam.ir', 'cam.rest', 'cam.online'])
      return l['cam.vis'] && l['cam.ir'] ? l : null
    }, 90_000, 3000)
    check(!!cam && cam['cam.vis']?.value === 'OK' && cam['cam.ir']?.value === 'OK', `${camDev}：cam.vis ${cam?.['cam.vis']?.value}、cam.ir ${cam?.['cam.ir']?.value}、cam.rest ${cam?.['cam.rest']?.value ?? '（不测温的驱动不发）'}、cam.online ${cam?.['cam.online']?.value}`)
  }
  const ts = await until(async () => (await tb.latest(cfg.eg.name, ['eg.time_sync']))['eg.time_sync'] ?? null, 30_000, 3000)
  check(!!ts && ['synced', 'unsynced', 'unknown'].includes(String(ts.value)), `eg.time_sync = ${ts?.value}（eg.clk_offset 测不出不发、不填 0）`)

  console.log('\n4. 规则停用后，挂着的活动告警清掉（改名「柜内湿度高」同一套）')
  await post(`${EMU}/emu/arc?intensity=450&ms=25`)
  const arcOn = await until(async () => {
    for (const d of devs.filter(n => n.startsWith('SAM-'))) {
      const a = (await tb.activeAlarms(d)).find(x => x.type === '弧光异常')
      if (a) return { d, a }
    }
    return null
  }, 60_000, 2000)
  check(!!arcOn, `打弧光 → 本地 TB 活动告警「弧光异常」（${arcOn?.d ?? '没出来'}）`)
  const r4 = await put({ version: `a-${stamp}-2`, thresholds: base, rules: rules(['EG-rh', 'EG-arc']), ...capsBody({ ...ALL_ON, pm6: 'unsupported', smokePpm: 'pending' }) })
  check(r4.status === 'APPLIED', `停用 EG-arc → ${r4.status}`)
  const cleared = await until(async () => (arcOn && !(await tb.activeAlarms(arcOn.d)).some(x => x.type === '弧光异常') ? true : null), 30_000, 2000)
  check(!!cleared, '停用后「弧光异常」活动告警被清掉（没有规则了，不清就一直挂着）')

  console.log('\n5. 恢复：不带能力的配置（全部照旧上送）')
  const r5 = await put({ version: `a-${stamp}-3`, thresholds: base, rules: rules(['EG-rh']) })
  check(r5.status === 'APPLIED', `恢复 → ${r5.status}`)
  const ci2 = await agent<{ delivered: boolean }>(dir, '/api/caps')
  check(!ci2.delivered, '/api/caps：delivered = false（页面照旧）')
  void g
  done()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
