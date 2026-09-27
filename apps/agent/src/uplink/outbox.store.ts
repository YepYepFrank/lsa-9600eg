/* 上送 outbox：本机 SQLite（配置目录下的 outbox.db），总线上看到的每条遥测 / 属性先落这里，子站确认收到（PUBACK）才删。
 * 后端库 docs/EG独立TB调整方案.md §2.2：至少一次 + 幂等（子站 TB 按 设备 + key + 源时间戳 覆盖写，重发无害）；
 * 容量有上限（默认 7 天或 2 GB 先到为准），超了丢最旧的遥测、记下丢失区间上报（eg.lost），事件不丢（I3 另一张表）。
 *
 * 行按 seq（写入顺序）取；seq 与源时间大体同序（补发的旧数据例外，无妨：子站按 ts 落位）。
 *
 * 丢失记账（eg.lost）：子站按「丢弃总数变大」建「缓存溢出」告警，所以这里的总数必须**累计、只增不减**（重启不清零）：
 *   - 丢失段存在库里（lost 表），重启照旧；
 *   - 新的一段与上一段源时间相接（间隔 ≤ 5 分钟）就并进去 —— 超限时每分钟都丢一批最旧的，不合并会一分钟一段；
 *   - 段数超过 LOST_SEGMENTS 就把最旧的几段折成一段（起止取两端、条数相加），数组长度有上限、条数总和不变。 */
import Database from 'better-sqlite3'

export type RowKind = 't' | 'a'

export interface OutRow {
  seq: number
  dev: string
  kind: RowKind
  ts: number
  body: string
}

export interface LostRange {
  from: number
  to: number
  n: number
}

/** eg.lost 最多报这么多段 */
export const LOST_SEGMENTS = 20
/** 与上一段源时间相隔不超过这么久就并成一段 */
const LOST_MERGE_MS = 5 * 60_000

export class OutboxStore {
  private readonly db: Database.Database
  private readonly ins: Database.Statement
  private depth = 0
  private bytes = 0

  constructor(file: string) {
    this.db = new Database(file)
    // WAL + NORMAL：断电最多丢最后一次提交前的几十毫秒，写入快；EG 用的是工业 SSD
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      create table if not exists outbox (
        seq   integer primary key autoincrement,
        dev   text not null,
        kind  text not null,
        ts    integer not null,
        body  text not null,
        bytes integer not null
      );
      create table if not exists lost (from_ts integer, to_ts integer, n integer, at integer);
      create table if not exists meta (k text primary key, v text);
    `)
    this.ins = this.db.prepare('insert into outbox(dev, kind, ts, body, bytes) values (?, ?, ?, ?, ?)')
    // 旧版本不合并丢失段，库里可能超过上限：开库时折一次
    this.db.transaction(() => this.foldLost())()
    const s = this.db.prepare('select count(*) n, coalesce(sum(bytes), 0) b from outbox').get() as { n: number; b: number }
    this.depth = s.n
    this.bytes = s.b
  }

  /** 一批写入（一个事务） */
  push(rows: { dev: string; kind: RowKind; ts: number; body: string }[]): void {
    if (!rows.length) return
    const tx = this.db.transaction((rs: typeof rows) => {
      for (const r of rs) {
        const b = Buffer.byteLength(r.body)
        this.ins.run(r.dev, r.kind, r.ts, r.body, b)
        this.depth++
        this.bytes += b
      }
    })
    tx(rows)
  }

  /** seq 在 (after, upTo] 之间、最早的 limit 条 */
  take(after: number, upTo: number, limit: number): OutRow[] {
    return this.db.prepare('select seq, dev, kind, ts, body from outbox where seq > ? and seq <= ? order by seq limit ?').all(after, upTo, limit) as OutRow[]
  }

  maxSeq(): number {
    return (this.db.prepare('select coalesce(max(seq), 0) m from outbox').get() as { m: number }).m
  }

  /** 子站确认收到的删掉 */
  ack(seqs: number[]): void {
    if (!seqs.length) return
    const tx = this.db.transaction((ss: number[]) => {
      const sel = this.db.prepare('select bytes from outbox where seq = ?')
      const del = this.db.prepare('delete from outbox where seq = ?')
      for (const s of ss) {
        const r = sel.get(s) as { bytes: number } | undefined
        if (!r) continue
        del.run(s)
        this.depth--
        this.bytes -= r.bytes
      }
    })
    tx(seqs)
  }

  stats(): { depth: number; bytes: number; oldestTs: number | null } {
    const o = this.db.prepare('select min(ts) t from (select ts from outbox order by seq limit 200)').get() as { t: number | null }
    return { depth: this.depth, bytes: this.bytes, oldestTs: this.depth ? o.t : null }
  }

  /** 按容量上限丢最旧的：超期的（源时间早于 minTs）与超出 maxBytes 的部分；返回丢失区间 */
  trim(minTs: number, maxBytes: number): LostRange | null {
    let n = 0
    let from = Infinity
    let to = -Infinity
    const dropOldest = (limit: number) => {
      const rows = this.db.prepare('select seq, ts, bytes from outbox order by seq limit ?').all(limit) as { seq: number; ts: number; bytes: number }[]
      return rows
    }
    const tx = this.db.transaction(() => {
      const del = this.db.prepare('delete from outbox where seq = ?')
      // 超期：一次看 5000 条，直到最旧的一条不再超期
      for (;;) {
        const rows = dropOldest(5000).filter(r => r.ts < minTs)
        if (!rows.length) break
        for (const r of rows) {
          del.run(r.seq)
          n++
          this.depth--
          this.bytes -= r.bytes
          from = Math.min(from, r.ts)
          to = Math.max(to, r.ts)
        }
      }
      // 超量：丢到上限的 90 %
      while (this.bytes > maxBytes * 0.9 && this.depth > 0) {
        for (const r of dropOldest(5000)) {
          if (this.bytes <= maxBytes * 0.9) break
          del.run(r.seq)
          n++
          this.depth--
          this.bytes -= r.bytes
          from = Math.min(from, r.ts)
          to = Math.max(to, r.ts)
        }
      }
    })
    tx()
    if (!n) return null
    const range = { from, to, n }
    this.recordLost(range)
    return range
  }

  /** 记一段丢失：与上一段相接就合并；段数超上限把最旧的折成一段（总条数不变） */
  recordLost(r: LostRange, now = Date.now()): void {
    const tx = this.db.transaction(() => {
      const last = this.db.prepare('select rowid id, from_ts f, to_ts t from lost order by at desc, rowid desc limit 1').get() as { id: number; f: number; t: number } | undefined
      if (last && r.from <= last.t + LOST_MERGE_MS && r.to >= last.f - LOST_MERGE_MS) {
        this.db.prepare('update lost set from_ts = min(from_ts, ?), to_ts = max(to_ts, ?), n = n + ?, at = ? where rowid = ?').run(r.from, r.to, r.n, now, last.id)
      } else {
        this.db.prepare('insert into lost(from_ts, to_ts, n, at) values (?, ?, ?, ?)').run(r.from, r.to, r.n, now)
      }
      this.foldLost()
      this.setMeta('lastLostAt', String(now))
    })
    tx()
  }

  /** 段数超上限：最旧的几段折成一段（起止取两端、条数相加） */
  private foldLost(): void {
    const count = (this.db.prepare('select count(*) c from lost').get() as { c: number }).c
    if (count <= LOST_SEGMENTS) return
    const old = this.db.prepare('select rowid id, from_ts f, to_ts t, n, at from lost order by at, rowid limit ?').all(count - LOST_SEGMENTS + 1) as { id: number; f: number; t: number; n: number; at: number }[]
    const del = this.db.prepare('delete from lost where rowid = ?')
    for (const o of old) del.run(o.id)
    this.db
      .prepare('insert into lost(from_ts, to_ts, n, at) values (?, ?, ?, ?)')
      .run(Math.min(...old.map(o => o.f)), Math.max(...old.map(o => o.t)), old.reduce((a, o) => a + o.n, 0), old[0]!.at)
  }

  /** 全部丢失段（上报 eg.lost；段数有上限，条数总和 = 累计丢弃数），按时间先后 */
  lost(): LostRange[] {
    return this.db.prepare('select from_ts "from", to_ts "to", n from lost order by at, rowid').all() as LostRange[]
  }

  /** 累计丢弃条数（只增不减） */
  lostTotal(): number {
    return (this.db.prepare('select coalesce(sum(n), 0) s from lost').get() as { s: number }).s
  }

  /** 最近一次丢弃的时刻（重启后 eg.outbox_full 的保持期接着算） */
  lastLostAt(): number {
    return Number(this.getMeta('lastLostAt')) || 0
  }

  getMeta(k: string): string | null {
    return (this.db.prepare('select v from meta where k = ?').get(k) as { v: string } | undefined)?.v ?? null
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('insert into meta(k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, v)
  }

  close(): void {
    this.db.close()
  }
}
