/* 阶段 A 现场口径自检（EG 侧）：照子站 ext 的 EgConfigService.body() 拼一份 production 口径的配置下发给这台 EG，看规则与能力是否如约。
 *
 *   pnpm --filter @lsa-eg/agent verify:a:prod
 * 环境变量同 verify:a（EG_AGENT_URL、EG_CONFIG_DIR、EG_TB_HTTP、LSA_BACKEND、EG_A_VERSION）。
 * production 口径（@lsa/model caps.ts CAP_DEFAULT_PRODUCTION）：局放次数 / 类型 / 等级、弧光、烟雾、谐波 / THD / 需量、开关位置 pending；
 * pm6、tev unsupported；其余 confirmed。规则：某柜对应能力（RULE_CAP）不是 confirmed 的进 offCabs；EG-rh 缺省停用。
 * 期望（本柜）：EG-arc（弧光 pending）、EG-pm（pm6 unsupported）关；EG-pd 开且只看 us.amp；PM6 整台不进本地 TB、不上送；SAM 照常。
 * 跑完不恢复 —— 由子站重发它自己的配置（网关页「下发配置」或 POST /ext/gateways/<柜>/sync）。
 * EG_A_READONLY=1：不下发，只看 EG 上现在生效的（真子站 0.10 下发的）是不是这个口径。 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { CAP_DEFAULT_PRODUCTION, CAP_KEYMAP, RULE_CAP, loadModel } from '@lsa/model'
import { loadConfig, repoRoot, stationToken } from '@lsa-eg/config'
import { signTicket } from './auth/ticket.js'
import { agent, AGENT, check, done, env, Tb, until } from './verify/lib.js'

const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const MODEL = resolve(env('LSA_BACKEND', resolve(repoRoot() ?? '.', '../lsa-9600sp-backend')), 'tb/model.yaml')
const RULES = ['EG-rise', 'EG-rise2', 'EG-tabs', 'EG-pd', 'EG-arc', 'EG-rh', 'EG-ol', 'EG-pm', 'EG-dphase', 'EG-devlost']
const DEFAULT_OFF = new Set(['EG-rh'])

async function main() {
  console.log('阶段 A 现场口径（production）自检\n')
  const cfg = loadConfig()
  const dir = process.env['EG_CONFIG_DIR'] ?? ''
  const code = cfg.cabinet.code
  const model = loadModel(MODEL)
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()
  const codes = [code, 'AH12'].filter((c, i, a) => a.indexOf(c) === i).sort()
  const caps = Object.fromEntries(codes.map(c => [c, { ...CAP_DEFAULT_PRODUCTION }]))
  const rules = RULES.map(id => {
    const cap = RULE_CAP[id]
    const offCabs = cap ? codes.filter(c => caps[c]![cap] !== 'confirmed') : []
    const on = !DEFAULT_OFF.has(id)
    return offCabs.length ? { id, on, offCabs } : { id, on }
  })
  const capKeys = Object.fromEntries(Object.entries(CAP_KEYMAP).filter(([, v]) => v.length))
  const body = { version: process.env['EG_A_VERSION'] ?? `prod-${Date.now().toString(36)}`, thresholds: model.thresholds, rules, extras: model.thresholdExtras, caps, capKeys, devComm: { failN: 5, minMs: 30_000, periods: 5 } }
  const now = Date.now()
  const ticket = signTicket(stationToken(cfg), { c: code, u: 'ext', n: '现场口径自检', r: 'station', iat: now, exp: now + 60_000, j: randomBytes(8).toString('hex') })
  const RO = process.env["EG_A_READONLY"] === "1"
  const r = RO
    ? { status: "APPLIED" as const, error: undefined, changed: 0 }
    : (await (await fetch(`${AGENT}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-EG-Ticket': ticket }, body: JSON.stringify(body) })).json()) as { status: string; error?: string; changed?: number }
  if (RO) {
    const st = await agent<{ applied?: { version?: string; by?: string; rulesOff?: string[] } }>(dir, '/api/config')
    console.log(`   只读：看 EG 上现在生效的配置 ${st.applied?.version ?? '?'}（${st.applied?.by ?? '?'}，停用 ${st.applied?.rulesOff?.join('、') || '—'}）`)
  } else check(r.status === 'APPLIED', `下发 production 口径 → ${r.status}${r.error ? `：${r.error}` : ''}（改了 ${r.changed ?? 0} 个设备配置）`)
  console.log(`   规则：${rules.map(x => `${x.id}${x.on ? '' : '(停)'}${'offCabs' in x ? `[offCabs ${x.offCabs!.join(',')}]` : ''}`).join(' ')}`)

  type Alarm = { alarmType: string; createRules: Record<string, { condition: { condition: { key: { key: string } }[] } }> }
  const ps = (await tb.get<{ data: { id: { id: string }; name: string }[] }>('/api/deviceProfiles?pageSize=100&page=0')).data
  const alarms: Alarm[] = []
  for (const p of ps) alarms.push(...(((await tb.get<{ profileData: { alarms: Alarm[] | null } }>(`/api/deviceProfile/${p.id.id}`)).profileData.alarms ?? []) as Alarm[]))
  const types = new Set(alarms.map(a => a.alarmType))
  check(!types.has('弧光异常'), `EG-arc 关（弧光 pending → offCabs 有本柜）：本地设备配置里没有「弧光异常」`)
  check(!types.has('烟气'), `EG-pm 关（pm6 unsupported）：本地没有「烟气」`)
  check(!types.has('柜内湿度高') && !types.has('环境'), `EG-rh 缺省停用：本地没有「柜内湿度高」（也没有旧名「环境」）`)
  const pd = alarms.find(a => a.alarmType === '局放异常')
  const pdKeys = pd ? [...new Set(Object.values(pd.createRules).flatMap(c => c.condition.condition.map(x => x.key.key)))] : []
  check(!!pd && pdKeys.includes('us.amp') && !pdKeys.includes('us.cnt'), `EG-pd 开、只看 us.amp（条件 key：${pdKeys.join('、') || '—'}）`)
  check(types.has('过温') && types.has('过载'), `过温 / 过载照常（thermalRegions / meterBasic confirmed）`)

  const ci = await agent<{ delivered: boolean; notUploaded: string[]; notLocal: string[] }>(dir, '/api/caps')
  const pm6 = cfg.devices.find(d => d.name.startsWith('PM6-'))?.name
  if (pm6) check(ci.notLocal.includes(pm6) && ci.notUploaded.includes(pm6), `${pm6}（pm6 unsupported）：不进本地 TB、不上送（notLocal ${JSON.stringify(ci.notLocal)}）`)
  const sam = cfg.devices.find(d => d.name.startsWith('SAM-'))!.name
  check(!ci.notUploaded.includes(sam) && !ci.notLocal.includes(sam), `${sam} 照常（局放幅值、温湿度 confirmed；弧光、次数 pending 的 key 由子站按能力过滤）`)
  const act = await until(async () => {
    const v = await tb.attr(cfg.eg.name, 'CLIENT_SCOPE', 'caps.actual')
    return typeof v === 'string' ? (JSON.parse(v) as Record<string, string>) : null
  }, 60_000, 3000)
  check(!!act && act['pdAmplitude'] === 'ok' && act['envTH'] === 'ok', `caps.actual：pdAmplitude ${act?.['pdAmplitude']}、envTH ${act?.['envTH']}、arcIntensity ${act?.['arcIntensity']}（pending 而有数 → 子站提示）、pm6 ${act?.['pm6']}`)
  done()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
