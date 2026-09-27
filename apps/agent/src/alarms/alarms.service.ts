/* 告警事件（I3，后端库 docs/EG独立TB调整方案.md §2.3、§8.2）。
 *
 *   EG 本地 TB 设备配置节点算出告警 ─规则链 REST 节点─► POST /hooks/alarm（provision:eg --hook 加的）
 *                                    └─ 每 30 s 对账：读本地 TB 的活动告警 + 上次对账以来新建的告警，补钩子漏掉的
 *     ─► events.db（每条告警的状态与 revision；待送事件每个 eventId 只留最新一版）
 *     ─► POST <子站>/ext/eg/<柜号>/events（X-EG-Token）；回执 accepted / duplicate 才删，rejected 且不可重试记审计后丢
 *
 * 钩子的请求体只当「提示」：状态有变时按告警 id 回本地 TB 读一遍再记（本地 TB 是唯一来源；伪造的钩子最多引起一次查询）。
 * eventId = 本地 TB 告警 id（UUID，重启不变）；revision 在状态 / 级别 / 恢复时刻变化时 + 1，测量值变化不算（见 events.store.ts）。 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { pointsOf } from '@lsa/points'
import { stationToken, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { LocalTbService, TbHttpError } from '../tb/local-tb.service.js'
import { UplinkService } from '../uplink/uplink.service.js'
import { ApplyService } from '../apply/apply.service.js'
import { EvidenceService } from '../evidence/evidence.service.js'
import { EventsStore, type EgEvent, type Observed } from './events.store.js'

/** 本地 TB 的告警对象（规则引擎消息与 REST 返回的 AlarmInfo 共有的部分） */
export interface TbAlarm {
  id: { id: string }
  type: string
  severity: string
  status?: string
  cleared?: boolean
  startTs?: number
  endTs?: number
  clearTs?: number
  createdTime?: number
  originatorName?: string
  details?: Record<string, unknown> | null
}

/** provision:eg 的「整理告警给 eg-agent」节点发来的 */
export interface AlarmHook {
  kind?: 'created' | 'updated' | 'cleared'
  device?: string
  deviceType?: string
  alarm?: TbAlarm
}

interface Receipt {
  eventId: string
  revision: number
  status: 'accepted' | 'duplicate' | 'rejected'
  reason?: string
  retryable?: boolean
}

export interface EventsStatus {
  state: 'ok' | 'retrying' | 'off' | 'none'
  text: string
  target: string | null
  pending: number
  oldestQueuedAt: number | null
  lastAckAt: number | null
  lastError: string | null
  active: number
  hook: { count: number; lastAt: number | null; ignored: boolean }
  reconcile: { lastAt: number | null; lastError: string | null }
  /** 事件库文件（自检用独立的库：EG_EVENTS_DB） */
  db: string
}

const RECONCILE_MS = 30_000
const SEND_TICK_MS = 1000
const BATCH = 50
const FIRST_WINDOW_MS = 24 * 3_600_000
/** 对账按「上次对账以来新建的」查，往前多看一点，免得两次之间的边界漏掉 */
const OVERLAP_MS = 120_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const backoff = (tries: number) => Math.min(60_000, 2000 * 2 ** Math.min(tries, 5))

/** details 归一化（与子站同一句，后端 rulechain.ts 文件头）：设备配置告警的明细是 {data: "<JSON 字符串>"} */
export function normalizeDetails(d: TbAlarm['details']): Record<string, unknown> {
  if (d && typeof d['data'] === 'string') {
    try {
      return JSON.parse(d['data']) as Record<string, unknown>
    } catch {
      return { text: d['data'] }
    }
  }
  return { ...(d ?? {}) }
}

@Injectable()
export class AlarmsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('告警事件')
  private store!: EventsStore
  private timers: NodeJS.Timeout[] = []
  /** 钩子与对账串行处理，免得同一条告警的两次读取乱序落库 */
  private chain: Promise<unknown> = Promise.resolve()
  private sending = false
  private readonly devices: Map<string, string>
  private lastAckAt: number | null = null
  private sendError: string | null = null
  private hookCount = 0
  private hookAt: number | null = null
  /** 告警 id → 最近一次钩子到达时刻（event_timing 用；60 s 内的才算这一版是钩子带出来的） */
  private readonly hookSeen = new Map<string, number>()
  private reconcileAt: number | null = null
  private reconcileError: string | null = null
  /** 调试：不理钩子，只靠对账（EG_DEBUG=1，自检验对账补漏用） */
  ignoreHooks = false

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly tb: LocalTbService,
    private readonly uplink: UplinkService,
    private readonly audit: AuditService,
    private readonly applySvc: ApplyService,
    private readonly evidence: EvidenceService,
  ) {
    this.devices = new Map([[cfg.eg.name, 'eg'], ...cfg.devices.map(d => [d.name, d.kind] as [string, string])])
  }

  /** 送不送子站：EG_EVENTS=on / off 明确指定；缺省跟遥测上送一致（EG_UPLINK=off 就不送） */
  get sendEnabled(): boolean {
    const e = process.env['EG_EVENTS']
    if (e === 'off') return false
    if (e !== 'on' && this.uplink.disabled) return false
    return !!stationToken(this.cfg)
  }

  get target(): string {
    return `${this.cfg.conn.stationHttp}/ext/eg/${this.cfg.cabinet.code}/events`
  }

  onModuleInit(): void {
    this.store = new EventsStore(this.dbPath)
    if (!this.tb.available) {
      this.log.warn('eg.yaml 里没有本地 TB 账号（tb 段）：不读本地告警、不发告警事件')
      return
    }
    this.log.log(this.sendEnabled ? `告警事件送 ${this.target}` : '告警事件只记本地、不送子站（EG_UPLINK=off 或 EG_EVENTS=off）')
    if (this.sendEnabled) {
      // 启动时（上送目标也只在启动时会变）把活动告警按当前版本重发一遍：之前送错了地方、或子站丢了的，这里补上
      const last = this.store.getMeta('target')
      const n = this.store.requeueActive()
      if (n) this.log.log(`重发 ${n} 条活动告警${last && last !== this.target ? `（上送目标从 ${last} 改成了 ${this.target}）` : ''}`)
      this.store.setMeta('target', this.target)
    }
    this.timers.push(setTimeout(() => this.reconcileSoon(), 5000))
    this.timers.push(setInterval(() => this.reconcileSoon(), RECONCILE_MS))
    this.timers.push(setInterval(() => void this.sendDue(), SEND_TICK_MS))
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t)
    this.store?.close()
  }

  /** 规则链推来的一条告警变化 */
  hook(h: AlarmHook): { accepted: boolean; reason?: string } {
    const id = h.alarm?.id?.id
    if (!id || !UUID.test(id)) return { accepted: false, reason: '没有告警 id' }
    this.hookCount++
    this.hookAt = Date.now()
    this.hookSeen.set(id, this.hookAt)
    if (this.ignoreHooks || !this.tb.available) return { accepted: true }
    const cleared = h.kind === 'cleared' || !!h.alarm?.cleared || !!h.alarm?.status?.startsWith('CLEARED')
    const known = this.store.known(id)
    // 状态与级别都没变（告警持续期间每条遥测都会来一次 Alarm Updated）：不用回本地 TB 查
    if (known && known.state === (cleared ? 'CLEARED' : 'ACTIVE') && known.severity === h.alarm?.severity) return { accepted: true }
    this.serial(async () => {
      try {
        const a = await this.tb.get<TbAlarm>(`/api/alarm/info/${id}`)
        this.take(a)
      } catch (e) {
        // 查不到（伪造的 id、本地 TB 正重启）：不记，30 s 对账兜底
        this.log.warn(`钩子里的告警 ${id} 读本地 TB 失败：${(e as Error).message}`)
      }
    })
    return { accepted: true }
  }

  /** 事件库：缺省配置目录下的 events.db；EG_EVENTS_DB 指定别的（自检用假子站时要用独立的库，免得假子站把正式的事件收走） */
  get dbPath(): string {
    const e = process.env['EG_EVENTS_DB']
    return e ? resolve(e) : resolve(this.cfg.dir, 'events.db')
  }

  /** 把活动告警按当前版本重发一遍（调试接口；不用重启 agent） */
  resync(): number {
    const n = this.store.requeueActive()
    this.log.log(`手动重发 ${n} 条活动告警`)
    void this.sendDue()
    return n
  }

  /** 马上对账一次（调试 / 自检） */
  reconcileNow(): Promise<void> {
    return this.serial(() => this.reconcile())
  }

  status(): EventsStatus {
    const s = this.store.stats()
    const base = {
      target: this.sendEnabled ? this.target : null,
      pending: s.pending,
      oldestQueuedAt: s.oldestQueuedAt,
      lastAckAt: this.lastAckAt,
      lastError: this.sendError ?? s.lastError,
      active: s.active,
      hook: { count: this.hookCount, lastAt: this.hookAt, ignored: this.ignoreHooks },
      reconcile: { lastAt: this.reconcileAt, lastError: this.reconcileError },
      db: this.dbPath,
    }
    if (!this.tb.available) return { ...base, state: 'none', text: 'eg.yaml 里没有本地 TB 账号：不读本地告警' }
    if (!this.sendEnabled) return { ...base, state: 'off', text: `告警事件只记本地、不送子站（${s.active} 条活动）` }
    if (s.pending && this.sendError) return { ...base, state: 'retrying', text: `待送 ${s.pending} 条，重试中：${this.sendError}` }
    return { ...base, state: 'ok', text: s.pending ? `待送 ${s.pending} 条` : `正常，无待送（${s.active} 条活动）` }
  }

  recent(limit?: number) {
    return this.store.recent(limit)
  }

  timing(eventId?: string, limit?: number) {
    return this.store.timing(eventId, limit)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => undefined)
    return p
  }

  private reconcileSoon(): void {
    void this.serial(() => this.reconcile()).catch(() => undefined)
  }

  /** 本地 TB 上的一条告警 → 本地记录；有新一版就马上试着发 */
  private take(a: TbAlarm): EgEvent | null {
    const o = this.observed(a)
    if (!o) return null
    const seen = this.hookSeen.get(o.eventId)
    this.hookSeen.delete(o.eventId)
    const ev = this.store.observe(o, Date.now(), seen && Date.now() - seen < 60_000 ? seen : null)
    if (ev) {
      this.log.log(`${ev.device}「${ev.type}」${ev.state === 'ACTIVE' ? '发生' : '恢复'}（${ev.severity}，第 ${ev.revision} 版）`)
      // G5：告警发生即锁证据（循环录像前后窗、双光抓图、录波）
      if (ev.revision === 1 && ev.state === 'ACTIVE') this.evidence.onAlarm(ev)
      void this.sendDue()
    }
    return ev
  }

  private observed(a: TbAlarm): Observed | null {
    const device = a.originatorName
    if (!device || !this.devices.has(device)) return null
    const cleared = !!a.cleared || !!a.status?.startsWith('CLEARED')
    const d = normalizeDetails(a.details)
    const key = typeof d['key'] === 'string' ? d['key'] : null
    return {
      eventId: a.id.id,
      device,
      type: a.type,
      severity: a.severity,
      state: cleared ? 'CLEARED' : 'ACTIVE',
      occurredAt: a.startTs || a.createdTime || Date.now(),
      clearedAt: cleared ? a.clearTs || a.endTs || Date.now() : null,
      details: { ...d, unit: d['unit'] ?? (key ? this.unitOf(device, key) : null), ruleVersion: this.ruleVersion() },
    }
  }

  private unitOf(device: string, key: string): string | null {
    const kind = this.devices.get(device)
    if (!kind || kind === 'eg') return null
    const pts = pointsOf(kind as never, this.cfg.cabinet.group, true) as { key: string; unit: string }[]
    const hit = pts.find(p => p.key === key) ?? pts.find(p => new RegExp(`^${p.key.replace(/\./g, '\\.').replace(/\{[^}]+\}/g, '[^.]+')}$`).test(key))
    // 点表里有、但无量纲（如紫外弧光强度）回空串；点表里没有才是 null
    return hit ? hit.unit : null
  }

  /** 生效的规则版本：I4 起是 agent 应用过的配置版本，之前是 eg.yaml 带来的 cfg 属性 */
  private ruleVersion(): string | null {
    return this.applySvc.version()
  }

  private async pages(path: string): Promise<TbAlarm[]> {
    const out: TbAlarm[] = []
    for (let page = 0; page < 50; page++) {
      const r = await this.tb.get<{ data: TbAlarm[]; hasNext: boolean }>(`${path}&pageSize=200&page=${page}`)
      out.push(...r.data)
      if (!r.hasNext) break
    }
    return out
  }

  /** 对账：钩子是 TB 发一次不重试的 REST 调用，可能漏（agent 重启、本地 TB 刚起） */
  private async reconcile(): Promise<void> {
    if (!this.tb.available) return
    const t0 = Date.now()
    try {
      const since = Number(this.store.getMeta('reconciledAt')) || t0 - FIRST_WINDOW_MS
      const recent = await this.pages(`/api/v2/alarms?startTime=${since - OVERLAP_MS}&sortProperty=createdTime&sortOrder=ASC`)
      const active = await this.pages('/api/v2/alarms?statusList=ACTIVE&sortProperty=createdTime&sortOrder=ASC')
      let n = 0
      for (const a of [...recent, ...active]) if (this.take(a)) n++
      // 本地记着是活动的、本地 TB 上已不在活动列表里：逐条读回来（恢复了，或被删了）
      const live = new Set(active.map(a => a.id.id))
      for (const k of this.store.active()) {
        if (live.has(k.eventId)) continue
        try {
          if (this.take(await this.tb.get<TbAlarm>(`/api/alarm/info/${k.eventId}`))) n++
        } catch (e) {
          if (!(e instanceof TbHttpError && e.status === 404)) throw e
          const old = this.store.get(k.eventId)
          if (old && this.store.observe({ ...old, state: 'CLEARED', clearedAt: Date.now(), details: { ...old.details, reason: '本地 TB 上已删除' } })) n++
        }
      }
      if (n) this.log.log(`对账补了 ${n} 条告警变化`)
      this.store.setMeta('reconciledAt', String(t0))
      this.store.prune()
      this.reconcileAt = t0
      this.reconcileError = null
    } catch (e) {
      this.reconcileError = (e as Error).message
      this.log.warn(`对账失败：${this.reconcileError}`)
    }
  }

  private async sendDue(): Promise<void> {
    if (this.sending || !this.sendEnabled) return
    const rows = this.store.due(BATCH)
    if (!rows.length) return
    this.sending = true
    const batchId = randomBytes(8).toString('hex')
    const retryAll = (msg: string, delay?: number) => {
      this.sendError = msg
      for (const r of rows) this.store.retry(r.eventId, r.revision, msg, delay ?? backoff(r.tries))
    }
    try {
      let res: Response
      const payload = JSON.stringify({ bootId: this.uplink.bootId, batchId, events: rows.map(r => JSON.parse(r.body) as EgEvent) })
      this.store.markSent(rows)
      try {
        res = await fetch(this.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-EG-Token': stationToken(this.cfg) },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        })
        this.uplink.countSent(Buffer.byteLength(payload))
      } catch (e) {
        return retryAll(`连不上 ${this.cfg.conn.stationHttp}：${(e as Error).cause ? String((e as Error).cause) : (e as Error).message}`)
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200)
        // 4xx（令牌不对、接口还没有）不会自己好，慢慢重试；事件不丢
        return retryAll(`子站回 ${res.status} ${text}`, res.status < 500 && res.status !== 408 && res.status !== 429 ? 60_000 : undefined)
      }
      let results: Receipt[] = []
      try {
        results = ((await res.json()) as { results?: Receipt[] }).results ?? []
      } catch {
        return retryAll('子站回执不是 JSON')
      }
      const byId = new Map(results.map(r => [`${r.eventId}#${r.revision}`, r]))
      let ok = 0
      for (const row of rows) {
        const r = byId.get(`${row.eventId}#${row.revision}`)
        if (!r) {
          this.store.retry(row.eventId, row.revision, '回执里没有这一条', backoff(row.tries))
          continue
        }
        if (r.status === 'accepted' || r.status === 'duplicate') {
          this.store.settle(row.eventId, row.revision)
          ok++
        } else if (r.retryable === false) {
          const ev = JSON.parse(row.body) as EgEvent
          this.log.warn(`子站拒收 ${ev.device}「${ev.type}」第 ${ev.revision} 版：${r.reason ?? '（没说原因）'}，丢弃`)
          this.audit.write({ user: 'system', name: '告警事件', via: 'system', ip: '-', action: 'event.rejected', target: `${ev.device} ${ev.type} ${ev.eventId}#${ev.revision}`, ok: false, detail: r.reason })
          this.store.settle(row.eventId, row.revision, false)
        } else {
          this.store.retry(row.eventId, row.revision, `子站暂不收：${r.reason ?? ''}`, backoff(row.tries))
        }
      }
      if (ok) {
        this.lastAckAt = Date.now()
        this.sendError = null
      }
    } finally {
      this.sending = false
    }
    // 还有就接着发（断网恢复后的积压）
    if (this.store.due(1).length) setImmediate(() => void this.sendDue())
  }
}
