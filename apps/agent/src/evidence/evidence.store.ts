/* 证据库（G5，docs/G5证据约定.md §4）：配置目录下的 evidence.db。
 *   evidence   每条证据的索引（§14.3 的字段）+ 本地文件与生产 / 上传进度
 *   index_out  待送子站的索引：每条证据只留最新一版（与告警事件同一做法，§8.2）
 * 状态变一次 revision + 1、排进 index_out。 */
import Database from 'better-sqlite3'

export type EvKind = 'video' | 'image' | 'wave'
export type EvChannel = 'visible' | 'ir' | 'data'
export type EvStatus = 'RECORDING' | 'READY' | 'UPLOADED' | 'EXPIRED' | 'MISSING' | 'DELETED'
export type EvLocation = 'edge' | 'station' | 'both' | 'none'

export interface Evidence {
  evidenceId: string
  revision: number
  eventId: string | null
  requestId: string | null
  /** 同一次触发（一次告警 / 一次锁定）的证据共用一个组号，双光配对用 */
  groupId: string
  cabinetId: string
  gatewayId: string
  channelId: EvChannel
  kind: EvKind
  requestedStart: number
  requestedEnd: number
  actualStart: number | null
  actualEnd: number | null
  status: EvStatus
  location: EvLocation
  sizeBytes: number | null
  codec: string | null
  sha256: string | null
  important: boolean
  pairOffsetMs: number | null
  createdAt: number
  expiresAt: number | null
  missingReason: string | null
}

/** 只在本地用的字段（不上送） */
export interface EvidenceRow extends Evidence {
  file: string | null
  dueAt: number | null
  uploadTries: number
  uploadNext: number
  uploadError: string | null
  uploadWanted: boolean
}

const COLS: [keyof EvidenceRow, string][] = [
  ['evidenceId', 'id'],
  ['revision', 'revision'],
  ['eventId', 'event_id'],
  ['requestId', 'request_id'],
  ['groupId', 'group_id'],
  ['cabinetId', 'cabinet_id'],
  ['gatewayId', 'gateway_id'],
  ['channelId', 'channel_id'],
  ['kind', 'kind'],
  ['requestedStart', 'req_start'],
  ['requestedEnd', 'req_end'],
  ['actualStart', 'act_start'],
  ['actualEnd', 'act_end'],
  ['status', 'status'],
  ['location', 'location'],
  ['sizeBytes', 'size'],
  ['codec', 'codec'],
  ['sha256', 'sha256'],
  ['important', 'important'],
  ['pairOffsetMs', 'pair_offset'],
  ['createdAt', 'created_at'],
  ['expiresAt', 'expires_at'],
  ['missingReason', 'missing_reason'],
  ['file', 'file'],
  ['dueAt', 'due_at'],
  ['uploadTries', 'upload_tries'],
  ['uploadNext', 'upload_next'],
  ['uploadError', 'upload_error'],
  ['uploadWanted', 'upload_wanted'],
]
const SELECT = COLS.map(([k, c]) => `${c} "${k}"`).join(', ')
const LOCAL_ONLY = new Set<keyof EvidenceRow>(['file', 'dueAt', 'uploadTries', 'uploadNext', 'uploadError', 'uploadWanted'])

function fromDb(r: Record<string, unknown>): EvidenceRow {
  return { ...(r as unknown as EvidenceRow), important: !!r['important'], uploadWanted: !!r['uploadWanted'] }
}

/** 索引里的时间字段（§8.7：整数毫秒）。裁片的实际起止来自回放服务 / ffprobe，会带小数（子站 bigint 入库失败过，G5 部署发现） */
export const TIME_FIELDS = ['requestedStart', 'requestedEnd', 'actualStart', 'actualEnd', 'createdAt', 'expiresAt'] as const
/** 时间字段一律取整（库里已有的带小数的旧记录发出前也过一遍，不迁移） */
export function roundTimes<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>
  for (const k of TIME_FIELDS) if (typeof out[k] === 'number') out[k] = Math.round(out[k] as number)
  return out as T
}

export function indexOf(r: EvidenceRow): Evidence {
  return roundTimes(Object.fromEntries(Object.entries(r).filter(([k]) => !LOCAL_ONLY.has(k as keyof EvidenceRow))) as unknown as Evidence)
}

export class EvidenceStore {
  private readonly db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      create table if not exists evidence (
        id text primary key, revision integer not null, event_id text, request_id text, group_id text not null,
        cabinet_id text not null, gateway_id text not null, channel_id text not null, kind text not null,
        req_start integer not null, req_end integer not null, act_start integer, act_end integer,
        status text not null, location text not null, size integer, codec text, sha256 text,
        important integer not null, pair_offset integer, created_at integer not null, expires_at integer, missing_reason text,
        file text, due_at integer, upload_tries integer not null default 0, upload_next integer not null default 0,
        upload_error text, upload_wanted integer not null default 0
      );
      create index if not exists evidence_event on evidence(event_id);
      create index if not exists evidence_group on evidence(group_id);
      create table if not exists index_out (
        id text primary key, revision integer not null, body text not null, queued_at integer not null,
        tries integer not null default 0, next_at integer not null, last_error text
      );
    `)
  }

  insert(r: EvidenceRow, now = Date.now()): void {
    const cols = COLS.map(([, c]) => c).join(', ')
    const vals = COLS.map(([k]) => `@${k}`).join(', ')
    this.db.prepare(`insert into evidence(${cols}) values (${vals})`).run({ ...r, important: r.important ? 1 : 0, uploadWanted: r.uploadWanted ? 1 : 0 })
    this.queue(r, now)
  }

  /** 改字段；改了上送的字段就 revision + 1 并排进 index_out */
  update(id: string, patch: Partial<EvidenceRow>, now = Date.now()): EvidenceRow | null {
    const cur = this.get(id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    const visible = COLS.some(([k]) => !LOCAL_ONLY.has(k) && k !== 'revision' && patch[k] !== undefined && patch[k] !== cur[k])
    if (visible) next.revision = cur.revision + 1
    const sets = COLS.filter(([k]) => k !== 'evidenceId').map(([k, c]) => `${c} = @${k}`).join(', ')
    this.db.prepare(`update evidence set ${sets} where id = @evidenceId`).run({ ...next, important: next.important ? 1 : 0, uploadWanted: next.uploadWanted ? 1 : 0 })
    if (visible) this.queue(next, now)
    return next
  }

  private queue(r: EvidenceRow, now: number): void {
    this.db
      .prepare(
        `insert into index_out(id, revision, body, queued_at, tries, next_at, last_error) values (?, ?, ?, ?, 0, ?, null)
         on conflict(id) do update set revision = excluded.revision, body = excluded.body, tries = 0, next_at = excluded.next_at, last_error = null`,
      )
      .run(r.evidenceId, r.revision, JSON.stringify(indexOf(r)), now, now)
  }

  get(id: string): EvidenceRow | null {
    const r = this.db.prepare(`select ${SELECT} from evidence where id = ?`).get(id) as Record<string, unknown> | undefined
    return r ? fromDb(r) : null
  }

  where(sql: string, ...args: unknown[]): EvidenceRow[] {
    return (this.db.prepare(`select ${SELECT} from evidence where ${sql}`).all(...args) as Record<string, unknown>[]).map(fromDb)
  }

  recent(limit = 200): EvidenceRow[] {
    return (this.db.prepare(`select ${SELECT} from evidence order by created_at desc limit ?`).all(limit) as Record<string, unknown>[]).map(fromDb)
  }

  /* ---------- 索引送子站 ---------- */
  dueIndex(limit: number, now = Date.now()): { id: string; revision: number; body: string; tries: number }[] {
    return this.db.prepare('select id, revision, body, tries from index_out where next_at <= ? order by queued_at limit ?').all(now, limit) as never
  }
  settleIndex(id: string, revision: number): void {
    this.db.prepare('delete from index_out where id = ? and revision <= ?').run(id, revision)
  }
  retryIndex(id: string, revision: number, error: string, delayMs: number, now = Date.now()): void {
    this.db.prepare('update index_out set tries = tries + 1, next_at = ?, last_error = ? where id = ? and revision = ?').run(now + delayMs, error.slice(0, 300), id, revision)
  }
  indexPending(): { n: number; lastError: string | null } {
    const r = this.db.prepare('select count(*) n from index_out').get() as { n: number }
    const e = this.db.prepare('select last_error e from index_out where last_error is not null order by next_at desc limit 1').get() as { e: string } | undefined
    return { n: r.n, lastError: e?.e ?? null }
  }

  close(): void {
    this.db.close()
  }
}
