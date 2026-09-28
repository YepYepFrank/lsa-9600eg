/* 把 outbox 里取出的一批行切成一次次的 MQTT 发布（后端方案 §8.1 修订，2026-09-27）：
 *   一次发布 ≤ 500 条且 JSON 载荷 ≤ 48 KB —— 子站 TB 的 MQTT 单条消息上限 64 KB（tb-node NETTY_MAX_PAYLOAD_SIZE 缺省），
 *   超了 TB 直接断开连接，重连后重发同一批又被断，补传永远补不完（后端规模测试发现）。子站不调大上限，EG 这边守住。
 * 单独一行就超 48 KB 的放进 oversized，由调用方记审计后丢弃，不卡住队列。 */
import type { OutRow } from './outbox.store.js'

export const MAX_PAYLOAD_BYTES = 48 * 1024
export const MAX_SAMPLES = 500

export interface Publish {
  topic: string
  payload: string
  seqs: number[]
}

/** 这一行发到哪个主题（§8.1：EG 自身 v1/devices/me/…，子设备 v1/gateway/…） */
export function topicOf(r: OutRow, self: string): string {
  if (r.kind === 't') return r.dev === self ? 'v1/devices/me/telemetry' : 'v1/gateway/telemetry'
  return r.dev === self ? 'v1/devices/me/attributes' : 'v1/gateway/attributes'
}

/** 属性去旧的键：设备 + 属性名 */
export const attrKey = (dev: string, key: string): string => `${dev}\u0000${key}`

/** 补传里的属性行去掉已经送过更新值的键（newer：键 → 送出的那条的 seq，直接发的记 Infinity）。
 *  上送是实时先走、补传后走，属性又不带时间戳、子站 TB 按到达顺序覆盖 —— 不去掉的话，
 *  连上前的旧值（如部署时的 cfg、上一次开机的 agentBootId）会在补传时盖掉刚发的新值（现场流程验收 EG2 发现）。
 *  整行的键都旧了就整行不发（dropped，调用方直接确认删掉）。 */
export function dropStaleAttrs(rows: OutRow[], newer: ReadonlyMap<string, number>): { rows: OutRow[]; dropped: number[] } {
  const out: OutRow[] = []
  const dropped: number[] = []
  for (const r of rows) {
    if (r.kind !== 'a') {
      out.push(r)
      continue
    }
    const attrs = JSON.parse(r.body) as Record<string, unknown>
    const keep = Object.entries(attrs).filter(([k]) => !((newer.get(attrKey(r.dev, k)) ?? -1) > r.seq))
    if (keep.length === Object.keys(attrs).length) out.push(r)
    else if (keep.length) out.push({ ...r, body: JSON.stringify(Object.fromEntries(keep)) })
    else dropped.push(r.seq)
  }
  return { rows: out, dropped }
}

/** 同一主题的一组行 → 载荷 */
export function payloadOf(topic: string, rows: OutRow[]): string {
  if (topic === 'v1/devices/me/telemetry') return JSON.stringify(rows.map(r => ({ ts: r.ts, values: JSON.parse(r.body) as unknown })))
  if (topic === 'v1/devices/me/attributes') return JSON.stringify(Object.assign({}, ...rows.map(r => JSON.parse(r.body) as object)))
  if (topic === 'v1/gateway/telemetry') {
    const p: Record<string, unknown[]> = {}
    for (const r of rows) (p[r.dev] ??= []).push({ ts: r.ts, values: JSON.parse(r.body) as unknown })
    return JSON.stringify(p)
  }
  const p: Record<string, Record<string, unknown>> = {}
  for (const r of rows) Object.assign((p[r.dev] ??= {}), JSON.parse(r.body) as object)
  return JSON.stringify(p)
}

/** 切批：先按估算的大小分组（一行 ≈ 载荷 + 设备名 + 时间戳与括号），再按实际载荷核对，超了对半再分 */
export function chunkRows(rows: OutRow[], self: string, maxBytes = MAX_PAYLOAD_BYTES, maxSamples = MAX_SAMPLES): { publishes: Publish[]; oversized: OutRow[] } {
  const publishes: Publish[] = []
  const oversized: OutRow[] = []
  const byTopic = new Map<string, OutRow[]>()
  for (const r of rows) {
    const t = topicOf(r, self)
    const list = byTopic.get(t)
    if (list) list.push(r)
    else byTopic.set(t, [r])
  }
  const emit = (topic: string, group: OutRow[]): void => {
    if (!group.length) return
    const payload = payloadOf(topic, group)
    if (Buffer.byteLength(payload) <= maxBytes) {
      publishes.push({ topic, payload, seqs: group.map(r => r.seq) })
      return
    }
    if (group.length === 1) {
      oversized.push(group[0]!)
      return
    }
    const mid = group.length >> 1
    emit(topic, group.slice(0, mid))
    emit(topic, group.slice(mid))
  }
  for (const [topic, list] of byTopic) {
    let group: OutRow[] = []
    let est = 2
    for (const r of list) {
      const size = Buffer.byteLength(r.body) + Buffer.byteLength(r.dev) + 32
      if (group.length && (est + size > maxBytes || group.length >= maxSamples)) {
        emit(topic, group)
        group = []
        est = 2
      }
      group.push(r)
      est += size
    }
    emit(topic, group)
  }
  return { publishes, oversized }
}
