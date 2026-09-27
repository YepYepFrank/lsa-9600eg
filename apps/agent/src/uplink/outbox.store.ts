/* 上送 outbox：本机 SQLite（配置目录下的 outbox.db），总线上看到的每条遥测 / 属性先落这里，子站确认收到（PUBACK）才删。
 * 后端库 docs/EG独立TB调整方案.md §2.2：至少一次 + 幂等（子站 TB 按 设备 + key + 源时间戳 覆盖写，重发无害）；
 * 容量有上限（默认 7 天或 2 GB 先到为准），超了丢最旧的遥测、记下丢失区间上报（eg.lost），事件不丢（I3 另一张表）。
 *
 * 行按 seq（写入顺序）取；seq 与源时间大体同序（补发的旧数据例外，无妨：子站按 ts 落位）。 */
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
    this.db.prepare('insert into lost(from_ts, to_ts, n, at) values (?, ?, ?, ?)').run(from, to, n, Date.now())
    return range
  }

  /** 最近的丢失区间（上报 eg.lost） */
  lost(limit = 20): LostRange[] {
    return (this.db.prepare('select from_ts "from", to_ts "to", n from lost order by at desc limit ?').all(limit) as LostRange[]).reverse()
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
