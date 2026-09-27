/* G2 自检：本地服务与访问（开发计划 §5、G2）。
 *
 *   pnpm g2:verify            约 3 分钟（含重启一次 IoT Gateway、剪断上行 70 s）
 *   pnpm g2:verify -- --fast  跳过重启与断网
 *
 * 前提：G1 的环境 + 子站扩展服务在跑（EXT_URL，默认 http://localhost:3001），并以
 * EXT_EG_URLS=<柜号>=http://127.0.0.1:9100 让它把 /eg/<柜号>/ 反代到本机 eg-agent。
 * 子站账号用开发环境的默认账号（admin / duty / guest，口令 LSA_PASS，默认 lsa9600sp）。 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig, type EgConfig } from '@lsa-eg/config'
import { AuditService } from './audit/audit.service.js'
import { AuthError, AuthService, POLICY } from './auth/auth.service.js'
import { signTicket as egSign, verifyTicket } from './auth/ticket.js'
// 子站那边的签发实现：两边必须逐字一致（同一张票据两边都认）
import { signTicket as spSign } from '../../../../lsa-9600sp-backend/apps/ext/src/eg/ticket.js'
import { AGENT, check, docker, done, env, localPassword, post, SIM, sleep, until } from './verify/lib.js'

const FAST = process.argv.includes('--fast')
const EXT = env('EXT_URL', 'http://localhost:3001')
const SP_PASS = env('LSA_PASS', 'lsa9600sp')

interface Json {
  [k: string]: unknown
}

async function req(base: string, path: string, init: { method?: string; body?: unknown; token?: string; accept?: string } = {}) {
  const r = await fetch(base + path, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.accept ? { accept: init.accept } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await r.text()
  let json: Json | null = null
  try {
    json = JSON.parse(text) as Json
  } catch {
    /* 不是 JSON */
  }
  return { status: r.status, text, json, location: r.headers.get('location') }
}

async function spLogin(user: string): Promise<string> {
  const r = await req(EXT, '/ext/auth/login', { method: 'POST', body: { username: user, password: SP_PASS } })
  if (r.status !== 200) throw new Error(`子站 ${user} 登录失败 ${r.status} ${r.text.slice(0, 120)}`)
  return String(r.json!['token'])
}

/** 经子站：拿票据 → 经反代换 EG 会话 */
async function viaSp(user: string, code: string) {
  const tok = await spLogin(user)
  const t = await req(EXT, `/ext/eg/${code}/ticket`, { method: 'POST', token: tok, body: {} })
  if (t.status !== 200) return { ticketStatus: t.status, message: String(t.json?.['message'] ?? t.text) }
  const url = String(t.json!['url'])
  const ticket = decodeURIComponent(url.split('sso=')[1]!)
  const s = await req(EXT, `/eg/${code}/api/auth/sso`, { method: 'POST', body: { ticket } })
  return { ticketStatus: 200, url, ticket, role: t.json!['role'], sso: s, token: s.json ? String(s.json['token'] ?? '') : '' }
}

async function main() {
  console.log(`G2 自检：本地服务与访问${FAST ? '（--fast）' : ''}\n`)
  const cfg = loadConfig()
  const code = cfg.cabinet.code
  const pw = localPassword(cfg.dir)

  console.log('1. 票据：两边实现一致、验签严格')
  const claims = { c: code, u: 'zhang', n: '运维 · 张工', r: 'maint' as const }
  const now = Date.now()
  const fromSp = spSign(cfg.eg.token, claims, now)
  const ok = verifyTicket(cfg.eg.token, fromSp, code, now)
  check(!('error' in ok) && ok.u === 'zhang', '子站签的票据 EG 认')
  const same = egSign(cfg.eg.token, { ...claims, iat: now, exp: now + 60_000, j: 'x' })
  check(!('error' in verifyTicket(cfg.eg.token, same, code, now)), 'EG 端的签发函数与子站同格式')
  check('error' in verifyTicket('another-token-xxxx', fromSp, code, now), '别的 EG 的令牌验不过（每台密钥不同）')
  check('error' in verifyTicket(cfg.eg.token, fromSp, 'AH99', now), '票据只对本柜有效')
  check('error' in verifyTicket(cfg.eg.token, fromSp, code, now + 3 * 60_000), '过期票据不认')
  const parts = fromSp.split('.')
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()), r: 'maint', u: 'hacker' })).toString('base64url')
  check('error' in verifyTicket(cfg.eg.token, `v1.${forged}.${parts[2]}`, code, now), '改了载荷的票据不认')

  console.log('\n2. 本地账号：锁定策略（临时目录里的独立实例，不碰正式账号）')
  {
    const dir = mkdtempSync(join(tmpdir(), 'eg-g2-'))
    process.env['EG_ADMIN_PASSWORD'] = 'Temp1234x'
    const fake = { ...cfg, dir } as EgConfig
    const auth = new AuthService(fake, new AuditService(fake))
    delete process.env['EG_ADMIN_PASSWORD']
    let lastErr: AuthError | null = null
    for (let i = 0; i < POLICY.lockAfter; i++) {
      try {
        auth.login('maint', 'wrong-pass', '127.0.0.1')
      } catch (e) {
        lastErr = e as AuthError
      }
    }
    check(lastErr?.code === 'locked', `连错 ${POLICY.lockAfter} 次锁定`, lastErr?.message)
    let lockedEvenRight = false
    try {
      auth.login('maint', 'Temp1234x', '127.0.0.1')
    } catch (e) {
      lockedEvenRight = (e as AuthError).code === 'locked'
    }
    check(lockedEvenRight, '锁定期间口令对了也进不去')
    const auditLines = readFileSync(resolve(dir, 'audit.log'), 'utf8').trim().split('\n')
    check(auditLines.length >= POLICY.lockAfter + 1, '每次登录尝试都记了审计', `${auditLines.length} 条`)
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('\n3. 直连：本地维护账号')
  check((await req(AGENT, '/api/status')).status === 401, '不登录取不到数据（401）')
  const bad = await req(AGENT, '/api/auth/login', { method: 'POST', body: { user: 'maint', password: 'definitely-wrong' } })
  check(bad.status === 401 && /再错 \d 次/.test(String(bad.json?.['message'])), '口令错给出剩余次数', String(bad.json?.['message']))
  const good = await req(AGENT, '/api/auth/login', { method: 'POST', body: { user: 'maint', password: pw } })
  let lt = String(good.json?.['token'] ?? '')
  check(good.status === 200 && good.json?.['role'] === 'maint' && good.json?.['via'] === 'local', '本地账号登录 → 维护角色')
  const me = await req(AGENT, '/api/auth/me', { token: lt })
  check(me.status === 200 && !('token' in (me.json ?? {})) , '/api/auth/me 不回令牌')

  console.log('\n4. 经子站：反代与单点登录')
  const redirect = await req(EXT, `/eg/${code}`)
  check(redirect.status === 301 && redirect.location === `/eg/${code}/`, '/eg/<柜号> 补斜杠跳转')
  const page = await req(EXT, `/eg/${code}/`, { accept: 'text/html' })
  check(page.status === 200 && page.text.includes('LSA-9600EG'), '/eg/<柜号>/ 反代出 EG 管理页')
  const none = await req(EXT, '/eg/ZZ99/', { accept: 'text/html' })
  check(none.status === 404, '本站没有的柜 404（反代不当跳板）')
  const admin = await viaSp('admin', code)
  check(admin.ticketStatus === 200 && admin.role === 'maint', '子站管理员拿到维护票据', String(admin.url ?? admin.message).slice(0, 40) + '…')
  check(admin.sso?.status === 200 && admin.sso.json?.['via'] === 'sp' && admin.sso.json?.['role'] === 'maint', '经反代用票据换到 EG 会话（不用再登录）')
  const replay = await req(EXT, `/eg/${code}/api/auth/sso`, { method: 'POST', body: { ticket: admin.ticket } })
  check(replay.status === 401, '同一张票据不能用第二次', String(replay.json?.['message']))
  const meSp = await req(EXT, `/eg/${code}/api/auth/me`, { token: admin.token })
  check(meSp.json?.['user'] === 'admin', 'EG 上的会话是子站用户本人', `${meSp.json?.['name']}`)
  const duty = await viaSp('duty', code)
  check(duty.ticketStatus === 200 && duty.role === 'view' && duty.sso?.status === 200, '值班员（无网关维护权限）→ 只看')
  const guest = await viaSp('guest', code)
  check(guest.ticketStatus === 403, '访客（看不到边缘网关）拿不到票据', guest.message)
  const noAuth = await req(EXT, `/ext/eg/${code}/ticket`, { method: 'POST', body: {} })
  check(noAuth.status === 401, '没登录子站拿不到票据')
  // 反代把请求体原样送到了 EG（第 3 步的登录走的是直连，这里经反代再登一次）
  const viaProxyLogin = await req(EXT, `/eg/${code}/api/auth/login`, { method: 'POST', body: { user: 'maint', password: pw } })
  check(viaProxyLogin.status === 200, '经反代的 POST 请求体原样到达 EG')

  console.log('\n5. 权限')
  const dt = duty.token!
  check((await req(AGENT, '/api/status', { token: dt })).status === 200, '只看角色能看状态')
  check((await req(AGENT, '/api/components/gateway/restart', { method: 'POST', token: dt })).status === 403, '只看角色不能重启组件')
  check((await req(AGENT, '/api/logs/gateway', { token: dt })).status === 403, '只看角色不能看日志')
  check((await req(AGENT, '/api/config/local', { method: 'PUT', token: dt, body: { ntpServer: 'x' } })).status === 403, '只看角色不能改配置')
  check((await req(AGENT, '/api/components/mosquitto/restart', { method: 'POST', token: lt })).status === 400, 'Mosquitto 不给在页面上重启')

  console.log('\n6. 组件、诊断、日志、配置')
  const comps = (await req(AGENT, '/api/components', { token: lt })).json as unknown as { key: string; state: string; memMb: number | null }[]
  for (const k of ['tb', 'gateway', 'mosquitto']) {
    const c = comps.find(x => x.key === k)
    check(c?.state === 'running' && (c.memMb ?? 0) > 0, `组件 ${k} 运行中、有内存数`, c ? `${c.memMb} MB` : '没有')
  }
  const diag = (await req(AGENT, '/api/diag', { token: lt })).json as { uplink: { state: string; text: string } }
  // I1：本地 TB 模式、上送在 I2 接上 —— 状态如实给「未接上」；I2 起应为「正常」
  check(['ok', 'none'].includes(diag.uplink.state), '诊断给出上送状态', `${diag.uplink.state}：${diag.uplink.text}`)
  const logs = (await req(AGENT, '/api/logs/gateway?tail=50', { token: lt })).json as { lines: string[] }
  check(logs.lines.length > 0, '取到 IoT Gateway 日志', `${logs.lines.length} 行`)
  const agentLogs = (await req(AGENT, '/api/logs/agent?tail=50', { token: lt })).json as { lines: string[] }
  check(agentLogs.lines.some(l => l.includes('已启动')), '取到 eg-agent 自己的日志')
  const conf = await req(AGENT, '/api/config', { token: lt })
  const secrets = [cfg.eg.token, cfg.station.token, cfg.tb?.password].filter((x): x is string => !!x)
  const stText = (await req(AGENT, '/api/status', { token: lt })).text
  // 按完整的 JSON 字符串值找（开发环境的本地 TB 口令 lsa9600eg 恰好是账号 admin@lsa9600eg.local 的一部分）
  const leak = (text: string) => secrets.some(t => text.includes(JSON.stringify(t)))
  check(conf.status === 200 && !leak(conf.text) && !leak(stText),'配置页、状态接口都不回令牌 / 口令原文（本地与子站令牌、本地 TB 口令）')
  const oldNtp = cfg.local.ntp.server
  const put = await req(AGENT, '/api/config/local', { method: 'PUT', token: lt, body: { ntpServer: 'ntp.g2-verify.invalid' } })
  const saved = readFileSync(resolve(cfg.dir, 'local.yaml'), 'utf8')
  check(put.status === 200 && saved.includes('ntp.g2-verify.invalid'), '改对时服务器写进 local.yaml')
  await req(AGENT, '/api/config/local', { method: 'PUT', token: lt, body: { ntpServer: oldNtp } })

  console.log('\n7. 改本地口令')
  const weak = await req(AGENT, '/api/auth/password', { method: 'POST', token: lt, body: { oldPassword: pw, newPassword: 'short' } })
  check(weak.status === 403, '弱口令拒绝', String(weak.json?.['message']))
  const tmpPw = 'G2verify' + Math.floor(Math.random() * 1e6)
  const ch = await req(AGENT, '/api/auth/password', { method: 'POST', token: lt, body: { oldPassword: pw, newPassword: tmpPw } })
  const withNew = await req(AGENT, '/api/auth/login', { method: 'POST', body: { user: 'maint', password: tmpPw } })
  check(ch.status === 200 && withNew.status === 200, '改口令后新口令能登录')
  const back = await req(AGENT, '/api/auth/password', { method: 'POST', token: String(withNew.json?.['token']), body: { oldPassword: tmpPw, newPassword: pw } })
  check(back.status === 200, '改回原口令')
  // 改口令会让其他本地会话作废（上面那个 lt 也在内）—— 这正是设计，重新登录接着测
  check((await req(AGENT, '/api/status', { token: lt })).status === 401, '改口令后其他本地会话作废')
  lt = String((await req(AGENT, '/api/auth/login', { method: 'POST', body: { user: 'maint', password: pw } })).json?.['token'] ?? '')

  if (!FAST) {
    console.log('\n8. 页面上的运维动作：重启 IoT Gateway')
    const before = docker('inspect', '-f', '{{.State.StartedAt}}', 'lsa-eg-gateway').trim()
    const rs = await req(AGENT, '/api/components/gateway/restart', { method: 'POST', token: lt })
    const after = docker('inspect', '-f', '{{.State.StartedAt}}', 'lsa-eg-gateway').trim()
    check(rs.status === 200 && before !== after, '经 API 重启了 IoT Gateway 容器')

    // 断上行时本地排队涨落：eg-agent 的 outbox，在 i2:verify 里测
  }

  console.log('\n10. 审计')
  const egAudit = (await req(AGENT, '/api/audit?limit=200', { token: lt })).json as unknown as { action: string; user: string; via: string; ok: boolean }[]
  check(egAudit.some(a => a.action === '子站单点登录' && a.user === 'admin' && a.via === 'sp' && a.ok), 'EG 审计：子站用户单点登录')
  check(egAudit.some(a => a.action === '子站单点登录' && !a.ok), 'EG 审计：重放票据被拒也记了')
  check(egAudit.some(a => a.action === '改本地配置'), 'EG 审计：改本地配置')
  check(egAudit.some(a => a.action === '改本地口令' && a.ok), 'EG 审计：改口令')
  if (!FAST) check(egAudit.some(a => a.action === '重启组件' && a.ok), 'EG 审计：重启组件')
  const spTok = await spLogin('admin')
  const spAudit = (await req(EXT, `/ext/audit?q=${encodeURIComponent(`EG-${code} 管理页`)}&pageSize=20`, { token: spTok })).json as { data: { text: string; user: string }[] }
  check(spAudit.data.some(a => a.text.includes(`打开 EG-${code} 管理页`) && a.user === 'duty'), '子站审计：谁在何时经子站打开了哪台 EG')

  await sleep(0)
  done()
}

main().catch(e => {
  console.error('自检出错：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
