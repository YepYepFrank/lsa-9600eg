/* 事件类的量去重（0.17）：同一设备、同一 ts 的 uv.pulse 只处理、只上送一次。
 *
 * 为什么会重：转换程序发布超时的那一条转入缓存，但原来那次 QoS1 发送在总线恢复后也送到了，补传时又发一遍 ——
 * 每次断线可能有 1 条同 ts 的重复（at-least-once，本来就是预期语义）。遥测按 ts 覆盖无害，但 uv.pulse 一条就是一次弧光事件，
 * 重一条就多记一次。agent 重启时 Mosquitto 持久会话重投没确认的 QoS1 消息，也会重。
 *
 * 做法：只看转换程序发的（不看 agent 自己发的）；见过的 (设备, ts) 记下来，再来同 ts 的 uv.pulse 就从这一行里去掉，
 * 行里别的量照常（同 ts 覆盖无害），去掉后这一行空了就整行不要。
 * 记录落盘（配置目录 pulse-seen.json），agent 重启后照样认；保留 outbox 保留期那么久、每台最多 MAX_PER_DEVICE 条
 * （弧光事件本来就少，重复只会在断线补传时出现，几天内一定到）。 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Entry } from './bus.service.js'

/** 事件类的量：一条就是一次事件，不能重 */
export const EVENT_KEYS = ['uv.pulse'] as const

const MAX_PER_DEVICE = 2000

export class EventDedup {
  /** 设备 → 见过的事件 ts → 第一次见到的时刻 */
  private readonly seen = new Map<string, Map<number, number>>()
  /** 去掉的重复条数（自启动起） */
  dropped = 0

  constructor(
    private readonly file: string | null,
    private readonly keepMs: number,
  ) {
    this.load()
  }

  /** 过滤一批遥测：返回去掉重复事件后的行（可能变少），dups 是本批去掉的 (key, ts) */
  filter(device: string, entries: Entry[], now = Date.now()): { entries: Entry[]; dups: { key: string; ts: number }[] } {
    const dups: { key: string; ts: number }[] = []
    let changed = false
    const out: Entry[] = []
    for (const e of entries) {
      const hit = EVENT_KEYS.filter(k => k in e.values)
      if (!hit.length) {
        out.push(e)
        continue
      }
      let m = this.seen.get(device)
      if (!m) this.seen.set(device, (m = new Map()))
      if (!m.has(e.ts)) {
        m.set(e.ts, now)
        changed = true
        out.push(e)
        continue
      }
      const values = { ...e.values }
      for (const k of hit) {
        delete values[k]
        dups.push({ key: k, ts: e.ts })
      }
      this.dropped += hit.length
      if (Object.keys(values).length) out.push({ ts: e.ts, values })
    }
    if (changed) {
      this.prune(now)
      this.save()
    }
    return { entries: out, dups }
  }

  /** 已记的事件条数（自检用） */
  size(device?: string): number {
    if (device) return this.seen.get(device)?.size ?? 0
    let n = 0
    for (const m of this.seen.values()) n += m.size
    return n
  }

  private prune(now: number): void {
    for (const [dev, m] of this.seen) {
      for (const [ts, at] of m) if (now - at > this.keepMs) m.delete(ts)
      // 超上限丢最早见到的
      if (m.size > MAX_PER_DEVICE) {
        const old = [...m.entries()].sort((a, b) => a[1] - b[1]).slice(0, m.size - MAX_PER_DEVICE)
        for (const [ts] of old) m.delete(ts)
      }
      if (!m.size) this.seen.delete(dev)
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, [number, number][]>
      for (const [dev, list] of Object.entries(raw)) this.seen.set(dev, new Map(list.filter(x => Array.isArray(x) && x.length === 2).map(([ts, at]) => [Number(ts), Number(at)])))
      this.prune(Date.now())
    } catch {
      // 文件坏了就从空开始：最坏是重启后第一次断线补传多算一次，不影响别的
    }
  }

  private save(): void {
    if (!this.file) return
    const body = Object.fromEntries([...this.seen].map(([dev, m]) => [dev, [...m]]))
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(body), 'utf8')
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // 写不了盘只影响重启后的去重，内存里照常
    }
  }
}
