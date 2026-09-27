/* RTSP DESCRIBE 探测：只问一次流描述、不拉流（cam.online 的口径，接口约定 §4）。401 时按摄像机的质询（摘要 / 基本）重发一次。
 * 回 SDP 里的帧率（a=framerate）与视频编码，给 cam.fps 与本地页用。 */
import { connect } from 'node:net'
import { authorization, parseChallenge } from './digest.js'

export interface Probe {
  ok: boolean
  status?: number
  error?: string
  fps?: number
  codec?: string
  ms?: number
}

interface RtspReply {
  status: number
  headers: Record<string, string>
  body: string
}

function request(host: string, port: number, lines: string[], timeoutMs: number): Promise<RtspReply> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port, timeout: timeoutMs })
    let buf = ''
    const done = (e?: Error, r?: RtspReply) => {
      s.destroy()
      if (e) reject(e)
      else resolve(r!)
    }
    s.on('connect', () => s.write(lines.join('\r\n') + '\r\n\r\n'))
    s.on('timeout', () => done(new Error('超时')))
    s.on('error', e => done(e))
    s.on('data', d => {
      buf += d.toString('utf8')
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const [first, ...rest] = buf.slice(0, end).split('\r\n')
      const headers: Record<string, string> = {}
      for (const l of rest) {
        const i = l.indexOf(':')
        if (i > 0) {
          const k = l.slice(0, i).trim().toLowerCase()
          headers[k] = headers[k] ? `${headers[k]}, ${l.slice(i + 1).trim()}` : l.slice(i + 1).trim()
        }
      }
      const len = Number(headers['content-length'] ?? 0)
      const body = buf.slice(end + 4)
      if (Buffer.byteLength(body) < len) return
      done(undefined, { status: Number(/RTSP\/1\.0 (\d+)/.exec(first ?? '')?.[1] ?? 0), headers, body })
    })
  })
}

/** 对一路 RTSP 地址做 DESCRIBE。地址里的账号口令用于认证、不放进请求行；hostOverride 把「主机:端口」换掉（开发映射） */
export async function describe(uri: string, hostOverride = '', timeoutMs = 5000): Promise<Probe> {
  const t0 = Date.now()
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return { ok: false, error: '地址格式不对' }
  }
  const user = decodeURIComponent(u.username)
  const pass = decodeURIComponent(u.password)
  u.username = ''
  u.password = ''
  const clean = u.toString()
  const [host, port] = hostOverride ? [hostOverride.split(':')[0]!, Number(hostOverride.split(':')[1] ?? 554)] : [u.hostname, Number(u.port || 554)]
  const base = [`DESCRIBE ${clean} RTSP/1.0`, 'Accept: application/sdp', 'User-Agent: lsa-eg-video']
  try {
    let r = await request(host, port, [...base, 'CSeq: 1'], timeoutMs)
    if (r.status === 401 && user) {
      const ch = parseChallenge(r.headers['www-authenticate'])
      if (ch) r = await request(host, port, [...base, 'CSeq: 2', `Authorization: ${authorization(ch, 'DESCRIBE', clean, user, pass)}`], timeoutMs)
    }
    if (r.status !== 200) return { ok: false, status: r.status, error: r.status === 401 ? '认证失败' : r.status === 404 ? '路径不存在' : `RTSP ${r.status}`, ms: Date.now() - t0 }
    const fps = Number(/a=framerate:\s*([\d.]+)/.exec(r.body)?.[1] ?? NaN)
    const codec = /a=rtpmap:\d+\s+([\w-]+)\//.exec(r.body)?.[1]
    return { ok: true, status: 200, fps: Number.isFinite(fps) ? fps : undefined, codec, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: `连不上：${(e as Error).message}`, ms: Date.now() - t0 }
  }
}
