/* 自检共用：计数、子站 TB 的只读查询、控制面调用、docker。 */
import { execFileSync } from 'node:child_process'

export const env = (k: string, d: string) => process.env[k] ?? d
export const TB = env('TB_URL', 'http://localhost:8080')
export const AGENT = env('EG_AGENT_URL', 'http://127.0.0.1:9100')
export const BUS = env('EG_BUS_MQTT', 'mqtt://127.0.0.1:11883')
export const SIM = env('SIM_URL', 'http://localhost:3100')
export const EMU = env('EMU_URL', 'http://127.0.0.1:3190')

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
export function check(ok: boolean, name: string, detail = ''): boolean {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
  return ok
}
export function done(): never {
  console.log(`\n${pass} 项通过，${fail} 项失败`)
  process.exit(fail ? 1 : 0)
}

/** 等到 fn() 返回真值（每 step 毫秒试一次），超时返回 null */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, step = 2000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v as T
    if (Date.now() > end) return null
    await sleep(step)
  }
}

export interface Point {
  ts: number
  value: string
}

/** 子站 TB 的只读客户端（租户管理员） */
export class Tb {
  private h: Record<string, string> = {}
  private ids = new Map<string, string>()

  async login(): Promise<this> {
    const r = await fetch(`${TB}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: env('TB_TENANT_USER', 'admin@lsa9600sp.local'), password: env('TB_TENANT_PASSWORD', 'lsa9600sp') }),
    })
    const { token } = (await r.json()) as { token: string }
    this.h = { 'X-Authorization': `Bearer ${token}` }
    return this
  }

  get headers(): Record<string, string> {
    return this.h
  }

  async id(device: string): Promise<string> {
    let id = this.ids.get(device)
    if (!id) {
      const d = (await (await fetch(`${TB}/api/tenant/devices?deviceName=${encodeURIComponent(device)}`, { headers: this.h })).json()) as { id: { id: string } }
      this.ids.set(device, (id = d.id.id))
    }
    return id
  }

  async latest(device: string, keys: string[]): Promise<Record<string, Point | undefined>> {
    const r = (await (
      await fetch(`${TB}/api/plugins/telemetry/DEVICE/${await this.id(device)}/values/timeseries?keys=${keys.join(',')}`, { headers: this.h })
    ).json()) as Record<string, Point[]>
    return Object.fromEntries(keys.map(k => [k, r[k]?.[0]]))
  }

  async history(device: string, key: string, startTs: number, endTs: number): Promise<Point[]> {
    const r = (await (
      await fetch(
        `${TB}/api/plugins/telemetry/DEVICE/${await this.id(device)}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&limit=50000&orderBy=ASC`,
        { headers: this.h },
      )
    ).json()) as Record<string, Point[]>
    return r[key] ?? []
  }

  async attr(device: string, scope: 'CLIENT_SCOPE' | 'SERVER_SCOPE', key: string): Promise<unknown> {
    const r = (await (
      await fetch(`${TB}/api/plugins/telemetry/DEVICE/${await this.id(device)}/values/attributes/${scope}?keys=${key}`, { headers: this.h })
    ).json()) as { key: string; value: unknown }[]
    return r.find(a => a.key === key)?.value
  }
}

export async function post(url: string): Promise<unknown> {
  const r = await fetch(url, { method: 'POST' })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return (await r.json()) as T
}

export function docker(...args: string[]): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '')
  }
}

/** docker stats 里某容器的内存 MiB */
export function containerMemMb(name: string): number | null {
  const out = docker('stats', '--no-stream', '--format', '{{.MemUsage}}', name).trim()
  const m = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(out)
  if (!m) return null
  const v = Number(m[1])
  return m[2] === 'GiB' ? v * 1024 : m[2] === 'KiB' ? v / 1024 : v
}

/** 一段时间序列里相邻两点的最大间隔 ms */
export function maxGap(points: Point[]): number {
  let g = 0
  for (let i = 1; i < points.length; i++) g = Math.max(g, points[i]!.ts - points[i - 1]!.ts)
  return g
}
