/* 告警事件的本地库（I3，后端库 docs/EG独立TB调整方案.md §2.3、§8.2）：配置目录下的 events.db。
 *
 *   alarms     EG 本地 TB 上每条告警的最后已知状态 + 已分配的 revision（重启不丢，revision 才能单调）
 *   event_out  待送子站的事件：每个 eventId 只留最新一版（子站按 revision 取大的；恢复那一版带着发生时刻，
 *              断网期间发生又恢复 → 补传时只送一条 CLEARED，子站照样建出一条、时间正确）
 *
 * 事件不参与遥测 outbox 的容量丢弃（§2.2「事件不丢」）；已恢复且已送达的 30 天后从 alarms 里清掉。 */
import Database from 'better-sqlite3'

export type EventState = 'ACTIVE' | 'CLEARED'

/** 送子站的一条事件（§8.2） */
export interface EgEvent {
  eventId: string
  revision: number
  device: string
  type: string
  severity: string
  state: EventState
  occurredAt: number
  clearedAt: number | null
  details: Record<string, unknown>
}

export type Observed = Omit<EgEvent, 'revision'>

export interface OutEvent {
  eventId: string
  revision: number
  body: string
  queuedAt: number
  tries: number
}

const KEEP_CLEARED_MS = 30 * 86_400_000

export class EventsStore {
  private readonly db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      create table if not exists alarms (
        event_id    text primary key,
        device      text not null,
        type        text not null,
        severity    text not null,
        state       text not null,
        occurred_at integer not null,
        cleared_at  integer,
        details     text not null,
        revision    integer not null,
        updated_at  integer not null
      );
      create table if not exists event_out (
        event_id   text primary key,
        revision   integer not null,
        body       text not null,
        queued_at  integer not null,
        tries      integer not null default 0,
        next_at    integer not null,
        last_error text
      );
      create table if not exists meta (k text primary key, v text);
    `)
  }

  /** 看到本地 TB 上一条告警的当前状态。状态、级别、恢复时刻变了才算新一版（revision + 1）并排进待送；
   *  只是明细里的测量值变了（设备配置节点在告警持续期间每来一条遥测都会重写明细）只更新本地记录，不发事件。
   *  返回新排进去的那一版；没变返回 null。 */
  observe(o: Observed, now = Date.now()): EgEvent | null {
    const tx = this.db.transaction((): EgEvent | null => {
      const old = this.db.prepare('select state, severity, cleared_at c, revision from alarms where event_id = ?').get(o.eventId) as
        | { state: EventState; severity: string; c: number | null; revision: number }
        | undefined
      const details = JSON.stringify(o.details)
      // TB 的告警恢复后不会再变回活动（同类再犯是一条新告警），迟到的旧状态不能把它改回去
      if (old?.state === 'CLEARED' && o.state === 'ACTIVE') return null
      if (old && old.state === o.state && old.severity === o.severity && (old.c ?? null) === (o.clearedAt ?? null)) {
        this.db.prepare('update alarms set details = ?, updated_at = ? where event_id = ?').run(details, now, o.eventId)
        return null
      }
      const ev: EgEvent = { ...o, revision: (old?.revision ?? 0) + 1 }
      this.db
        .prepare(
          `insert into alarms(event_id, device, type, severity, state, occurred_at, cleared_at, details, revision, updated_at)
           values (@eventId, @device, @type, @severity, @state, @occurredAt, @clearedAt, @details, @revision, @now)
           on conflict(event_id) do update set severity = excluded.severity, state = excluded.state, cleared_at = excluded.cleared_at,
             details = excluded.details, revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run({ ...ev, details, now })
      this.db
        .prepare(
          `insert into event_out(event_id, revision, body, queued_at, tries, next_at, last_error) values (?, ?, ?, ?, 0, ?, null)
           on conflict(event_id) do update set revision = excluded.revision, body = excluded.body, tries = 0, next_at = excluded.next_at, last_error = null`,
        )
        .run(ev.eventId, ev.revision, JSON.stringify(ev), now, now)
      return ev
    })
    return tx()
  }

  /** 该发的（到了重试时刻的），按排队先后 */
  due(limit: number, now = Date.now()): OutEvent[] {
    return this.db
      .prepare('select event_id eventId, revision, body, queued_at queuedAt, tries from event_out where next_at <= ? order by queued_at limit ?')
      .all(now, limit) as OutEvent[]
  }

  /** 子站收下了（accepted / duplicate）或明确不要（rejected 且不可重试）：删掉这一版；期间又排进了更新的一版就留着 */
  settle(eventId: string, revision: number): void {
    this.db.prepare('delete from event_out where event_id = ? and revision <= ?').run(eventId, revision)
  }

  retry(eventId: string, revision: number, error: string, delayMs: number, now = Date.now()): void {
    this.db
      .prepare('update event_out set tries = tries + 1, next_at = ?, last_error = ? where event_id = ? and revision = ?')
      .run(now + delayMs, error.slice(0, 500), eventId, revision)
  }

  /** 本地记录里还是活动的（对账时逐条去本地 TB 核对） */
  active(): { eventId: string; device: string }[] {
    return this.db.prepare("select event_id eventId, device from alarms where state = 'ACTIVE'").all() as { eventId: string; device: string }[]
  }

  known(eventId: string): { state: EventState; severity: string; revision: number } | null {
    return (this.db.prepare('select state, severity, revision from alarms where event_id = ?').get(eventId) as never) ?? null
  }

  get(eventId: string): EgEvent | null {
    const r = this.db
      .prepare(
        `select event_id eventId, revision, device, type, severity, state, occurred_at occurredAt, cleared_at clearedAt, details
         from alarms where event_id = ?`,
      )
      .get(eventId) as (Omit<EgEvent, 'details'> & { details: string }) | undefined
    return r ? { ...r, details: JSON.parse(r.details) as Record<string, unknown> } : null
  }

  stats(): { pending: number; oldestQueuedAt: number | null; lastError: string | null; alarms: number; active: number } {
    const o = this.db.prepare('select count(*) n, min(queued_at) t from event_out').get() as { n: number; t: number | null }
    const e = this.db.prepare('select last_error e from event_out where last_error is not null order by next_at desc limit 1').get() as { e: string } | undefined
    const a = this.db.prepare("select count(*) n, sum(state = 'ACTIVE') act from alarms").get() as { n: number; act: number | null }
    return { pending: o.n, oldestQueuedAt: o.t, lastError: e?.e ?? null, alarms: a.n, active: a.act ?? 0 }
  }

  /** 最近的告警（本地页用），新的在前 */
  recent(limit = 50): (EgEvent & { pending: boolean })[] {
    const rows = this.db
      .prepare(
        `select a.event_id eventId, a.revision, a.device, a.type, a.severity, a.state, a.occurred_at occurredAt, a.cleared_at clearedAt, a.details,
                (o.event_id is not null) pending
         from alarms a left join event_out o on o.event_id = a.event_id order by a.occurred_at desc limit ?`,
      )
      .all(limit) as (Omit<EgEvent, 'details'> & { details: string; pending: number })[]
    return rows.map(r => ({ ...r, details: JSON.parse(r.details) as Record<string, unknown>, pending: !!r.pending }))
  }

  prune(now = Date.now()): void {
    this.db
      .prepare("delete from alarms where state = 'CLEARED' and updated_at < ? and event_id not in (select event_id from event_out)")
      .run(now - KEEP_CLEARED_MS)
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
