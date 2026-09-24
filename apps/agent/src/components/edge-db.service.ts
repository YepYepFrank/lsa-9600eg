/* 读 Edge 本地库（只读）：本地排队条数、最近一次上送进度、Edge 版本。
 *
 * TB Edge 4.2 把要送上子站的东西排在两张表里：遥测 ts_kv_cloud_event、其余（告警、属性、实体）cloud_event，
 * 每条有递增的 seq_id；已送到哪儿记在属性 queueTsKvSeqIdOffset / queueSeqIdOffset（G2 实测 Edge 本地库）。
 *   排队条数 = max(seq_id) − 已送偏移
 * 子站看不到这个数（排着的数据送不上去），只有 EG 本机能看 —— 断网时现场要知道积压了多少。
 *
 * 「是不是还在往上送」不能看偏移属性的更新时刻（Edge 攒一批才写一次，G2 实测断网后它还显示刚更新过）：
 * 这里每 5 s 读一次，自己记偏移最后一次前进的时刻和前进速度。 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import pg from 'pg'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'

export interface EdgeQueue {
  /** 遥测排队条数 */
  tsKv: number
  /** 其余事件（告警、属性、实体变更）排队条数 */
  events: number
  /** 最近一次上送进度推进的时刻（两类取晚的） */
  lastProgressAt: number | null
  edgeVersion: string | null
  /** 本服务观察到偏移最后一次前进的时刻 */
  lastAdvanceAt: number | null
  /** 近一次观察到的上送速度（条/秒） */
  ratePerSec: number | null
}

const POLL_MS = 5_000

@Injectable()
export class EdgeDbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Edge 本地库')
  private pool: pg.Pool | null = null
  private warned = false
  private timer: NodeJS.Timeout | null = null
  private last: EdgeQueue | { error: string } = { error: '还没读过' }
  private prevOffset: { sum: number; at: number } | null = null
  private lastAdvanceAt: number | null = null
  private rate: number | null = null

  constructor(@Inject(EG_CONFIG) private readonly cfg: EgConfig) {}

  onModuleInit(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    void this.pool?.end()
  }

  /** 最近一次读到的（每 5 s 更新） */
  queue(): EdgeQueue | { error: string } {
    return this.last
  }

  private async poll(): Promise<void> {
    const q = await this.read()
    if (!('error' in q)) {
      const now = Date.now()
      const sum = q.offsets
      if (this.prevOffset && sum > this.prevOffset.sum) {
        this.lastAdvanceAt = now
        this.rate = Math.round(((sum - this.prevOffset.sum) / ((now - this.prevOffset.at) / 1000)) * 10) / 10
      } else if (this.prevOffset) this.rate = 0
      this.prevOffset = { sum, at: now }
      const { offsets: _o, ...rest } = q
      this.last = { ...rest, lastAdvanceAt: this.lastAdvanceAt, ratePerSec: this.rate }
    } else this.last = q
  }

  private async read(): Promise<(Omit<EdgeQueue, 'lastAdvanceAt' | 'ratePerSec'> & { offsets: number }) | { error: string }> {
    try {
      const p = this.db()
      const r = await p.query<{ key: string; v: string | null; at: string }>(
        `select k.key, coalesce(a.long_v::text, a.str_v) as v, a.last_update_ts::text as at
           from attribute_kv a join key_dictionary k on k.key_id = a.attribute_key
          where k.key in ('queueTsKvSeqIdOffset', 'queueSeqIdOffset', 'edgeVersion')`,
      )
      const best = (key: string) => r.rows.filter(x => x.key === key).sort((a, b) => Number(b.v) - Number(a.v))[0]
      const tsOff = best('queueTsKvSeqIdOffset')
      const evOff = best('queueSeqIdOffset')
      const [ts, ev] = await Promise.all([
        p.query<{ m: string | null }>('select max(seq_id)::text as m from ts_kv_cloud_event'),
        p.query<{ m: string | null }>('select max(seq_id)::text as m from cloud_event'),
      ])
      const depth = (max: string | null | undefined, off: string | null | undefined) => Math.max(0, Number(max ?? 0) - Number(off ?? 0))
      const ats = [tsOff?.at, evOff?.at].map(Number).filter(x => x > 0)
      this.warned = false
      return {
        tsKv: depth(ts.rows[0]?.m, tsOff?.v),
        events: depth(ev.rows[0]?.m, evOff?.v),
        lastProgressAt: ats.length ? Math.max(...ats) : null,
        edgeVersion: r.rows.find(x => x.key === 'edgeVersion')?.v ?? null,
        offsets: Number(tsOff?.v ?? 0) + Number(evOff?.v ?? 0),
      }
    } catch (e) {
      const msg = (e as Error).message
      if (!this.warned) this.log.warn(`读不了 Edge 本地库：${msg}`)
      this.warned = true
      return { error: msg }
    }
  }

  private db(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({ connectionString: this.cfg.local.edgeDb, max: 1, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3000 })
      // 空闲连接被服务端断开时会发 error；不接的话整个进程退出（子站 B6 踩过）
      this.pool.on('error', e => this.log.warn(`Edge 本地库连接断开：${e.message}`))
    }
    return this.pool
  }
}
