/* HTTP / RTSP 摘要认证（RFC 2617 / 7616 的 MD5 与 qop=auth）与基本认证。摄像机的 ONVIF 抓图地址、RTSP DESCRIBE 都用得上。 */
import { createHash, randomBytes } from 'node:crypto'

export interface Challenge {
  scheme: 'Digest' | 'Basic'
  realm: string
  nonce: string
  qop?: string
  opaque?: string
  algorithm?: string
}

/** 从 WWW-Authenticate 里挑一个：有 Digest 用 Digest，否则 Basic */
export function parseChallenge(headers: string | string[] | null | undefined): Challenge | null {
  const list = (Array.isArray(headers) ? headers : headers ? [headers] : []).flatMap(h => h.split(/,(?=\s*(?:Digest|Basic)\s)/i))
  const digest = list.find(h => /^\s*Digest\s/i.test(h))
  if (digest) {
    const kv: Record<string, string> = {}
    for (const m of digest.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) kv[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? ''
    return { scheme: 'Digest', realm: kv['realm'] ?? '', nonce: kv['nonce'] ?? '', qop: kv['qop'], opaque: kv['opaque'], algorithm: kv['algorithm'] }
  }
  if (list.some(h => /^\s*Basic\s/i.test(h))) return { scheme: 'Basic', realm: '', nonce: '' }
  return null
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

/** Authorization 头的值 */
export function authorization(ch: Challenge, method: string, uri: string, user: string, pass: string): string {
  if (ch.scheme === 'Basic') return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  const ha1 = md5(`${user}:${ch.realm}:${pass}`)
  const ha2 = md5(`${method}:${uri}`)
  const qop = ch.qop?.split(',').map(s => s.trim()).find(q => q === 'auth')
  const parts = [`username="${user}"`, `realm="${ch.realm}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`]
  if (qop) {
    const nc = '00000001'
    const cnonce = randomBytes(8).toString('hex')
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`, `response="${md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)}"`)
  } else parts.push(`response="${md5(`${ha1}:${ch.nonce}:${ha2}`)}"`)
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`)
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`)
  return 'Digest ' + parts.join(', ')
}

/** 带认证的 HTTP 请求：先不带，401 了按质询重发一次 */
export async function fetchAuth(url: string, init: RequestInit & { user?: string; pass?: string; timeoutMs?: number } = {}): Promise<Response> {
  const { user = '', pass = '', timeoutMs = 10_000, ...rest } = init
  const go = (auth?: string) =>
    fetch(url, { ...rest, headers: { ...(rest.headers as Record<string, string>), ...(auth ? { Authorization: auth } : {}) }, signal: AbortSignal.timeout(timeoutMs) })
  const r = await go()
  if (r.status !== 401 || !user) return r
  const ch = parseChallenge(r.headers.get('www-authenticate'))
  if (!ch) return r
  const u = new URL(url)
  return go(authorization(ch, (rest.method ?? 'GET').toUpperCase(), u.pathname + u.search, user, pass))
}
