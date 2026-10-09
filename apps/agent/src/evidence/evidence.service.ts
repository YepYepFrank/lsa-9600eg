/* 证据（G5，docs/G5证据约定.md）：
 *   触发：本地告警事件第 1 版（ACTIVE，§8.2）/ 子站锁定请求（PUT /api/evidence/lock）
 *     → 一组证据：可见光 + 热像各一段视频（循环录像里裁，前 preS 后 postS）、告警瞬间各一张图、一份录波（前 wavePreS 后 wavePostS）
 *   生产：到了窗口末尾再做（RECORDING → READY / MISSING / EXPIRED）；双光按实际起点配对，记 pairOffsetMs
 *   上送：索引 POST /ext/eg/<柜号>/evidence（回执、只留最新一版，同告警事件）；重要的文件 PUT …/evidence/<id>/file（子站按 sha256 校验）
 *   保留：锁定的本地副本 lockedDays，已上传的再留 uploadedKeepDays；数据盘超 fullWater 报满（eg.evid_full）、新锁定标缺证
 *   要上传的（重要 / 子站要的）没等到子站确认归档（UPLOADED）前，到期也不删本地这唯一一份（V3 A12）；只占盘，盘满照常报 eg.evid_full
 *   盘满兜底（purge.ts）：超 purgeWater 按 已上传 → 不需上传 → 待上传 的顺序删本地副本，最后一类报 EG 告警「证据未上传即被清理」 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { stationToken, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { BusService } from '../bus/bus.service.js'
import { UplinkService } from '../uplink/uplink.service.js'
import { LocalTbService } from '../tb/local-tb.service.js'
import { VideoClient } from '../video/video.controller.js'
import { EvidenceStore, indexOf, roundTimes, type EvChannel, type EvidenceRow, type EvKind } from './evidence.store.js'
import { WaveBuffer } from './wave.buffer.js'
import { CANDIDATE_SQL, EXPIRED_SQL, purge, type PurgeResult, type PurgeStep } from './purge.js'

/** 盘满兜底删了待上传证据时报的 EG 告警（本地 TB 上 EG 自身设备，经告警事件送子站；降到 highWater 以下自动恢复） */
export const PURGE_ALARM = '证据未上传即被清理'

export interface LockRequest {
  requestId?: string
  eventId?: string | null
  start: number
  end: number
  kinds?: EvKind[]
  upload?: boolean
  reason?: string
}

export interface LockReceipt {
  requestId: string | null
  status: 'ACCEPTED' | 'EXPIRED' | 'PARTIAL'
  evidenceIds: string[]
  message?: string
}

const TICK_MS = 2000
const CLEAN_MS = 10 * 60_000
const DAY = 86_400_000
/** 片段窗口结束后再等这么久才裁（mediamtx 刚写完的段要落盘） */
const FLUSH_MS = 5000
/** eg-video 不在时一直重试，超过这么久算缺证 */
const GIVE_UP_MS = 10 * 60_000
const backoff = (tries: number) => Math.min(60_000, 2000 * 2 ** Math.min(tries, 5))

@Injectable()
export class EvidenceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('证据')
  private store!: EvidenceStore
  private readonly dir: string
  private readonly wave: WaveBuffer
  private timers: NodeJS.Timeout[] = []
  private busy = false
  private sending = false
  private uploading = false
  private full = false
  /** 盘满兜底累计删掉的待上传证据（告警明细用，恢复后清零） */
  private purged = { n: 0, oldest: null as number | null }
  private purgeAlarmId: string | null = null
  private recOk: boolean | null = null
  private indexError: string | null = null
  private lastIndexAck: number | null = null

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly video: VideoClient,
    private readonly uplink: UplinkService,
    private readonly audit: AuditService,
    private readonly tb: LocalTbService,
  ) {
    this.dir = resolve(cfg.dir, 'evidence')
    const e = cfg.local.evidence
    this.wave = new WaveBuffer(() => (Math.max(e.wavePreS + e.wavePostS, 60) + 60) * 1000)
  }

  get ev() {
    return this.cfg.local.evidence
  }

  /** 送不送子站：与告警事件同一开关（EG_EVENTS / EG_UPLINK） */
  get sendEnabled(): boolean {
    const e = process.env['EG_EVENTS']
    if (e === 'off') return false
    if (e !== 'on' && this.uplink.disabled) return false
    return !!stationToken(this.cfg)
  }

  private get base(): string {
    return `${this.cfg.conn.stationHttp}/ext/eg/${this.cfg.cabinet.code}/evidence`
  }

  onModuleInit(): void {
    mkdirSync(this.dir, { recursive: true })
    this.store = new EvidenceStore(resolve(this.cfg.dir, 'evidence.db'))
    this.bus.onTelemetry((dev, entries) => this.wave.take(dev, entries))
    this.timers.push(setInterval(() => void this.tick(), TICK_MS))
    this.timers.push(setInterval(() => void this.sendIndex(), 1000))
    this.timers.push(setInterval(() => void this.uploadDue(), TICK_MS))
    this.timers.push(setInterval(() => this.clean(), CLEAN_MS))
    this.timers.push(setInterval(() => void this.watch(), 60_000))
    setTimeout(() => void this.watch(), 5000)
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t)
    this.store?.close()
  }

  private important(severity: string, type: string): boolean {
    return this.ev.autoUpload.severities.includes(severity) || this.ev.autoUpload.types.includes(type)
  }

  /** 本地告警发生（告警事件第 1 版） */
  onAlarm(e: { eventId: string; occurredAt: number; severity: string; type: string; device: string }): void {
    if (Date.now() - e.occurredAt > 10 * 60_000) return // 对账补上来的陈年告警不补证据
    if (process.env['EG_PASSIVE'] === '1') return // 旁观实例（开发机并排验接口）不做证据，免得与正在跑的 agent 重复
    if (this.store.where('event_id = ?', e.eventId).length) return
    void this.createGroup({
      eventId: e.eventId,
      requestId: null,
      trigger: e.occurredAt,
      start: e.occurredAt - this.ev.preS * 1000,
      end: e.occurredAt + this.ev.postS * 1000,
      kinds: ['video', 'image', 'wave'],
      important: this.important(e.severity, e.type),
      reason: `${e.device}「${e.type}」${e.severity}`,
    }).then(r => this.log.log(`${e.device}「${e.type}」发生：登记 ${r.evidenceIds.length} 条证据${r.status !== 'ACCEPTED' ? `（${r.status}）` : ''}`))
  }

  /** 子站请求锁定 */
  async lock(req: LockRequest): Promise<LockReceipt> {
    if (req.eventId) {
      const had = this.store.where('event_id = ?', req.eventId)
      if (had.length) {
        // 同一事件本地已锁过：共用那一组，只记下请求号
        for (const r of had) if (!r.requestId) this.store.update(r.evidenceId, { requestId: req.requestId ?? null, uploadWanted: r.uploadWanted || !!req.upload })
        return { requestId: req.requestId ?? null, status: 'ACCEPTED', evidenceIds: had.map(r => r.evidenceId), message: '本地告警已锁定过这一组' }
      }
    }
    return this.createGroup({
      eventId: req.eventId ?? null,
      requestId: req.requestId ?? null,
      trigger: req.start,
      start: req.start,
      end: req.end,
      kinds: req.kinds?.length ? req.kinds : ['video', 'image', 'wave'],
      important: !!req.upload,
      reason: req.reason ?? '子站锁定',
    })
  }

  private async createGroup(g: { eventId: string | null; requestId: string | null; trigger: number; start: number; end: number; kinds: EvKind[]; important: boolean; reason: string }): Promise<LockReceipt> {
    const now = Date.now()
    const groupId = randomBytes(6).toString('hex')
    const ring = await this.video.recording()
    const oldest = ring?.paths.length ? Math.max(...ring.paths.map(p => p.oldest ?? now)) : null
    const cab = this.cfg.cabinet.code
    const ids: string[] = []
    let expired = 0
    let partial = false
    const add = (kind: EvKind, channelId: EvChannel, start: number, end: number, dueAt: number, pre?: { status: EvidenceRow['status']; missingReason: string }) => {
      const id = `EV-${cab}-${stamp(start)}-${kind}-${channelId}-${randomBytes(2).toString('hex')}`
      const row: EvidenceRow = {
        evidenceId: id,
        revision: 1,
        eventId: g.eventId,
        requestId: g.requestId,
        groupId,
        cabinetId: cab,
        gatewayId: this.cfg.eg.name,
        channelId,
        kind,
        requestedStart: start,
        requestedEnd: end,
        actualStart: null,
        actualEnd: null,
        status: pre?.status ?? 'RECORDING',
        location: 'none',
        sizeBytes: null,
        codec: null,
        sha256: null,
        important: g.important,
        pairOffsetMs: null,
        createdAt: now,
        expiresAt: null,
        missingReason: pre?.missingReason ?? null,
        file: null,
        dueAt: pre ? null : dueAt,
        uploadTries: 0,
        uploadNext: 0,
        uploadError: null,
        uploadWanted: g.important,
      }
      this.store.insert(row)
      ids.push(id)
      if (pre?.status === 'EXPIRED') expired++
    }
    const disk = this.full ? { status: 'MISSING' as const, missingReason: 'disk_full' } : undefined
    if (disk) this.audit.write({ user: 'system', name: '证据', via: 'system', ip: '-', action: 'evidence.disk_full', target: g.reason, ok: false, detail: '数据盘满，新锁定标缺证' })
    if (g.kinds.includes('video')) {
      const pre = disk ?? (oldest !== null && g.end < oldest ? { status: 'EXPIRED' as const, missingReason: 'expired' } : undefined)
      if (!pre && oldest !== null && g.start < oldest) partial = true
      for (const ch of ['visible', 'ir'] as const) add('video', ch, g.start, g.end, Math.max(g.end, now) + FLUSH_MS, pre)
    }
    if (g.kinds.includes('image') && Math.abs(g.trigger - now) < 15_000) {
      for (const ch of ['visible', 'ir'] as const) add('image', ch, g.trigger, g.trigger, now, disk)
    }
    if (g.kinds.includes('wave')) {
      const [ws, we] = g.requestId && !g.eventId ? [g.start, g.end] : [g.trigger - this.ev.wavePreS * 1000, g.trigger + this.ev.wavePostS * 1000]
      const keep = (Math.max(this.ev.wavePreS + this.ev.wavePostS, 60) + 60) * 1000
      const pre = disk ?? (we < now - keep ? { status: 'EXPIRED' as const, missingReason: 'expired' } : undefined)
      add('wave', 'data', ws, we, Math.max(we, now) + 2000, pre)
    }
    void this.tick()
    const status = ids.length && expired === ids.length ? 'EXPIRED' : partial || expired ? 'PARTIAL' : 'ACCEPTED'
    return { requestId: g.requestId, status, evidenceIds: ids, ...(status !== 'ACCEPTED' ? { message: `循环录像最早到 ${oldest ? new Date(oldest).toISOString() : '—'}` } : {}) }
  }

  /** 到期的证据去做（串行） */
  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = Date.now()
      for (const r of this.store.where("status = 'RECORDING' and due_at <= ? order by due_at", now)) await this.produce(r)
    } finally {
      this.busy = false
    }
  }

  private async produce(r: EvidenceRow): Promise<void> {
    const now = Date.now()
    const expiresAt = now + this.ev.lockedDays * DAY
    const done = (buf: Buffer, ext: string, codec: string, actualStart0: number, actualEnd0: number, missingReason: string | null) => {
      const actualStart = Math.round(actualStart0)
      const actualEnd = Math.round(actualEnd0)
      const file = `${r.evidenceId}.${ext}`
      writeFileSync(resolve(this.dir, file), buf)
      this.store.update(r.evidenceId, {
        status: 'READY',
        location: 'edge',
        file,
        sizeBytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        codec,
        actualStart,
        actualEnd,
        expiresAt,
        missingReason,
        dueAt: null,
      })
      this.pair(r)
    }
    const missing = (reason: string) => this.store.update(r.evidenceId, { status: 'MISSING', missingReason: reason, dueAt: null })
    const later = (why: string) => {
      if (now - r.createdAt > GIVE_UP_MS) return missing('camera_unreachable')
      this.store.update(r.evidenceId, { dueAt: now + 30_000 })
      this.log.warn(`${r.evidenceId} 暂时做不了（${why}），30 s 后再试`)
    }
    try {
      if (r.kind === 'video') {
        const c = await this.video.clip(r.channelId as 'visible' | 'ir', r.requestedStart, r.requestedEnd)
        if ('missing' in c) return void missing(c.missing)
        done(c.mp4, 'mp4', 'h264', c.actualStart, c.actualEnd, c.gap ? 'gap' : null)
      } else if (r.kind === 'image') {
        const s = await this.video.snapshotRaw(r.channelId as 'visible' | 'ir')
        if ('error' in s) return void missing('camera_unreachable')
        done(s.jpeg, 'jpg', 'jpeg', s.ts, s.ts, null)
      } else {
        const trigger = r.eventId ? r.requestedStart + this.ev.wavePreS * 1000 : r.requestedStart
        const w = this.wave.collect(trigger, (trigger - r.requestedStart) / 1000, (r.requestedEnd - trigger) / 1000)
        const pts = Object.values(w.series).flat()
        if (!pts.length) return void missing('no_data')
        const ts = pts.map(p => p[0])
        done(Buffer.from(JSON.stringify(w)), 'json', 'json', Math.min(...ts), Math.max(...ts), null)
      }
    } catch (e) {
      later((e as Error).message)
    }
  }

  /** 双光配对：同一组同一种的另一路也好了，就记两路实际起点的差（热像 − 可见光） */
  private pair(r: EvidenceRow): void {
    if (r.kind === 'wave') return
    const both = this.store.where("group_id = ? and kind = ? and status in ('READY', 'UPLOADED')", r.groupId, r.kind)
    const vis = both.find(x => x.channelId === 'visible')
    const ir = both.find(x => x.channelId === 'ir')
    if (!vis || !ir || vis.actualStart === null || ir.actualStart === null) return
    const off = ir.actualStart - vis.actualStart
    this.store.update(vis.evidenceId, { pairOffsetMs: off })
    this.store.update(ir.evidenceId, { pairOffsetMs: off })
  }

  /** 证据索引送子站（与告警事件同一做法） */
  private async sendIndex(): Promise<void> {
    if (this.sending || !this.sendEnabled) return
    const rows = this.store.dueIndex(50)
    if (!rows.length) return
    this.sending = true
    const retryAll = (msg: string, delay?: number) => {
      this.indexError = msg
      for (const r of rows) this.store.retryIndex(r.id, r.revision, msg, delay ?? backoff(r.tries))
    }
    try {
      const body = JSON.stringify({ bootId: this.uplink.bootId, batchId: randomBytes(8).toString('hex'), items: rows.map(r => roundTimes(JSON.parse(r.body) as object)) })
      let res: Response
      try {
        res = await fetch(this.base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EG-Token': stationToken(this.cfg) }, body, signal: AbortSignal.timeout(10_000) })
        this.uplink.countSent(Buffer.byteLength(body))
      } catch (e) {
        return retryAll(`连不上 ${this.cfg.conn.stationHttp}：${(e as Error).message}`)
      }
      if (!res.ok) return retryAll(`子站回 ${res.status}`, res.status < 500 ? 60_000 : undefined)
      const results = (((await res.json().catch(() => ({}))) as { results?: { evidenceId: string; revision: number; status: string; retryable?: boolean; reason?: string }[] }).results ?? [])
      const by = new Map(results.map(x => [`${x.evidenceId}#${x.revision}`, x]))
      for (const r of rows) {
        const x = by.get(`${r.id}#${r.revision}`)
        if (x?.status === 'accepted' || x?.status === 'duplicate') this.store.settleIndex(r.id, r.revision)
        else if (x?.status === 'rejected' && x.retryable === false) {
          this.audit.write({ user: 'system', name: '证据', via: 'system', ip: '-', action: 'evidence.index_rejected', target: `${r.id}#${r.revision}`, ok: false, detail: x.reason })
          this.store.settleIndex(r.id, r.revision)
        } else this.store.retryIndex(r.id, r.revision, x ? `子站暂不收：${x.reason ?? ''}` : '回执里没有这一条', backoff(r.tries))
      }
      this.indexError = null
      this.lastIndexAck = Date.now()
    } finally {
      this.sending = false
    }
  }

  /** 重要证据（或子站要的）的文件上传；子站按 sha256 校验后回执才算 UPLOADED */
  private async uploadDue(): Promise<void> {
    if (this.uploading || !this.sendEnabled) return
    const r = this.store.where("upload_wanted = 1 and status = 'READY' and file is not null and upload_next <= ? order by created_at limit 1", Date.now())[0]
    if (!r) return
    this.uploading = true
    try {
      const buf = readFileSync(resolve(this.dir, r.file!))
      const type = r.kind === 'video' ? 'video/mp4' : r.kind === 'image' ? 'image/jpeg' : 'application/json'
      const res = await fetch(`${this.base}/${encodeURIComponent(r.evidenceId)}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': type, 'X-EG-Token': stationToken(this.cfg), 'X-Sha256': r.sha256! },
        body: buf,
        signal: AbortSignal.timeout(120_000),
      })
      this.uplink.countSent(buf.length)
      const j = (await res.json().catch(() => ({}))) as { stored?: boolean; sha256?: string }
      if (res.ok && j.stored && j.sha256 === r.sha256) {
        this.store.update(r.evidenceId, { status: 'UPLOADED', location: 'both', expiresAt: Date.now() + this.ev.uploadedKeepDays * DAY, uploadError: null })
        this.log.log(`${r.evidenceId} 已上传子站（${buf.length} 字节，校验一致）`)
      } else throw new Error(res.ok ? `子站回执不对（stored=${j.stored} sha256=${j.sha256 ?? '—'}）` : `子站回 ${res.status}`)
    } catch (e) {
      this.store.update(r.evidenceId, { uploadTries: r.uploadTries + 1, uploadNext: Date.now() + backoff(r.uploadTries), uploadError: (e as Error).message })
    } finally {
      this.uploading = false
    }
  }

  /** 子站要这一条的文件（POST /api/evidence/<id>/upload） */
  requestUpload(id: string): EvidenceRow | null {
    const r = this.store.get(id)
    if (!r) return null
    return this.store.update(id, { uploadWanted: true, uploadNext: 0 })
  }

  /** 到期清本地副本：已上传的只删文件（位置改 station），其余状态改 DELETED；要上传、还没确认归档的不删（唯一副本） */
  private clean(): void {
    const now = Date.now()
    for (const r of this.store.where(EXPIRED_SQL, now)) {
      // 同一文件被别的证据引用（本实现每条证据一份文件，这里按文件名查，将来共用时也成立）
      if (this.store.where('file = ? and id != ? and (expires_at is null or expires_at >= ?)', r.file, r.evidenceId, now).length) continue
      try {
        rmSync(resolve(this.dir, r.file!), { force: true })
      } catch {
        /* 删不掉下次再来 */
      }
      if (r.status === 'UPLOADED') this.store.update(r.evidenceId, { location: 'station', file: null })
      else this.store.update(r.evidenceId, { status: 'DELETED', location: 'none', file: null })
    }
  }

  /** 数据盘水位与录像健康（每分钟） */
  private async watch(): Promise<void> {
    let used = this.diskUsed()
    if (used !== null && used >= this.ev.purgeWater) {
      const r = this.purgeNow()
      used = r.after
      if (r.unuploaded.n) await this.raisePurgeAlarm(r)
    } else if (used !== null && used < this.ev.highWater && (this.purged.n || this.purgeAlarmId)) await this.clearPurgeAlarm(used)
    const full = used !== null && used >= this.ev.fullWater
    if (full !== this.full) {
      this.full = full
      this.log[full ? 'warn' : 'log'](full ? `数据盘 ${used} % 已满（≥ ${this.ev.fullWater} %）：新的锁定标缺证，要尽快处理` : `数据盘降到 ${used} %，恢复锁定`)
      this.audit.write({ user: 'system', name: '证据', via: 'system', ip: '-', action: full ? 'evidence.disk_full' : 'evidence.disk_ok', target: `${used} %`, ok: !full })
    }
    const rec = await this.video.recording()
    this.recOk = rec ? rec.ok : null
  }

  private diskUsed(): number | null {
    try {
      const s = statfsSync(this.cfg.dir)
      return Math.round((1 - s.bavail / s.blocks) * 1000) / 10
    } catch {
      return null /* 取不到按没满 */
    }
  }

  /** 盘满兜底一轮（purge.ts）：删文件、改状态、写日志与审计 */
  purgeNow(): PurgeResult {
    const r = purge(
      {
        used: () => this.diskUsed(),
        candidates: (step: PurgeStep) => this.store.where(CANDIDATE_SQL[step]),
        remove: (row: EvidenceRow, step: PurgeStep) => {
          try {
            rmSync(resolve(this.dir, row.file!), { force: true })
          } catch {
            return false
          }
          if (step === 'uploaded') this.store.update(row.evidenceId, { location: 'station', file: null })
          else this.store.update(row.evidenceId, { status: 'DELETED', location: 'none', file: null, missingReason: step === 'unuploaded' ? 'disk_purged_unuploaded' : 'disk_purged' })
          return true
        },
      },
      this.ev.purgeWater,
      this.ev.highWater,
    )
    const n = r.removed.uploaded + r.removed.not_wanted + r.removed.unuploaded
    if (n) {
      const detail = `数据盘 ${r.before} % → ${r.after} %：删本地副本 已上传 ${r.removed.uploaded}、不需上传 ${r.removed.not_wanted}、待上传（未归档）${r.removed.unuploaded}`
      this.log.warn(`盘满兜底：${detail}${r.unuploaded.n ? `；待上传被删的：${r.unuploaded.ids.join('、')}` : ''}`)
      this.audit.write({ user: 'system', name: '证据', via: 'system', ip: '-', action: 'evidence.disk_purge', target: `${r.before} %`, ok: !r.unuploaded.n, detail })
    } else if (r.before !== null && r.before >= this.ev.purgeWater) this.log.warn(`数据盘 ${r.before} % 超过 ${this.ev.purgeWater} %，但已没有可删的本地证据副本（循环录像由 eg-video 删）`)
    return r
  }

  private async egDeviceId(): Promise<string> {
    const d = await this.tb.get<{ id: { id: string } }>(`/api/tenant/devices?deviceName=${encodeURIComponent(this.cfg.eg.name)}`)
    return d.id.id
  }

  /** 报 / 更新「证据未上传即被清理」：本地 TB 上 EG 自身设备的活动告警，经告警事件送子站 */
  private async raisePurgeAlarm(r: PurgeResult): Promise<void> {
    this.purged.n += r.unuploaded.n
    this.purged.oldest = this.purged.oldest === null ? r.unuploaded.oldest : Math.min(this.purged.oldest, r.unuploaded.oldest ?? Infinity)
    if (!this.tb.available) return
    const oldest = this.purged.oldest ? new Date(this.purged.oldest + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) : '—'
    const details = { cls: 'dev', src: 'EG', n: this.purged.n, oldest: this.purged.oldest, ids: r.unuploaded.ids.slice(0, 20), disk: r.after, text: `证据未上传即被清理（${this.purged.n} 个，最早 ${oldest}）` }
    try {
      const id = await this.egDeviceId()
      const act = await this.tb.get<{ data: { id: { id: string }; type: string }[] }>(`/api/alarm/DEVICE/${id}?searchStatus=ACTIVE&pageSize=50&page=0`)
      const cur = act.data.find(a => a.type === PURGE_ALARM)
      const saved = await this.tb.req<{ id: { id: string } }>('POST', '/api/alarm', cur ? { ...cur, severity: 'MAJOR', details } : { originator: { entityType: 'DEVICE', id }, type: PURGE_ALARM, severity: 'MAJOR', status: 'ACTIVE_UNACK', details })
      this.purgeAlarmId = saved.id.id
      this.log.warn(`EG 告警「${PURGE_ALARM}」：${details.text}`)
    } catch (e) {
      this.log.warn(`报「${PURGE_ALARM}」失败：${(e as Error).message}（下一轮再报）`)
    }
  }

  /** 降到 highWater 以下：告警恢复，累计清零 */
  private async clearPurgeAlarm(used: number): Promise<void> {
    if (this.tb.available) {
      try {
        const id = await this.egDeviceId()
        const act = await this.tb.get<{ data: { id: { id: string }; type: string }[] }>(`/api/alarm/DEVICE/${id}?searchStatus=ACTIVE&pageSize=50&page=0`)
        for (const a of act.data.filter(x => x.type === PURGE_ALARM)) await this.tb.req('POST', `/api/alarm/${a.id.id}/clear`)
      } catch (e) {
        this.log.warn(`「${PURGE_ALARM}」恢复失败：${(e as Error).message}`)
        return
      }
    }
    this.log.log(`数据盘降到 ${used} %，「${PURGE_ALARM}」恢复（累计删了 ${this.purged.n} 个待上传证据）`)
    this.purged = { n: 0, oldest: null }
    this.purgeAlarmId = null
  }

  /** EG 自身指标（随 eg.* 每 5 s）：待上传条数、证据存储满、循环录像是否在录 */
  metrics(): Record<string, unknown> {
    if (!this.store) return {}
    const pending = this.store.where("upload_wanted = 1 and status = 'READY'").length
    return { 'eg.evid_pending': pending, 'eg.evid_full': this.full, ...(this.recOk !== null ? { 'eg.rec_ok': this.recOk } : {}) }
  }

  status() {
    const idx = this.store.indexPending()
    return {
      target: this.sendEnabled ? this.base : null,
      full: this.full,
      recOk: this.recOk,
      indexPending: idx.n,
      indexError: this.indexError ?? idx.lastError,
      lastIndexAck: this.lastIndexAck,
      uploadPending: this.store.where("upload_wanted = 1 and status = 'READY'").length,
      config: this.ev,
    }
  }

  list(limit = 200) {
    return this.store.recent(limit).map(r => ({ ...indexOf(r), hasFile: !!r.file, uploadWanted: r.uploadWanted, uploadError: r.uploadError }))
  }

  fileOf(id: string): { path: string; type: string; row: EvidenceRow } | { gone: EvidenceRow } | null {
    const r = this.store.get(id)
    if (!r) return null
    if (!r.file || !existsSync(resolve(this.dir, r.file))) return { gone: r }
    const type = r.kind === 'video' ? 'video/mp4' : r.kind === 'image' ? 'image/jpeg' : 'application/json'
    return { path: resolve(this.dir, r.file), type, row: r }
  }
}

function stamp(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000) // 东八区
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
