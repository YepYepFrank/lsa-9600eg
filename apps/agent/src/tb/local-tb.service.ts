/* EG 本地 TB 的 REST（I3 起）：读本地告警（钩子核对、30 s 对账）；I4 写设备配置也走这里。
 * 账号是 eg.yaml 的 tb 段（provision:eg 建的本地租户管理员）；没有就 available = false，调用方自己降级。 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

export class TbHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

@Injectable()
export class LocalTbService {
  private readonly log = new Logger('本地TB')
  private jwt: string | null = null
  private logging: Promise<string> | null = null

  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {}

  get available(): boolean {
    return !!this.cfg.tb?.user && !!this.cfg.tb?.password
  }

  get base(): string {
    return this.cfg.conn.tbHttp.replace(/\/$/, '')
  }

  async get<T>(path: string): Promise<T> {
    return this.req<T>('GET', path)
  }

  async req<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const jwt = await this.token()
    const r = await fetch(this.base + path, {
      method,
      headers: { 'X-Authorization': `Bearer ${jwt}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (r.status === 401 && !retried) {
      this.jwt = null
      return this.req<T>(method, path, body, true)
    }
    if (!r.ok) throw new TbHttpError(r.status, `本地 TB ${method} ${path}：${r.status} ${(await r.text()).slice(0, 200)}`)
    const text = await r.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private async token(): Promise<string> {
    if (this.jwt) return this.jwt
    if (!this.available) throw new Error('eg.yaml 里没有本地 TB 账号（tb.user / tb.password）')
    this.logging ??= (async () => {
      try {
        const r = await fetch(this.base + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.cfg.tb!.user, password: this.cfg.tb!.password }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!r.ok) throw new TbHttpError(r.status, `登录本地 TB 失败：${r.status}`)
        this.jwt = ((await r.json()) as { token: string }).token
        return this.jwt
      } catch (e) {
        this.log.warn((e as Error).message)
        throw e
      } finally {
        this.logging = null
      }
    })()
    return this.logging
  }
}
