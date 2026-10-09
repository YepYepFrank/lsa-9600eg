/* I4 自检（EG 侧）：子站下发配置 → EG 应用 → 回执（后端库 docs/EG独立TB调整方案.md §2.4、§5 I4、§8.3）。
 *
 *   pnpm i4:verify
 *
 * 自检自己签服务票据（与子站扩展服务同一算法、同一令牌）直接 PUT agent，看回执、本地 TB 设备配置、cfg 属性、本地告警是否随之变；
 * 最后按 tb/model.yaml 的阈值、全部规则启用、eg.yaml 原来的版本号恢复原样。
 * 前提：I1 样机在跑（本地 TB 有 provision:eg 建的设备配置）；dev:emu、dev:agent 在跑。只改 EG 本地 TB，不碰子站。 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { loadModel, type ThresholdRow } from '@lsa/model'
import { loadConfig, repoRoot, stationToken } from '@lsa-eg/config'
import { signTicket, type ClaimRole } from './auth/ticket.js'
import { AGENT, agent, check, done, EMU, env, post, sleep, Tb, until } from './verify/lib.js'

const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
/** 阈值基准：后端库的 tb/model.yaml（与 dev:config 一样按 LSA_BACKEND 找后端库） */
const MODEL = resolve(env('LSA_BACKEND', resolve(repoRoot() ?? '.', '../lsa-9600sp-backend')), 'tb/model.yaml')

interface Receipt {
  version: string
  status: 'APPLIED' | 'FAILED'
  error?: string
  changed?: number
}
type Alarm = { alarmType: string; createRules: Record<string, { condition: { condition: { predicate: { value: { defaultValue: number } } }[] } }> }

async function main() {
  console.log('I4 自检（EG 侧）：配置下发与回执\n')
  const cfg = loadConfig()
  const code = cfg.cabinet.code
  const token = stationToken(cfg)
  const model = loadModel(MODEL)
  const base: ThresholdRow[] = model.thresholds
  const origVersion = String(cfg.eg.attrs['cfg'] ?? 'c-0000')
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const samProfile = `sam_${cfg.cabinet.group}`

  const ticket = (r: ClaimRole = 'station') => {
    const now = Date.now()
    return signTicket(token, { c: code, u: 'ext', n: '子站扩展服务', r, iat: now, exp: now + 60_000, j: randomBytes(8).toString('hex') })
  }
  const put = async (body: unknown, t: string | null = ticket()) => {
    const r = await fetch(`${AGENT}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(t ? { 'X-EG-Ticket': t } : {}) }, body: JSON.stringify(body) })
    return { http: r.status, body: (await r.json()) as Receipt & { message?: string } }
  }
  const rows = (patch: Record<string, number>) => base.map(r => (r.key in patch ? { ...r, [cfg.cabinet.group]: patch[r.key] } : r))
  const allOn = Object.keys({ 'EG-rise': 1, 'EG-rise2': 1, 'EG-tabs': 1, 'EG-pd': 1, 'EG-arc': 1, 'EG-rh': 1, 'EG-ol': 1, 'EG-pm': 1 }).map(id => ({ id, on: true }))
  const alarmsOf = async (name: string) => {
    const p = (await tb.get<{ data: { id: { id: string }; name: string }[] }>('/api/deviceProfiles?pageSize=100&page=0')).data.find(x => x.name === name)!
    return ((await tb.get<{ profileData: { alarms: Alarm[] | null } }>(`/api/deviceProfile/${p.id.id}`)).profileData.alarms ?? []) as Alarm[]
  }
  const limitOf = (as: Alarm[], type: string, sev: string) => as.find(a => a.alarmType === type)?.createRules[sev]?.condition.condition[0]?.predicate.value.defaultValue
  const cfgAttr = async () => tb.attr(cfg.eg.name, 'CLIENT_SCOPE', 'cfg')
  const baseArc = base.find(r => r.key === 'arc')![cfg.cabinet.group]!

  console.log('1. 鉴权：只认子站的服务票据')
  check((await put({ version: 'x' }, null)).http === 401, '不带票据 → 401')
  check((await put({ version: 'x' }, ticket('maint'))).http === 401, '维护角色的登录票据 → 401（不是服务票据）')
  const t1 = ticket()
  await put({ version: 'x' }, t1)
  const replay = await put({ version: 'x' }, t1)
  check(replay.http === 401, '同一张票据用第二次 → 401', replay.body.message)
  const sso = await fetch(`${AGENT}/api/auth/sso`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket() }) })
  check(sso.status === 401, '服务票据换不了浏览器会话')

  console.log('\n2. 应用：改弧光阈值、停一条规则')
  const v1 = `i4-${Date.now().toString(36)}-1`
  const r1 = await put({ version: v1, thresholds: rows({ arc: 90 }), rules: [...allOn.filter(r => r.id !== 'EG-rise'), { id: 'EG-rise', on: false }, { id: 'SP-noise', on: true }] })
  check(r1.body.status === 'APPLIED' && r1.body.version === v1, '回执 APPLIED、版本号对', JSON.stringify(r1.body))
  const a1 = await alarmsOf(samProfile)
  check(limitOf(a1, '弧光异常', 'CRITICAL') === 90, `本地 TB ${samProfile} 的弧光限值改成 90 %`, String(limitOf(a1, '弧光异常', 'CRITICAL')))
  check(!!a1.find(a => a.alarmType === '过温') && limitOf(a1, '过温', 'MAJOR') === undefined && limitOf(a1, '过温', 'CRITICAL') !== undefined, '停用 EG-rise：过温只剩上上限（CRITICAL）一级')
  const attr = await until(async () => ((await cfgAttr()) === v1 ? v1 : null), 15_000, 1000)
  check(!!attr, 'EG 的 cfg 属性（本地 TB 客户端属性）= 新版本', String(await cfgAttr()))
  const conf = await agent<{ applied: { version: string; rulesOff: string[] } }>(cfg.dir, '/api/config')
  check(conf.applied.version === v1 && conf.applied.rulesOff.includes('EG-rise'), '本地页看得到生效版本与停用的规则', JSON.stringify(conf.applied))

  console.log('\n3. 本地告警随之变（仿真器打弧光）')
  const sams = cfg.devices.filter(d => d.kind === 'sam').map(d => d.name)
  const activeArc = async () => {
    for (const d of sams) if ((await tb.alarms(d)).some(a => a.type === '弧光异常' && !a.status.startsWith('CLEARED'))) return true
    return false
  }
  check(!!(await until(async () => !(await activeArc()), 130_000, 5000)), '先等上一轮弧光告警恢复')
  let t0 = Date.now()
  const dev = ((await post(`${EMU}/emu/arc?intensity=85&ms=30`)) as { device: string }).device
  await sleep(8000)
  check(!(await tb.alarms(dev)).some(a => a.type === '弧光异常' && a.createdTime >= t0 - 2000), '强度 85 % < 新限值 90 %：不告警')
  t0 = Date.now()
  await post(`${EMU}/emu/arc?intensity=96&ms=30`)
  const hit = await until(async () => (await tb.alarms(dev)).find(a => a.type === '弧光异常' && a.createdTime >= t0 - 2000), 15_000, 500)
  check(!!hit, '强度 96 % > 90 %：告警', hit ? `${((hit.createdTime - t0) / 1000).toFixed(1)} s` : '15 s 内没有')

  console.log('\n4. 停用整类规则')
  const v2 = `i4-${Date.now().toString(36)}-2`
  const r2 = await put({ version: v2, thresholds: rows({ arc: 90 }), rules: allOn.map(r => (r.id === 'EG-arc' ? { ...r, on: false } : r)) })
  const a2 = await alarmsOf(samProfile)
  check(r2.body.status === 'APPLIED' && !a2.some(a => a.alarmType === '弧光异常') && limitOf(a2, '过温', 'MAJOR') !== undefined, '停用 EG-arc：弧光规则去掉，EG-rise 重新启用', JSON.stringify(r2.body))

  console.log('\n4b. 不认识的规则（子站比 EG 新）：跳过、回执列出，其余照常')
  const v3 = `i4-${Date.now().toString(36)}-3`
  const r6 = await put({ version: v3, thresholds: rows({ arc: 90 }), rules: [...allOn, { id: 'EG-nope', on: true }] })
  const ig = (r6.body as { ignored?: string[] }).ignored
  check(r6.body.status === 'APPLIED' && JSON.stringify(ig) === '["EG-nope"]' && (await alarmsOf(samProfile)).some(a => a.alarmType === '弧光异常'), '带 EG-nope：APPLIED、ignored = ["EG-nope"]、其余规则照常生效（弧光规则回来）', JSON.stringify(r6.body))
  const r7 = await put({ version: v2, thresholds: rows({ arc: 90 }), rules: allOn.map(r => (r.id === 'EG-arc' ? { ...r, on: false } : r)) })
  check(r7.body.status === 'APPLIED' && !('ignored' in r7.body), '都认识时回执不带 ignored（回到 v2）', JSON.stringify(r7.body))

  console.log('\n4c. 本地 TB 没就绪（刚开机）：回 PENDING 排队，就绪后自动应用（调试开关扮演 TB 没起来）')
  const dbg = (q: string) => fetch(`${AGENT}/api/config/_debug?${q}`, { method: 'POST' }).then(r => r.json() as Promise<{ tbDown: boolean; pending: { version: string; tries: number } | null }>)
  await dbg('tbDown=1')
  const v4 = `i4-${Date.now().toString(36)}-4`
  const r8 = await put({ version: v4, thresholds: rows({ arc: 650 }), rules: allOn })
  const b8 = r8.body as { status: string; retryable?: boolean; error?: string }
  check(b8.status === 'PENDING' && b8.retryable === true, '本地 TB 没就绪 → PENDING、retryable: true（不是 FAILED）', JSON.stringify(b8))
  check((await dbg('')).pending?.version === v4 && (await cfgAttr()) !== v4, `排着 ${v4}，cfg 属性还是旧版本`)
  const t4 = Date.now()
  await dbg('tbDown=0')
  const auto = await until(async () => ((await cfgAttr()) === v4 ? true : null), 40_000, 1000)
  check(!!auto && (await dbg('')).pending === null && limitOf(await alarmsOf(samProfile), '弧光异常', 'CRITICAL') === 650, 'TB 就绪后自动应用：cfg 属性变成新版本、排队清空、弧光限值 650 生效', auto ? `${((Date.now() - t4) / 1000).toFixed(1)} s` : '40 s 内没应用')
  await put({ version: v2, thresholds: rows({ arc: 90 }), rules: allOn.map(r => (r.id === 'EG-arc' ? { ...r, on: false } : r)) })

  console.log('\n5. 失败要回原因，且不改本机')
  const bad = async (what: string, body: Record<string, unknown>, want: RegExp) => {
    const r = await put({ version: `bad-${Date.now().toString(36)}`, thresholds: rows({ arc: 90 }), rules: allOn, ...body })
    check(r.body.status === 'FAILED' && want.test(r.body.error ?? ''), `${what} → FAILED`, r.body.error)
  }
  await bad('温升上上限不大于上限', { thresholds: rows({ rise: 80, rise2: 70 }) }, /上上限/)
  await bad('阈值表缺弧光限值', { thresholds: base.filter(r => r.key !== 'arc') }, /阈值表不全/)
  await bad('阈值是负数', { thresholds: rows({ arc: -1 }) }, /不小于 0/)
  await bad('设备清单与本机不同', { devices: [...cfg.devices, { name: 'SAM-X', kind: 'sam', label: '', attrs: {} }] }, /设备清单/)
  const r3 = await put({ version: '' })
  check(r3.body.status === 'FAILED', '没有版本号 → FAILED', r3.body.error)
  check((await agent<{ applied: { version: string } }>(cfg.dir, '/api/config')).applied.version === v2 && !(await alarmsOf(samProfile)).some(a => a.alarmType === '弧光异常'), '失败后生效版本与本地规则都没动')

  console.log('\n6. 重复下发同一版')
  const r4 = await put({ version: v2, thresholds: rows({ arc: 90 }), rules: allOn.map(r => (r.id === 'EG-arc' ? { ...r, on: false } : r)) })
  check(r4.body.status === 'APPLIED' && r4.body.changed === 0, '同版本同内容：APPLIED，不重写', JSON.stringify(r4.body))

  console.log('\n7. 审计')
  const audit = await agent<{ action: string; ok: boolean; target: string }[]>(cfg.dir, '/api/audit?limit=100')
  check(audit.some(a => a.action === '应用子站配置' && a.ok && a.target === v1) && audit.some(a => a.action === '应用子站配置' && !a.ok), '成功与失败都记进本地审计')

  console.log('\n8. 恢复原样（model.yaml 阈值、全部启用、原版本号）')
  const r5 = await put({ version: origVersion, thresholds: base, rules: allOn })
  const a5 = await alarmsOf(samProfile)
  check(r5.body.status === 'APPLIED' && limitOf(a5, '弧光异常', 'CRITICAL') === baseArc, `回到 ${origVersion}，弧光限值 ${baseArc}`, JSON.stringify(r5.body))
  const back = await until(async () => ((await cfgAttr()) === origVersion ? true : null), 15_000, 1000)
  check(!!back, `cfg 属性回到 ${origVersion}`)

  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
