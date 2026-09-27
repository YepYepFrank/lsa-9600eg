/* 管理页只对 LAN2 开（I5-2）：agent 用宿主机网络听 0.0.0.0，从 local.yaml http.denyOn 列的网口（LAN1 摄像机网）进来的请求一律 403。
 * 不按地址 bind：开机时网口地址可能还没配上，bind 会失败；这里每次按网口现有地址判，30 s 刷一次。 */
import { networkInterfaces } from 'node:os'
import type { NextFunction, Request, Response } from 'express'

const REFRESH_MS = 30_000

/** 本机某些网口上的地址（IPv4 与 IPv6，IPv4 另存 ::ffff: 映射形式） */
function addrsOf(ifaces: string[]): Set<string> {
  const all = networkInterfaces()
  const out = new Set<string>()
  for (const name of ifaces)
    for (const a of all[name] ?? []) {
      out.add(a.address)
      if (a.family === 'IPv4') out.add(`::ffff:${a.address}`)
    }
  return out
}

export function denyOnIfaces(ifaces: string[]): ((req: Request, res: Response, next: NextFunction) => void) | null {
  if (!ifaces.length) return null
  let denied = addrsOf(ifaces)
  let at = Date.now()
  return (req, res, next) => {
    if (Date.now() - at > REFRESH_MS) {
      denied = addrsOf(ifaces)
      at = Date.now()
    }
    const local = req.socket.localAddress
    if (local && denied.has(local)) {
      res.status(403).type('text/plain; charset=utf-8').send('本地管理页只在 LAN2 上开放')
      return
    }
    next()
  }
}
