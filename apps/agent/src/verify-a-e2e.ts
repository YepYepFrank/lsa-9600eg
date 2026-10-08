/* 阶段 A 端到端（子站 0.10 + EG 0.2.0）：在子站网关页「能力」同一个接口上改本柜 pm6（整台 PM6 只对应这一项能力），
 * 两头一起看 —— 子站该量变「待定」/ 不出、EG 本地照常 / 停采，改回 confirmed 后从那一刻起上送、之前的不补传。
 *
 *   pnpm --filter @lsa-eg/agent verify:a:e2e
 * 环境变量：EXT_BASE（子站，如 http://192.168.77.20）、EXT_USER（缺省 admin）、EXT_PASSWORD（要有配置权限；不打印）
 *           EG_CONFIG_DIR、EG_AGENT_URL、EG_TB_HTTP（同 verify:a）
 * 起点：pm6 是现场缺省 unsupported（production）。跑完退回 model（PUT null）。
 *   1. pending：子站出新配置版本、EG APPLIED；EG 本地 TB 有 PM6 的数（IoT Gateway 约 60 s 内重载）、不上送；
 *      子站实时点没有、网关详情 cap = pending、趋势「待定」；caps.actual pm6 = ok → 子站提示「标为待定，但 EG 采到了数据」；本地页颗粒物卡片「待定」
 *   2. unsupported：EG notLocal 有 PM6、本地 TB 不再收
 *   3. confirmed：子站实时点有 PM6，趋势里最早一条不早于改的时刻（pending 期间本地的数不补传）；本地有「烟气」规则（offCabs 去掉本柜）
 *   4. 退回 model */
import { loadConfig } from '@lsa-eg/config'
import { cardState, type CapState } from './caps/caps.js'
import { agent, check, done, env, sleep, Tb, until } from './verify/lib.js'

const EXT = env('EXT_BASE', 'http://192.168.77.20')
const LOCAL_TB = env('EG_TB_HTTP', 'http://127.0.0.1:18080')
const KEY = 'pm.2.5'

async function main() {
  const cfg = loadConfig()
  const dir = process.env['EG_CONFIG_DIR'] ?? ''
  const CAB = cfg.cabinet.code
  const pm6 = cfg.devices.find(d => d.name.startsWith('PM6-'))?.name
  if (!pm6) throw new Error(`${CAB} 没配 PM6`)
  console.log(`阶段 A 端到端 —— 子站 ${EXT}，柜 ${CAB}，设备 ${pm6}\n`)

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
  const cfgOf = async () => (await X<{ want: string; actual: string | null; status: string }>('GET', `/ext/eg/${CAB}/config`)).body
  /** 改能力 → 等子站配置 APPLIED 且 EG 收到的 pm6 是这个状态 */
  const setPm6 = async (st: CapState | null, reason: string) => {
    const r = await X('PUT', `/ext/cabinets/${CAB}/capabilities`, { caps: { pm6: st }, reason })
    const want = st ?? 'unsupported'
    const ok = await until(async () => {
      const [c, e] = await Promise.all([cfgOf(), egCaps()])
      return c.status === 'APPLIED' && c.actual === c.want && e.caps?.['pm6'] === want ? c : null
    }, 150_000, 3000)
    return { status: r.status, cfg: ok }
  }
  const localTs = async () => (await tb.latest(pm6, [KEY]))[KEY]?.ts ?? 0
  const spPoint = async () => ((await X<{ dev: string; key: string; changedAt?: number }[]>('GET', `/ext/rt/points/${CAB}`)).body ?? []).find(p => p.dev === pm6 && p.key === KEY)
  const gwPm = async () => {
    const g = (await X<any>('GET', `/ext/rt/gateways/${CAB}`)).body
    return g?.pm ?? (g?.devices ?? []).find((d: any) => d.id === pm6) ?? null
  }
  const trend = async (from: number) => {
    const b = (await X<{ step?: number; series: { data: [number, unknown][]; cap?: string; error?: string }[] }>('POST', '/ext/trend', { ids: [`${CAB}/${pm6}/${KEY}`], from, to: Date.now() })).body
    return { step: b?.step ?? 0, ...b?.series?.[0] }
  }
  const capRow = async () => ((await X<{ rows: { key: string; state: string; actual: string | null; mismatch: string | null }[] }>('GET', `/ext/cabinets/${CAB}/capabilities`)).body?.rows ?? []).find(r => r.key === 'pm6')
  const localTypes = async () => {
    const ps = (await tb.get<{ data: { id: { id: string } }[] }>('/api/deviceProfiles?pageSize=100&page=0')).data
    const t = new Set<string>()
    for (const p of ps) for (const a of (await tb.get<{ profileData: { alarms: { alarmType: string }[] | null } }>(`/api/deviceProfile/${p.id.id}`)).profileData.alarms ?? []) t.add(a.alarmType)
    return t
  }

  const base = await cfgOf()
  const row0 = await capRow()
  check(row0?.state === 'unsupported', `起点：${CAB} pm6 ${row0?.state}，配置 ${base.want} ${base.status}`)

  try {
    console.log('\n1. pm6 → pending')
    const t1 = Date.now()
    const s1 = await setPm6('pending', '端到端自检：pending')
    check(s1.status === 200 && !!s1.cfg, `PUT → ${s1.status}；子站配置 ${s1.cfg?.want ?? '—'} ${s1.cfg?.status ?? '没等到 APPLIED'}`)
    const e1 = await egCaps()
    check(e1.notUploaded.includes(pm6) && !e1.notLocal.includes(pm6), `EG：${pm6} 不上送、进本地（notUploaded ${JSON.stringify(e1.notUploaded)}，notLocal ${JSON.stringify(e1.notLocal)}）`)
    const l1 = await until(async () => ((await localTs()) > t1 ? await localTs() : null), 150_000, 5000)
    check(!!l1, `EG 本地 TB 有 ${pm6}/${KEY}（最新 ${l1 ? `${Math.round((l1 - t1) / 1000)} s 于改后` : '没等到'}）`)
    check(cardState(['smokePpm', 'pm6'], e1.caps ? { caps: e1.caps, capKeys: {} } : null) === 'pending', '本地页颗粒物 / 烟雾卡片：待定（数据仅供调试核对）')
    await sleep(15_000)
    const p1 = await spPoint()
    check(!p1, `子站实时点没有 ${pm6}/${KEY}（${p1 ? `有，changedAt ${p1.changedAt}` : '没有'}）`)
    const g1 = await gwPm()
    check(g1?.cap === 'pending', `子站网关详情 ${pm6}：cap ${g1?.cap ?? '—'}（前端「待定」）`)
    const tr1 = await trend(t1 - 60_000)
    check(tr1?.cap === 'pending', `子站趋势：${tr1?.error ?? '有数'}`)
    const r1 = await until(async () => {
      const r = await capRow()
      return r?.actual === 'ok' && r.mismatch ? r : null
    }, 120_000, 5000)
    check(!!r1, `子站能力页 pm6：实际 ${r1?.actual ?? '—'}，提示「${r1?.mismatch ?? '没有'}」`)

    console.log('\n2. pm6 → unsupported')
    const s2 = await setPm6('unsupported', '端到端自检：unsupported')
    check(s2.status === 200 && !!s2.cfg, `PUT → ${s2.status}；子站配置 ${s2.cfg?.want ?? '—'} ${s2.cfg?.status ?? '没等到 APPLIED'}`)
    const e2 = await egCaps()
    check(e2.notUploaded.includes(pm6) && e2.notLocal.includes(pm6), `EG：${pm6} 不上送、不进本地（notLocal ${JSON.stringify(e2.notLocal)}）`)
    const stopped = await until(async () => {
      const a = await localTs()
      await sleep(30_000)
      return (await localTs()) === a ? a : null
    }, 180_000, 1000)
    check(!!stopped, `EG 本地 TB 不再收 ${KEY}（最后一条 ${stopped ? new Date(stopped).toISOString() : '—'}）`)

    console.log('\n3. pm6 → confirmed')
    const t3 = Date.now()
    const s3 = await setPm6('confirmed', '端到端自检：confirmed')
    check(s3.status === 200 && !!s3.cfg, `PUT → ${s3.status}；子站配置 ${s3.cfg?.want ?? '—'} ${s3.cfg?.status ?? '没等到 APPLIED'}`)
    const e3 = await egCaps()
    check(!e3.notUploaded.includes(pm6) && !e3.notLocal.includes(pm6), `EG：${pm6} 上送、进本地`)
    const p3 = await until(spPoint, 180_000, 5000)
    check(!!p3, `子站实时点有 ${pm6}/${KEY}（${p3 ? `${Math.round(((p3.changedAt ?? 0) - t3) / 1000)} s 于改后` : '没等到'}）`)
    const tr3 = await trend(t1 - 60_000)
    const tss = (tr3?.data ?? []).filter(d => d[1] !== null).map(d => d[0])
    const first = tss.length ? Math.min(...tss) : 0
    check(tss.length > 0 && first >= t3 - (tr3.step || 0) - 5000, `子站趋势（从 pending 前 1 min 起）${tss.length} 条，最早 ${first ? `${Math.round((first - t3) / 1000)} s 于改 confirmed 后` : '—'}，桶宽 ${Math.round((tr3.step || 0) / 1000)} s（pending 期间的不补传）`)
    const ty3 = await until(async () => ((await localTypes()).has('烟气') ? true : null), 60_000, 5000)
    check(!!ty3, 'EG-pm 本柜不再 offCabs：本地有「烟气」规则')
  } finally {
    console.log('\n4. 退回 model')
    const s4 = await setPm6(null, '端到端自检收尾')
    check(s4.status === 200 && !!s4.cfg, `PUT null → ${s4.status}；子站配置 ${s4.cfg?.want ?? '—'} ${s4.cfg?.status ?? '没等到 APPLIED'}（起点 ${base.want}）`)
  }
  done()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
