/* 本地管理页看实时画面（eg-ui-v2）：/api/stream/<路径>/… 带会话鉴权反代到本机 mediamtx。
 *   POST   /api/stream/<路径>/whep            WebRTC 信令（WHEP，SDP offer → answer）→ mediamtx WebRTC（只听本机）
 *   PATCH / DELETE /api/stream/<路径>/whep/<会话>
 *   GET    /api/stream/<路径>/index.m3u8 等     HLS（WebRTC 连不通时的兜底）→ mediamtx HLS（只听本机）
 * 路径只认本柜四路：<柜号>、<柜号>-sub、<柜号>-ir、<柜号>-ir-sub。
 * 鉴权与其它 /api 一样：Authorization: Bearer <会话令牌>，没有就 401；LAN1 进来的在更前面已被 403（net/deny.ts）。
 * 不用 Nest 控制器：WHEP 的请求体是 application/sdp，要原样转发，不能让 body parser 吃掉。 */
import http from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import type { EgConfig } from '@lsa-eg/config'
import type { AuthService } from '../auth/auth.service.js'

const PASS_REQ = ['content-type', 'if-match', 'accept']
const PASS_RES = ['content-type', 'content-length', 'etag', 'link', 'cache-control', 'accept-patch', 'accept-post', 'location']

export function streamProxy(cfg: EgConfig, auth: AuthService) {
  const cab = cfg.cabinet.code
  const paths = new Set([cab, `${cab}-sub`, `${cab}-ir`, `${cab}-ir-sub`])
  const deny = (res: Response, status: number, code: string, message: string) => res.status(status).json({ code, message })

  return (req: Request, res: Response, _next: NextFunction) => {
    // 挂在 /api/stream 下：req.url 形如 /AH03/whep、/AH03/whep/<会话>、/AH03-ir/index.m3u8?…
    const m = /^\/([^/?]+)\/((whep)(?:\/([\w-]+))?|[\w.-]+\.(?:m3u8|mp4|m4s|ts))(\?.*)?$/.exec(req.url)
    if (!m || !paths.has(m[1]!)) return deny(res, 404, 'no_stream', '没有这一路')
    const h = req.headers.authorization
    if (!auth.session(h?.startsWith('Bearer ') ? h.slice(7) : undefined)) return deny(res, 401, 'no_session', '未登录或会话已过期')

    const whep = !!m[3]
    const allowed = whep ? (m[4] ? ['PATCH', 'DELETE'] : ['POST', 'OPTIONS']) : ['GET', 'HEAD']
    if (!allowed.includes(req.method)) return deny(res, 405, 'method', `${req.method} 不支持`)
    const base = whep ? cfg.conn.mtxWebrtc : cfg.conn.mtxHls
    const target = new URL(`/${m[1]}/${m[2]}${m[5] ?? ''}`, base)

    const headers: Record<string, string> = {}
    for (const k of PASS_REQ) {
      const v = req.headers[k]
      if (typeof v === 'string') headers[k] = v
    }
    const up = http.request(target, { method: req.method, headers, timeout: 15_000 }, r => {
      res.status(r.statusCode ?? 502)
      for (const k of PASS_RES) {
        const v = r.headers[k]
        if (v === undefined) continue
        // mediamtx 回的会话地址是 /<路径>/whep/<会话>：改成相对地址，经子站反代（/eg/<柜号>/）进来也对
        if (k === 'location' && typeof v === 'string') res.setHeader('Location', v.replace(/^.*\/whep\//, 'whep/'))
        else res.setHeader(k, v)
      }
      res.setHeader('Cache-Control', 'no-store')
      r.pipe(res)
    })
    up.on('timeout', () => up.destroy(new Error('mediamtx 15 s 没响应')))
    up.on('error', e => {
      if (!res.headersSent) deny(res, 502, 'mtx_unreachable', `本机 mediamtx 连不上：${e.message}`)
      else res.end()
    })
    req.pipe(up)
  }
}
