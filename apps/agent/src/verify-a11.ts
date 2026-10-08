/* 阶段 A11 自检（EG 侧）：配置回执带回 requestId、FAILED / PENDING 带 errorCode；票据不对的 401 体 code = TICKET_TIME / TICKET_INVALID。
 *
 *   pnpm --filter @lsa-eg/agent verify:a11
 * 环境变量同 verify:a（EG_AGENT_URL、EG_CONFIG_DIR、LSA_BACKEND）；给了 EXT_BASE + EXT_PASSWORD 时，最后让子站重发它自己的配置（还原）。
 * 出错的几份都在校验这一步就被拒，不动本地 TB；只有最后一份（production 口径、版本 a11-…）真会应用，跑完由子站重发还原。 */
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { CAP_DEFAULT_PRODUCTION, CAP_KEYMAP, RULE_CAP, loadModel } from '@lsa/model'
import { loadConfig, repoRoot, stationToken } from '@lsa-eg/config'
import { signTicket, type TicketClaims } from './auth/ticket.js'
import { AGENT, check, done, env, until } from './verify/lib.js'

const MODEL = resolve(env('LSA_BACKEND', resolve(repoRoot() ?? '.', '../lsa-9600sp-backend')), 'tb/model.yaml')
const EXT = process.env['EXT_BASE']
const RULES = ['EG-rise', 'EG-rise2', 'EG-tabs', 'EG-pd', 'EG-arc', 'EG-rh', 'EG-ol', 'EG-pm', 'EG-dphase', 'EG-devlost']

async function main() {
  console.log('阶段 A11 自检：requestId / errorCode / 票据 401 的 code\n')
  const cfg = loadConfig()
  const code = cfg.cabinet.code
  const model = loadModel(MODEL)
  const tok = stationToken(cfg)
  const ticket = (over: Partial<TicketClaims> = {}) => {
    const now = Date.now()
    return signTicket(tok, { c: code, u: 'ext', n: 'A11 自检', r: 'station', iat: now, exp: now + 60_000, j: randomBytes(8).toString('hex'), ...over })
  }
  const put = async (body: unknown, t: string | null = ticket()) => {
    const r = await fetch(`${AGENT}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(t === null ? {} : { 'X-EG-Ticket': t }) }, body: JSON.stringify(body) })
    return { http: r.status, j: (await r.json()) as { status?: string; error?: string; errorCode?: string; requestId?: string; changed?: number; code?: string; message?: string } }
  }
  const codes = [code, 'AH12'].filter((c, i, a) => a.indexOf(c) === i).sort()
  const caps = Object.fromEntries(codes.map(c => [c, { ...CAP_DEFAULT_PRODUCTION }]))
  const rules = RULES.map(id => {
    const cap = RULE_CAP[id]
    const offCabs = cap ? codes.filter(c => caps[c]![cap] !== 'confirmed') : []
    return { id, on: id !== 'EG-rh', ...(offCabs.length ? { offCabs } : {}) }
  })
  const capKeys = Object.fromEntries(Object.entries(CAP_KEYMAP).filter(([, v]) => v.length))
  const good = (version: string) => ({ version, thresholds: model.thresholds, rules, extras: model.thresholdExtras, caps, capKeys, devComm: { failN: 5, minMs: 30_000, periods: 5 } })

  console.log('1. 校验不过 → FAILED + errorCode，requestId 原样带回（都不动本地 TB）')
  const g = cfg.cabinet.group
  const cases: [string, unknown, string][] = [
    ['版本号不合法', { ...good('bad version!') }, 'BAD_VERSION'],
    ['阈值表为空', { ...good('a11-x'), thresholds: [] }, 'BAD_THRESHOLD'],
    ['阈值是负数', { ...good('a11-x'), thresholds: model.thresholds.map(r => (r.key === 'rise' ? { ...r, [g]: -1 } : r)) }, 'BAD_THRESHOLD'],
    ['温升上上限 ≤ 上限', { ...good('a11-x'), thresholds: model.thresholds.map(r => (r.key === 'rise2' ? { ...r, [g]: 1 } : r)) }, 'BAD_THRESHOLD'],
    ['设备清单不同', { ...good('a11-x'), devices: [...cfg.devices.map(d => ({ name: d.name, kind: d.kind })), { name: 'SAM-X-Z', kind: 'sam' }] }, 'DEVICES_MISMATCH'],
    ['caps 不是对象', { ...good('a11-x'), caps: 1 }, 'BAD_REQUEST'],
    ['rules 不是数组', { ...good('a11-x'), rules: {} }, 'BAD_REQUEST'],
  ]
  for (const [what, body, want] of cases) {
    const id = randomUUID()
    const { http, j } = await put({ ...(body as object), requestId: id })
    check(http === 200 && j.status === 'FAILED' && j.errorCode === want && j.requestId === id, `${what} → ${http} ${j.status} ${j.errorCode}（要 ${want}）${j.requestId === id ? '，requestId 带回' : '，requestId 没带回'}`, j.error)
  }
  const { j: noRid } = await put(good('bad version!'))
  check(noRid.status === 'FAILED' && noRid.errorCode === 'BAD_VERSION' && !('requestId' in noRid), '不带 requestId（老子站）：照常回执，不带 requestId 字段')
  const { j: oddRid } = await put({ ...good('bad version!'), requestId: 42 })
  check(oddRid.errorCode === 'BAD_VERSION' && !('requestId' in oddRid), 'requestId 不是字符串：不认、也不因此拒收（照常按别的出错）')

  console.log('\n2. 票据不对 → 401，code 分 TICKET_TIME / TICKET_INVALID')
  const now = Date.now()
  const tcases: [string, string | null, string][] = [
    ['没带票据', null, 'TICKET_INVALID'],
    ['签名不对', ticket().slice(0, -4) + 'AAAA', 'TICKET_INVALID'],
    ['不是本柜的', ticket({ c: 'ZZ99' }), 'TICKET_INVALID'],
    ['角色不是 station', ticket({ r: 'maint' }), 'TICKET_INVALID'],
    ['签发时间在未来 5 min（EG 慢）', ticket({ iat: now + 300_000, exp: now + 360_000 }), 'TICKET_TIME'],
    ['已过期 5 min（EG 快）', ticket({ iat: now - 360_000, exp: now - 300_000 }), 'TICKET_TIME'],
  ]
  for (const [what, t, want] of tcases) {
    const { http, j } = await put({ ...good('a11-x'), requestId: randomUUID() }, t)
    check(http === 401 && j.code === want, `${what} → ${http} code ${j.code}（要 ${want}）`, j.message)
  }
  const once = ticket()
  await put(good('bad version!'), once)
  const { http: h2, j: j2 } = await put(good('bad version!'), once)
  check(h2 === 401 && j2.code === 'TICKET_INVALID' && /已用过/.test(j2.message ?? ''), `同一张票据用第二次 → ${h2} code ${j2.code}（${j2.message}）`)

  console.log('\n3. 应用成功 → APPLIED，requestId 带回，不带 errorCode')
  const ver = `a11-${Date.now().toString(36)}`
  const id = randomUUID()
  const { j: ok } = await put({ ...good(ver), requestId: id })
  check(ok.status === 'APPLIED' && ok.requestId === id && !('errorCode' in ok), `版本 ${ver} → ${ok.status}（改了 ${ok.changed ?? 0} 个），requestId ${ok.requestId === id ? '带回' : '没带回'}`)
  const id2 = randomUUID()
  const { j: same } = await put({ ...good(ver), requestId: id2 })
  check(same.status === 'APPLIED' && same.changed === 0 && same.requestId === id2, `同一份重发（新 requestId）→ ${same.status}、改了 ${same.changed}、带回新的 requestId`)

  if (EXT && process.env['EXT_PASSWORD']) {
    console.log('\n4. 还原：子站重发它自己的配置')
    const login = (await (await fetch(`${EXT}/ext/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env('EXT_USER', 'admin'), password: process.env['EXT_PASSWORD'] }) })).json()) as { token?: string }
    const H = { Authorization: `Bearer ${login.token}` }
    const r = await fetch(`${EXT}/ext/gateways/${code}/sync`, { method: 'POST', headers: H })
    const back = await until(async () => {
      const c = (await (await fetch(`${EXT}/ext/eg/${code}/config`, { headers: H })).json()) as { want: string; actual: string; status: string }
      return c.status === 'APPLIED' && c.actual === c.want ? c : null
    }, 120_000, 3000)
    check(r.ok && !!back, `POST /ext/gateways/${code}/sync → ${r.status}；子站 ${back?.want ?? '—'} ${back?.status ?? '没等到 APPLIED'}`)
  } else console.log('\n（没给 EXT_BASE / EXT_PASSWORD：EG 停在 ' + ver + '，请在子站网关页「下发配置」还原）')
  done()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
