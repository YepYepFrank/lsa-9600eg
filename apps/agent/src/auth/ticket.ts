/* 子站单点登录票据（开发计划 §5）：维护人员在子站点「打开 EG 管理页」，子站扩展服务签一张短时票据，
 * 浏览器带着它打开 EG 页面，EG 验过后给本地会话 —— 不用再登录一次。
 *
 *   v1.<载荷 base64url>.<签名 base64url>
 *   载荷 { c 柜号, u 子站用户名, n 显示名, r 'maint' | 'view', iat, exp（毫秒）, j 随机串 }
 *   签名 HMAC-SHA256(key, "v1." + 载荷)，key = HMAC-SHA256(这台 EG 的访问令牌, "lsa-eg-sso")
 *
 * 用 EG 的访问令牌派生密钥：子站（从 TB 读设备凭据）和 EG（eg.yaml）本来就都有它，不用另发密钥；
 * 每台 EG 的密钥不同，一台 EG 泄露不影响别的柜。子站那边的签发实现在后端库 apps/ext/src/eg/ticket.ts，两边必须一致。 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type TicketRole = 'maint' | 'view'

export interface TicketClaims {
  c: string
  u: string
  n: string
  r: TicketRole
  iat: number
  exp: number
  j: string
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const keyOf = (egToken: string) => createHmac('sha256', egToken).update('lsa-eg-sso').digest()

export function signTicket(egToken: string, claims: TicketClaims): string {
  const payload = b64(JSON.stringify(claims))
  const sig = createHmac('sha256', keyOf(egToken)).update(`v1.${payload}`).digest()
  return `v1.${payload}.${b64(sig)}`
}

/** 验票：签名、柜号、时效（容两边时钟差 60 s）。返回载荷或出错原因 */
export function verifyTicket(egToken: string, ticket: string, cabinet: string, now = Date.now()): TicketClaims | { error: string } {
  const parts = ticket.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return { error: '票据格式不对' }
  const want = createHmac('sha256', keyOf(egToken)).update(`v1.${parts[1]}`).digest()
  const got = Buffer.from(parts[2]!, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { error: '票据签名不对（不是本柜子站签发的）' }
  let c: TicketClaims
  try {
    c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as TicketClaims
  } catch {
    return { error: '票据内容不对' }
  }
  if (c.c !== cabinet) return { error: `票据是给 ${c.c} 的，这台是 ${cabinet}` }
  const skew = 60_000
  if (now > c.exp + skew) return { error: '票据已过期，请回子站重新打开' }
  if (c.iat > now + skew) return { error: '票据时间在未来（两边时钟差太大？）' }
  if (c.r !== 'maint' && c.r !== 'view') return { error: '票据角色不对' }
  return c
}
