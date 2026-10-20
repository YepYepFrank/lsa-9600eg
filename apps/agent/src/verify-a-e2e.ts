/* 阶段 A 端到端（子站 0.18.1 + EG 0.7.1）：在子站网关页「能力」同一个接口上改本单元的 smokePpm（烟雾 = SAM 气体传感器的 smoke.*），
 * 两头一起看 —— 子站该量变「待定」/ 不出、EG 的烟气规则跟着停 / 开，改回 confirmed 后从那一刻起子站才有。
 * （0.7.1 以前拿整台 PM6 做；PM6 取消后烟雾只是 SAM 的一个 key，EG 按设备过滤、key 由子站按能力过滤，所以 SAM 整台照常上送）
 *
 *   pnpm --filter @lsa-eg/agent verify:a:e2e
 * 环境变量：EXT_BASE（子站，如 http://192.168.77.20）、EXT_USER（缺省 admin）、EXT_PASSWORD（要有配置权限；不打印）
 *           EG_CONFIG_DIR、EG_AGENT_URL、EG_TB_HTTP（同 verify:a）
 * 起点：smokePpm 是现场缺省 confirmed（production，0.18.1 起）。跑完退回 model（PUT null）。
 *   1. pending：子站出新配置版本、EG APPLIED；EG 上 SAM 照常进本地、照常上送，本地 TB 照常有 smoke.ppm；
 *      子站实时点没有 smoke.ppm、趋势「待定」；caps.actual smokePpm = ok → 子站提示「标为待定，但 EG 采到了数据」；
 *      本地页烟雾卡片「待定」；EG-smoke 本柜进 offCabs → 本地没有「烟气」规则
 *   2. unsupported：本地页烟雾卡片隐藏；本地照旧没有「烟气」
 *   3. confirmed：子站实时点有 smoke.ppm（改后的新值）；本地有「烟气」规则（offCabs 去掉本柜）
 *   4. 退回 model */
import { loadConfig } from '@lsa-eg/config'
import { cardState, type CapState } from './caps/caps.js'
import { agent, check, done, env, sleep, Tb, until } from './verify/lib.js'

const EXT = env('EXT_BASE', 'http://192.168.77.20')
const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const KEY = 'smoke.ppm'
const CAP = 'smokePpm'

async function main() {
  const cfg = loadConfig()
  const dir = process.env['EG_CONFIG_DIR'] ?? ''
  // 子站能力按单元号（照旧一柜一台的 = 柜号）；实时点 / 趋势按柜
  const UNIT = cfg.unit.code
  const CAB = cfg.cabinet.code
  const sam = cfg.devices.find(d => d.kind === 'sam')?.name
  if (!sam) throw new Error(`${UNIT} 没配 SAM`)
  console.log(`阶段 A 端到端 —— 子站 ${EXT}，单元 ${UNIT}，${sam} 的 ${KEY}\n`)

  const login = await (await fetch(`${EXT}/ext/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env('EXT_USER', 'admin'), password: env('EXT_PASSWORD', '') }) })).json() as { token?: string }
  if (!login.token) throw new Error('子站登录不上（EXT_USER / EXT_PASSWORD）')
  const X = async <T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(EXT + p, { method, headers: { Authorization: `Bearer ${login.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    return { status: r.status, body: (t ? JSON.parse(t) : null) as T }
  }
  const tb = await new Tb(LOCAL_TB, cfg.tb?.user ?? '', cfg.tb?.password ?? '').login()

  type Caps = { delivered: boolean; caps: Record<string, CapState> | null; notUploaded: string[]; notLocal: string[] }
  const egCaps = () => agent<Caps>(dir, '/api/caps')
  const cfgOf = async () => (await X<{ want: string; actual: string | null; status: string }>('GET', `/ext/eg/${UNIT}/config`)).body
  /** 改能力 → 等子站配置 APPLIED 且 EG 收到的 smokePpm 是这个状态（null = 退回 model，缺省 confirmed） */
  const setCap = async (st: CapState | null, reason: string) => {
    const r = await X('PUT', `/ext/cabinets/${UNIT}/capabilities`, { caps: { [CAP]: st }, reason })
    const want = st ?? 'confirmed'
    const ok = await until(async () => {
      const [c, e] = await Promise.all([cfgOf(), egCaps()])
      return c.status === 'APPLIED' && c.actual === c.want && e.caps?.[CAP] === want ? c : null
    }, 150_000, 3000)
    return { status: r.status, cfg: ok }
  }
  const localTs = async () => (await tb.latest(sam, [KEY]))[KEY]?.ts ?? 0
  const spPoint = async () => ((await X<{ dev: string; key: string; changedAt?: number }[]>('GET', `/ext/rt/points/${CAB}`)).body ?? []).find(p => p.dev === sam && p.key === KEY)
  const trend = async (from: number) => {
    const b = (await X<{ step?: number; series: { data: [number, unknown][]; cap?: string; error?: string }[] }>('POST', '/ext/trend', { ids: [`${CAB}/${sam}/${KEY}`], from, to: Date.now() })).body
    return { step: b?.step ?? 0, ...b?.series?.[0] }
  }
  const capRow = async () => ((await X<{ rows: { key: string; state: string; actual: string | null; mismatch: string | null }[] }>('GET', `/ext/cabinets/${UNIT}/capabilities`)).body?.rows ?? []).find(r => r.key === CAP)
  const localTypes = async () => {
    const ps = (await tb.get<{ data: { id: { id: string } }[] }>('/api/deviceProfiles?pageSize=100&page=0')).data
    const t = new Set<string>()
    for (const p of ps) for (const a of (await tb.get<{ profileData: { alarms: { alarmType: string }[] | null } }>(`/api/deviceProfile/${p.id.id}`)).profileData.alarms ?? []) t.add(a.alarmType)
    return t
  }

  const base = await cfgOf()
  const row0 = await capRow()
  check(row0?.state === 'confirmed', `起点：${UNIT} ${CAP} ${row0?.state}，配置 ${base.want} ${base.status}`)
  check((await localTypes()).has('烟气'), '起点：本地有「烟气」规则（EG-smoke 缺省开）')

  try {
    console.log(`\n1. ${CAP} → pending`)
    const t1 = Date.now()
    const s1 = await setCap('pending', '端到端自检：pending')
    check(s1.status === 200 && !!s1.cfg, `PUT → ${s1.status}；子站配置 ${s1.cfg?.want ?? '—'} ${s1.cfg?.status ?? '没等到 APPLIED'}`)
    const e1 = await egCaps()
    check(!e1.notUploaded.includes(sam) && !e1.notLocal.includes(sam), `EG：${sam} 整台照常（局放、温湿度还是 confirmed；smoke.ppm 由子站按能力过滤）`)
    const l1 = await until(async () => ((await localTs()) > t1 ? await localTs() : null), 60_000, 5000)
    check(!!l1, `EG 本地 TB 照常有 ${sam}/${KEY}（最新 ${l1 ? `${Math.round((l1 - t1) / 1000)} s 于改后` : '没等到'}）`)
    check(cardState([CAP], e1.caps ? { caps: e1.caps, capKeys: {} } : null) === 'pending', '本地页烟雾卡片：待定（数据仅供调试核对）')
    const ty1 = await until(async () => (!(await localTypes()).has('烟气') ? true : null), 60_000, 5000)
    check(!!ty1, 'EG-smoke 本柜进 offCabs：本地没有「烟气」规则了')
    await sleep(15_000)
    const p1 = await spPoint()
    check(!p1 || (p1.changedAt ?? 0) < t1, `子站实时点没有改后的 ${sam}/${KEY}（${p1 ? `留着改前的，changedAt ${p1.changedAt}` : '没有'}）`)
    const tr1 = await trend(t1 - 60_000)
    check(tr1?.cap === 'pending', `子站趋势：cap ${tr1?.cap ?? '—'}${tr1?.error ? `（${tr1.error}）` : ''}`)
    const r1 = await until(async () => {
      const r = await capRow()
      return r?.actual === 'ok' && r.mismatch ? r : null
    }, 120_000, 5000)
    check(!!r1, `子站能力页 ${CAP}：实际 ${r1?.actual ?? '—'}，提示「${r1?.mismatch ?? '没有'}」`)

    console.log(`\n2. ${CAP} → unsupported`)
    const s2 = await setCap('unsupported', '端到端自检：unsupported')
    check(s2.status === 200 && !!s2.cfg, `PUT → ${s2.status}；子站配置 ${s2.cfg?.want ?? '—'} ${s2.cfg?.status ?? '没等到 APPLIED'}`)
    const e2 = await egCaps()
    check(cardState([CAP], e2.caps ? { caps: e2.caps, capKeys: {} } : null) === 'hidden' && !e2.notLocal.includes(sam), `本地页烟雾卡片隐藏；${sam} 整台照常进本地（别的能力还在）`)
    check(!(await localTypes()).has('烟气'), '本地照旧没有「烟气」规则')

    console.log(`\n3. ${CAP} → confirmed`)
    const t3 = Date.now()
    const s3 = await setCap('confirmed', '端到端自检：confirmed')
    check(s3.status === 200 && !!s3.cfg, `PUT → ${s3.status}；子站配置 ${s3.cfg?.want ?? '—'} ${s3.cfg?.status ?? '没等到 APPLIED'}`)
    // 实时点的 changedAt 可能是改 pending 之前留在子站的旧值：要等改后的新值
    const p3 = await until(async () => { const p = await spPoint(); return p && (p.changedAt ?? 0) >= t3 ? p : null }, 180_000, 5000)
    check(!!p3, `子站实时点有 ${sam}/${KEY}（${p3 ? `${Math.round(((p3.changedAt ?? 0) - t3) / 1000)} s 于改后` : '没等到'}）`)
    const ty3 = await until(async () => ((await localTypes()).has('烟气') ? true : null), 60_000, 5000)
    check(!!ty3, 'EG-smoke 本柜不再 offCabs：本地有「烟气」规则')
  } finally {
    console.log('\n4. 退回 model')
    const s4 = await setCap(null, '端到端自检收尾')
    check(s4.status === 200 && !!s4.cfg, `PUT null → ${s4.status}；子站配置 ${s4.cfg?.want ?? '—'} ${s4.cfg?.status ?? '没等到 APPLIED'}（起点 ${base.want}）`)
  }
  done()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
