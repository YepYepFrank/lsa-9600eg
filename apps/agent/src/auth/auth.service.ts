/* 本地访问控制（开发计划 §5）。两条路进 EG 管理页：
 *   交换机直连 http://<EG 上行 IP>/   —— EG 本地维护账号（只此一个，部署时设口令）
 *   经子站 /eg/<柜号>/               —— 子站签的短时票据（ticket.ts），按子站角色放权，不用再登录
 *
 * 角色只有两级：maint（维护：重启组件、改本地配置、看日志与审计）/ view（只看）。
 * 本地账号是 maint；子站用户有「网关维护」权限（管理员、运维工程师）给 maint，其余给 view。
 *
 * 安全策略与子站默认一致：口令 ≥ 8 位且含字母和数字；连错 5 次锁 15 分钟；会话 30 分钟无操作失效。
 * 口令只存 scrypt 散列（配置目录的 auth.json）。首次启动：有 EG_ADMIN_PASSWORD 用它，没有就随机生成并写到
 * initial-password.txt（部署后改掉口令、删掉这个文件）。会话在内存里，agent 重启要重新登录。 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { stationToken, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { verifyTicket, type TicketRole } from './ticket.js'

export const POLICY = { minLen: 8, lockAfter: 5, lockMin: 15, sessionMin: 30 } as const
export const LOCAL_USER = 'maint'

export interface Session {
  token: string
  user: string
  name: string
  role: TicketRole
  via: 'local' | 'sp'
  ip: string
  created: number
  lastSeen: number
}

interface AccountFile {
  user: string
  salt: string
  hash: string
  changedAt: number
  failed: number
  lockedUntil: number
}

export class AuthError extends Error {
  constructor(
    readonly code: 'bad_password' | 'locked' | 'bad_ticket' | 'weak_password',
    message: string,
  ) {
    super(message)
  }
}

@Injectable()
export class AuthService {
  private readonly log = new Logger('访问控制')
  private readonly file: string
  private account: AccountFile
  private readonly sessions = new Map<string, Session>()
  /** 用过的票据（防重放），留到过期 */
  private readonly usedTickets = new Map<string, number>()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly audit: AuditService,
  ) {
    this.file = resolve(cfg.dir, 'auth.json')
    this.account = this.loadOrInit()
  }

  login(user: string, password: string, ip: string): Session {
    const now = Date.now()
    const a = this.account
    if (a.lockedUntil > now) {
      const min = Math.ceil((a.lockedUntil - now) / 60_000)
      this.audit.write({ user, name: user, via: 'local', ip, action: '登录', target: 'EG', ok: false, detail: `账号锁定中（还剩 ${min} 分钟）` })
      throw new AuthError('locked', `连续口令错误，账号已锁定，${min} 分钟后再试`)
    }
    if (user !== a.user || !checkPassword(password, a.salt, a.hash)) {
      a.failed++
      let msg = `账号或口令不对（再错 ${POLICY.lockAfter - a.failed} 次锁定 ${POLICY.lockMin} 分钟）`
      if (a.failed >= POLICY.lockAfter) {
        a.lockedUntil = now + POLICY.lockMin * 60_000
        a.failed = 0
        msg = `连续 ${POLICY.lockAfter} 次口令错误，账号锁定 ${POLICY.lockMin} 分钟`
      }
      this.save()
      this.audit.write({ user, name: user, via: 'local', ip, action: '登录', target: 'EG', ok: false, detail: msg })
      throw new AuthError(a.lockedUntil > now ? 'locked' : 'bad_password', msg)
    }
    a.failed = 0
    this.save()
    const s = this.open({ user: a.user, name: '本地维护账号', role: 'maint', via: 'local', ip })
    this.audit.write({ user: s.user, name: s.name, via: 'local', ip, action: '登录', target: 'EG', ok: true })
    return s
  }

  sso(ticket: string, ip: string): Session {
    const now = Date.now()
    for (const [j, exp] of this.usedTickets) if (exp < now - 120_000) this.usedTickets.delete(j)
    // 票据由子站用它那边 EG 网关设备的令牌派生密钥签（I 阶段起本地 TB 的令牌可以不同，见 @lsa-eg/config stationToken）
    const c = verifyTicket(stationToken(this.cfg), ticket, this.cfg.cabinet.code, now)
    if ('error' in c) {
      this.audit.write({ user: '?', name: '?', via: 'sp', ip, action: '子站单点登录', target: 'EG', ok: false, detail: c.error })
      throw new AuthError('bad_ticket', c.error)
    }
    if (this.usedTickets.has(c.j)) {
      this.audit.write({ user: c.u, name: c.n, via: 'sp', ip, action: '子站单点登录', target: 'EG', ok: false, detail: '票据已用过' })
      throw new AuthError('bad_ticket', '票据已用过，请回子站重新打开')
    }
    this.usedTickets.set(c.j, c.exp)
    const s = this.open({ user: c.u, name: c.n, role: c.r, via: 'sp', ip })
    this.audit.write({ user: s.user, name: s.name, via: 'sp', ip, action: '子站单点登录', target: 'EG', ok: true, detail: `角色 ${c.r === 'maint' ? '维护' : '只看'}` })
    return s
  }

  /** 按令牌取会话；30 分钟无操作失效 */
  session(token: string | undefined): Session | null {
    if (!token) return null
    const s = this.sessions.get(token)
    if (!s) return null
    const now = Date.now()
    if (now - s.lastSeen > POLICY.sessionMin * 60_000) {
      this.sessions.delete(token)
      return null
    }
    s.lastSeen = now
    return s
  }

  logout(s: Session): void {
    this.sessions.delete(s.token)
    this.audit.write({ user: s.user, name: s.name, via: s.via, ip: s.ip, action: '退出', target: 'EG', ok: true })
  }

  changePassword(s: Session, oldPw: string, newPw: string): void {
    const a = this.account
    if (!checkPassword(oldPw, a.salt, a.hash)) {
      this.audit.write({ user: s.user, name: s.name, via: s.via, ip: s.ip, action: '改本地口令', target: a.user, ok: false, detail: '原口令不对' })
      throw new AuthError('bad_password', '原口令不对')
    }
    const weak = weakness(newPw)
    if (weak) throw new AuthError('weak_password', weak)
    const salt = randomBytes(16).toString('hex')
    this.account = { ...a, salt, hash: hashPassword(newPw, salt), changedAt: Date.now(), failed: 0, lockedUntil: 0 }
    this.save()
    // 改口令后其他本地会话作废
    for (const [t, x] of this.sessions) if (x.via === 'local' && t !== s.token) this.sessions.delete(t)
    this.audit.write({ user: s.user, name: s.name, via: s.via, ip: s.ip, action: '改本地口令', target: a.user, ok: true })
  }

  /** 本地账号概况（不含口令） */
  accountInfo() {
    const a = this.account
    return { user: a.user, changedAt: a.changedAt, lockedUntil: a.lockedUntil > Date.now() ? a.lockedUntil : 0, initialPasswordFile: existsSync(this.initialFile) }
  }

  private open(x: Pick<Session, 'user' | 'name' | 'role' | 'via' | 'ip'>): Session {
    const now = Date.now()
    const s: Session = { ...x, token: randomBytes(24).toString('base64url'), created: now, lastSeen: now }
    this.sessions.set(s.token, s)
    return s
  }

  private get initialFile(): string {
    return resolve(this.cfg.dir, 'initial-password.txt')
  }

  private loadOrInit(): AccountFile {
    if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, 'utf8')) as AccountFile
    const given = process.env['EG_ADMIN_PASSWORD']
    const pw = given || genPassword()
    const salt = randomBytes(16).toString('hex')
    const a: AccountFile = { user: LOCAL_USER, salt, hash: hashPassword(pw, salt), changedAt: Date.now(), failed: 0, lockedUntil: 0 }
    this.account = a
    this.save()
    if (!given) {
      writeFileSync(this.initialFile, `${pw}\n`, { encoding: 'utf8', mode: 0o600 })
      this.log.warn(`本地维护账号 ${LOCAL_USER} 的初始口令已写到 ${this.initialFile}，登录后请改掉并删除该文件`)
    }
    return a
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.account, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* Windows 上无效，忽略 */
    }
  }
}

function hashPassword(pw: string, salt: string): string {
  return scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')
}

function checkPassword(pw: string, salt: string, hash: string): boolean {
  const a = Buffer.from(hashPassword(pw, salt), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function weakness(pw: string): string | null {
  if (pw.length < POLICY.minLen) return `口令至少 ${POLICY.minLen} 位`
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '口令要同时含字母和数字'
  return null
}

/** 12 位，字母 + 数字，去掉易混的 0/O/1/l/I */
function genPassword(): string {
  const cs = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let s = ''
  const bytes = randomBytes(12)
  for (const b of bytes) s += cs[b % cs.length]
  return /\d/.test(s) && /[A-Za-z]/.test(s) ? s : genPassword()
}
