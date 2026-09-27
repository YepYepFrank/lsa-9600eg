/* 循环录像（G5，docs/G5证据约定.md §1、§6）：mediamtx 常录两路子码流，这里只读和裁：
 *   覆盖：mediamtx API /v3/recordings/get/<路径>（各段起点）；
 *   裁片段：mediamtx 回放服务 /list（窗口里的段与时长）+ /get（按关键帧裁成 MP4，实际起止可能外扩）；
 *   水位：数据盘超 highWater 时经 API 提前删最旧的段（锁定的证据是 agent 另存的文件，不受影响）。 */
import { statfsSync } from 'node:fs'
import { Logger } from '@nestjs/common'
import type { EgConfig } from '@lsa-eg/config'
import { pathOf, RECORDED } from './mtx.js'

export interface Segment {
  start: number
  duration: number
}

export interface RingState {
  channel: 'visible' | 'ir'
  path: string
  segments: number
  oldest: number | null
  newest: number | null
  /** 最新一段开始于 2.5 分钟内（每段 60 s）= 在录 */
  recording: boolean
}

export class MissingError extends Error {
  constructor(
    readonly reason: 'stream_down' | 'gap' | 'no_data',
    message: string,
  ) {
    super(message)
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

export class Recording {
  private readonly log = new Logger('录像')

  constructor(private readonly cfg: () => EgConfig) {}

  private get api() {
    return this.cfg().conn.mtxApi
  }
  private get playback() {
    return this.cfg().local.video.playback.replace(/\/$/, '')
  }

  async ring(): Promise<RingState[]> {
    const cab = this.cfg().cabinet.code
    const out: RingState[] = []
    for (const [channel, key] of Object.entries(RECORDED) as ['visible' | 'ir', never][]) {
      const path = pathOf(cab, key)
      let starts: number[] = []
      try {
        const r = await fetch(`${this.api}/v3/recordings/get/${path}`, { signal: AbortSignal.timeout(3000) })
        if (r.ok) starts = ((await r.json()) as { segments: { start: string }[] }).segments.map(s => Date.parse(s.start)).sort((a, b) => a - b)
      } catch {
        /* API 不通按没有 */
      }
      const newest = starts.length ? starts[starts.length - 1]! : null
      out.push({ channel, path, segments: starts.length, oldest: starts[0] ?? null, newest, recording: newest !== null && Date.now() - newest < 150_000 })
    }
    return out
  }

  /** 窗口里有哪些段（回放服务 /list） */
  async segments(channel: 'visible' | 'ir', start: number, end: number): Promise<Segment[]> {
    const path = pathOf(this.cfg().cabinet.code, RECORDED[channel])
    const r = await fetch(`${this.playback}/list?path=${encodeURIComponent(path)}&start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (r.status === 404) return []
    if (!r.ok) throw new Error(`回放服务 /list ${r.status}：${(await r.text()).slice(0, 120)}`)
    return ((await r.json()) as { start: string; duration: number }[]).map(s => ({ start: Date.parse(s.start), duration: s.duration * 1000 }))
  }

  /** 裁一段 MP4：实际起止取录像覆盖与请求的交集；中间有断档标 gap */
  async clip(channel: 'visible' | 'ir', start: number, end: number): Promise<{ mp4: Buffer; actualStart: number; actualEnd: number; gap: boolean }> {
    const segs = (await this.segments(channel, start, end)).filter(s => s.start + s.duration > start && s.start < end).sort((a, b) => a.start - b.start)
    if (!segs.length) throw new MissingError('stream_down', `${channel === 'ir' ? '热像' : '可见光'}子码流在 ${iso(start)}–${iso(end)} 没有录像`)
    // 段起点是微秒级（如 …25.316273），毫秒时间戳截到 .316 反而落在段前一点，/get 会说「没有段」：贴着段起点时往后挪 1 ms
    const actualStart = start > segs[0]!.start ? start : segs[0]!.start + 1
    const last = segs[segs.length - 1]!
    const actualEnd = Math.min(end, last.start + last.duration)
    let gap = actualStart - start > 2000 || end - actualEnd > 2000
    for (let i = 1; i < segs.length; i++) if (segs[i]!.start - (segs[i - 1]!.start + segs[i - 1]!.duration) > 2000) gap = true
    const path = pathOf(this.cfg().cabinet.code, RECORDED[channel])
    const dur = Math.max(1, (actualEnd - actualStart) / 1000)
    const r = await fetch(`${this.playback}/get?path=${encodeURIComponent(path)}&start=${encodeURIComponent(iso(actualStart))}&duration=${dur}&format=mp4`, {
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error(`回放服务 /get ${r.status}：${(await r.text()).slice(0, 120)}`)
    return { mp4: Buffer.from(await r.arrayBuffer()), actualStart, actualEnd, gap }
  }

  /** 数据盘超 highWater：删最旧的循环段（每次每路最多 10 段），直到降下来或只剩最近 1 小时 */
  async trimForDisk(): Promise<number> {
    const cfg = this.cfg()
    const used = diskUsedPct(cfg.dir)
    if (used === null || used < cfg.local.evidence.highWater) return 0
    let n = 0
    for (const r of await this.ring()) {
      const res = await fetch(`${this.api}/v3/recordings/get/${r.path}`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
      if (!res?.ok) continue
      const starts = ((await res.json()) as { segments: { start: string }[] }).segments.map(s => s.start).sort()
      for (const st of starts.slice(0, 10)) {
        if (Date.now() - Date.parse(st) < 3_600_000) break
        const d = await fetch(`${this.api}/v3/recordings/deletesegment?path=${encodeURIComponent(r.path)}&start=${encodeURIComponent(st)}`, { method: 'DELETE' }).catch(() => null)
        if (d?.ok) n++
      }
    }
    if (n) this.log.warn(`数据盘 ${used} % 超过 ${cfg.local.evidence.highWater} %，提前删了 ${n} 段最旧的循环录像`)
    return n
  }
}

export function diskUsedPct(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Math.round((1 - s.bavail / s.blocks) * 1000) / 10
  } catch {
    return null
  }
}
