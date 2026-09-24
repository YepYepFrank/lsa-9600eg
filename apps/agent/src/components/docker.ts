/* Docker Engine API 的最小客户端：查容器、取日志、重启。
 * base：unix:///var/run/docker.sock（EG 上）、npipe:////./pipe/docker_engine（Windows 开发机）、http://docker-proxy:2375 */
import { request, type RequestOptions } from 'node:http'

export interface DockerResponse {
  status: number
  body: Buffer
}

export function dockerCall(base: string, method: 'GET' | 'POST', path: string, timeoutMs = 8000): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const opt: RequestOptions = { method, path, timeout: timeoutMs, headers: { Host: 'docker' } }
    if (base.startsWith('unix://')) opt.socketPath = base.slice(7)
    else if (base.startsWith('npipe://')) opt.socketPath = base.slice(8).replace(/\//g, '\\')
    else {
      const u = new URL(base)
      opt.hostname = u.hostname
      opt.port = u.port || 80
    }
    const req = request(opt, res => {
      const chunks: Buffer[] = []
      res.on('data', d => chunks.push(Buffer.from(d)))
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path} 超时`)))
    req.on('error', reject)
    req.end()
  })
}

export async function dockerJson<T>(base: string, path: string): Promise<T> {
  const r = await dockerCall(base, 'GET', path)
  if (r.status >= 400) throw new Error(`Docker API ${path} → ${r.status}`)
  return JSON.parse(r.body.toString('utf8')) as T
}

/** 容器日志是多路复用流：每帧 8 字节头（第 0 字节 1=stdout 2=stderr，4–7 字节长度），没开 TTY 时如此 */
export function demuxLogs(buf: Buffer): string {
  if (buf.length < 8 || (buf[0] !== 1 && buf[0] !== 2) || buf[1] !== 0) return buf.toString('utf8')
  const out: Buffer[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4)
    out.push(buf.subarray(i + 8, i + 8 + len))
    i += 8 + len
  }
  return Buffer.concat(out).toString('utf8')
}
