/* 配置下发的 EG 侧（I4，后端库 docs/EG独立TB调整方案.md §2.4、§8.3）。
 *
 *   子站扩展服务 ─PUT /api/config（X-EG-Ticket 服务票据）─► 校验 ─► 写本地 TB 的设备配置（7 类告警规则与阈值）
 *     ─► 回执 { version, status: APPLIED | FAILED, error? } ─► 发 EG 属性 cfg = 实际生效版本（经本地 TB 与上送到子站）
 *
 * 告警规则由后端库 @lsa/model 的同一份代码按阈值表生成（与子站 provision、provision:eg 一致），再按规则开关去掉停用的：
 *   EG-rise / EG-rise2 是「过温」的 MAJOR / CRITICAL 两级，停一级去掉一级，两级都停整条去掉；其余一条规则对应一类告警。
 * 只改本机本来就有的、带告警的设备配置（sam_* / meter / pm_sensor）。写到一半失败把已写的改回去。
 * 生效版本记在配置目录的 applied-config.json（重启后照旧上报；告警事件的 ruleVersion 也取它）。
 * 本地 TB 暂时没就绪（EG 刚开机 TB 还在起、连不上、超时、5xx）：不回 FAILED，回 PENDING（retryable: true），
 *   这份配置落盘（pending-config.json）排队，15 s 起退避到 60 s 自己重试，应用成功后照常更新 cfg 属性（§8.3 的「实际版本」即最终状态）；
 *   配置内容本身的问题（校验不过、阈值表不全、设备清单不同）才回 FAILED。新的一次下发（不论结果）顶替排着的。
 * 不认识的规则 id（子站比这台 EG 新，滚动升级时常见）：跳过、记警告，其余照常应用，回执带 ignored:[…]（§8.3）。
 * 设备清单（devices）在线改暂不支持：与本机 eg.yaml 一致就忽略，不一致回 FAILED（要在子站重新生成 eg.yaml 部署）。
 * 阶段 A（接口 v1.1）：体里另带 caps / capKeys（能力清单，caps/caps.ts）与 devComm（下挂设备离线判据），一并算进内容哈希、
 *   存进 applied-config.json，应用后交给 CapsService；老子站不带 = 全部照旧。
 * 规则停用或告警类型改名（如 EG-rh「环境」→「柜内湿度高」）后，本地 TB 上该类型挂着的活动告警没有规则来清了 ——
 *   写完设备配置后把「之前有、现在没有」的告警类型的活动告警清掉（经钩子 / 对账照常给子站送 CLEARED）。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { PROFILES, profileBody, type ThresholdExtras, type ThresholdRow } from '@lsa/model'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { BusService } from '../bus/bus.service.js'
import { LocalTbService, TbHttpError } from '../tb/local-tb.service.js'
import { parseCaps, type CapsConfig } from '../caps/caps.js'
import { CapsService, type DevCommParams } from '../caps/caps.service.js'

export interface ApplyReceipt {
  version: string
  status: 'APPLIED' | 'FAILED' | 'PENDING'
  error?: string
  /** PENDING 时为 true：暂时性问题，EG 自己会重试，子站不必急着重发 */
  retryable?: boolean
  /** 实际改了几个设备配置（0 = 与现状一致或重复下发） */
  changed?: number
  /** 这台 EG 不认识、跳过了的规则 id（EG 版本比子站旧）；都认识时不带 */
  ignored?: string[]
}

export interface Applied {
  version: string
  appliedAt: number
  by: string
  hash: string
  thresholds: ThresholdRow[]
  rules: { id: string; on: boolean }[]
  extras: ThresholdExtras
  /** 阶段 A：本柜能力清单（没下发过为 null / 缺省） */
  caps?: CapsConfig | null
  devComm?: DevCommParams | null
}

/** 规则 id（子站 /ext/rules 的 EG-*）→ 本地 TB 的告警类型与级别；alias = 改名前的类型（@lsa/model 的模板还没跟上时照样认） */
export const RULE_ALARM: Record<string, { type: string; severity?: string; alias?: string[] }> = {
  'EG-rise': { type: '过温', severity: 'MAJOR' },
  'EG-rise2': { type: '过温', severity: 'CRITICAL' },
  'EG-tabs': { type: '绝对超温' },
  'EG-pd': { type: '局放异常' },
  'EG-arc': { type: '弧光异常' },
  // 用户 2026-10-08 拍板（§6 第 6 条）：改名「柜内湿度高」，子站缺省下 on:false
  'EG-rh': { type: '柜内湿度高', alias: ['环境'] },
  'EG-ol': { type: '过载' },
  'EG-pm': { type: '烟气' },
  // G4：摄像机区域温差（ir.dmax > dphase 持续 5 min，设备配置 cam_*）
  'EG-dphase': { type: '区域温差' },
  // 下挂设备失联（dev.link == 0，通信类、重要；后端 provision:eg 加规则）
  'EG-devlost': { type: '设备失联' },
}

/** 阈值表外的常量（后端 tb/model.yaml thresholdExtras）；子站没带、本机也没应用过时用 */
const DEFAULT_EXTRAS: ThresholdExtras = { pdCnt: 20, pm25Abs: 75, commPeriods: 5 }

class Invalid extends Error {}

/** 本地 TB 这类依赖暂时没就绪（等一等会好）：连不上、超时、5xx / 408 / 429 */
function transient(e: unknown): boolean {
  if (e instanceof TbHttpError) return e.status >= 500 || e.status === 408 || e.status === 429
  const m = (e as Error)?.message ?? ''
  if (/没有本地 TB 账号/.test(m)) return false
  return true
}

interface Pending {
  body: unknown
  who: { user: string; name: string; ip: string }
  version: string
  since: number
  tries: number
  nextAt: number
  lastError: string
}
const RETRY_MS = [15_000, 30_000, 60_000]

type TbAlarmDef = { id: string; alarmType: string; createRules: Record<string, unknown> }
type TbProfile = { id: { id: string }; name: string; profileData: { alarms: TbAlarmDef[] | null } & Record<string, unknown> } & Record<string, unknown>

@Injectable()
export class ApplyService {
  private readonly log = new Logger('配置下发')
  private readonly file: string
  private applied: Applied | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private readonly pendingFile: string
  private pending: Pending | null = null
  private timer: NodeJS.Timeout | null = null
  /** 调试（EG_DEBUG）：假装本地 TB 没就绪，测 PENDING → 自动应用 */
  debugTbDown = false

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly tb: LocalTbService,
    private readonly bus: BusService,
    private readonly audit: AuditService,
    private readonly caps: CapsService,
  ) {
    this.file = resolve(cfg.dir, 'applied-config.json')
    this.pendingFile = resolve(cfg.dir, 'pending-config.json')
    try {
      if (existsSync(this.file)) this.applied = JSON.parse(readFileSync(this.file, 'utf8')) as Applied
    } catch (e) {
      this.log.warn(`applied-config.json 读不了：${(e as Error).message}`)
    }
    this.caps.set(this.applied?.caps ?? null, this.applied?.devComm ?? null)
    // 上次没应用成的（比如断电重启时本地 TB 还没起来）：接着重试
    try {
      if (existsSync(this.pendingFile)) {
        this.pending = { ...(JSON.parse(readFileSync(this.pendingFile, 'utf8')) as Pending), nextAt: Date.now() + RETRY_MS[0]! }
        this.log.log(`有排着的配置 ${this.pending.version}（${new Date(this.pending.since).toISOString()} 起），本地 TB 就绪后自动应用`)
      }
    } catch (e) {
      this.log.warn(`pending-config.json 读不了：${(e as Error).message}`)
    }
    this.timer = setInterval(() => void this.retryPending(), 5000)
    this.timer.unref?.()
  }

  /** 排着的配置（诊断、本地页用） */
  pendingInfo() {
    const p = this.pending
    return p ? { version: p.version, since: p.since, tries: p.tries, nextAt: p.nextAt, lastError: p.lastError } : null
  }

  private setPending(p: Pending | null): void {
    this.pending = p
    try {
      if (p) writeFileSync(this.pendingFile, JSON.stringify(p), 'utf8')
      else if (existsSync(this.pendingFile)) unlinkSync(this.pendingFile)
    } catch (e) {
      this.log.warn(`pending-config.json 写不了：${(e as Error).message}`)
    }
  }

  private async retryPending(): Promise<void> {
    const p = this.pending
    if (!p || Date.now() < p.nextAt) return
    const r = await this.apply(p.body, p.who, true)
    if (r.status === 'APPLIED') this.log.log(`排着的配置 ${p.version} 已自动应用（排了 ${Math.round((Date.now() - p.since) / 1000)} s、重试 ${p.tries + 1} 次）`)
    else if (r.status === 'FAILED') this.log.warn(`排着的配置 ${p.version} 重试时失败：${r.error}`)
  }

  /** 实际生效的配置版本：应用过就是应用的那一版，否则是 eg.yaml 带来的（部署时的） */
  version(): string | null {
    if (this.applied) return this.applied.version
    const v = this.cfg.eg.attrs['cfg']
    return typeof v === 'string' ? v : null
  }

  summary() {
    const a = this.applied
    const base = a ? { version: a.version, appliedAt: a.appliedAt, by: a.by, rulesOff: a.rules.filter(r => !r.on).map(r => r.id) } : { version: this.version(), appliedAt: null, by: null, rulesOff: [] as string[] }
    return { ...base, pending: this.pendingInfo() }
  }

  /** 一次只应用一份 */
  apply(body: unknown, who: { user: string; name: string; ip: string }, retry = false): Promise<ApplyReceipt> {
    const p = this.chain.then(() => this.settle(body, who, retry))
    this.chain = p.catch(() => undefined)
    return p
  }

  private async settle(body: unknown, who: { user: string; name: string; ip: string }, retry: boolean): Promise<ApplyReceipt> {
    // 重试期间来了新的下发：旧的作废
    if (retry && this.pending?.body !== body) return { version: '', status: 'FAILED', error: '已被新的下发顶替' }
    const r = await this.doApply(body, who, retry)
    if (r.status !== 'PENDING') {
      if (this.pending) this.setPending(null)
      return r
    }
    const old = retry ? this.pending : null
    const tries = (old?.tries ?? -1) + 1
    this.setPending({ body, who, version: r.version, since: old?.since ?? Date.now(), tries, nextAt: Date.now() + RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]!, lastError: r.error ?? '' })
    if (!retry) {
      this.log.warn(`版本 ${r.version} 暂缓：${r.error}（排队，本地 TB 就绪后自动应用）`)
      this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: '应用子站配置', target: r.version, ok: true, detail: `排队：${r.error}` })
    }
    return r
  }

  private async doApply(body: unknown, who: { user: string; name: string; ip: string }, retry = false): Promise<ApplyReceipt> {
    const version = isObj(body) && typeof body['version'] === 'string' ? body['version'] : ''
    const fail = (error: string): ApplyReceipt => {
      this.log.warn(`版本 ${version || '?'} 应用失败：${error}`)
      this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: '应用子站配置', target: version || '?', ok: false, detail: error })
      return { version, status: 'FAILED', error }
    }
    const later = (error: string): ApplyReceipt => ({ version, status: 'PENDING', retryable: true, error: `本地 TB 暂未就绪，已排队自动重试：${error}` })
    let input: { version: string; thresholds: ThresholdRow[]; rules: { id: string; on: boolean }[]; extras: ThresholdExtras; ignored: string[]; caps: CapsConfig | null; devComm: DevCommParams | null }
    try {
      input = this.parse(body)
    } catch (e) {
      if (e instanceof Invalid) return fail(e.message)
      throw e
    }
    // 老版本（没有能力字段）的哈希只算前三样：caps / devComm 都没带时与老哈希一致，升级后同一份配置不会被当成新内容
    const parts: unknown[] = [input.thresholds, input.rules, input.extras]
    if (input.caps || input.devComm) parts.push(input.caps, input.devComm)
    const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
    const ign = input.ignored.length ? { ignored: input.ignored } : {}
    if (input.ignored.length) this.log.warn(`版本 ${input.version}：这台 EG 不认识规则 ${input.ignored.join('、')}（EG 版本比子站旧），跳过，其余照常应用`)
    if (this.applied?.version === input.version && this.applied.hash === hash) {
      // 内容相同的重发：不动本地 TB，但把 cfg 再报一次 —— 子站重发多半是因为它看到的 cfg 不对
      this.bus.publishAttributes(this.cfg.eg.name, { cfg: input.version })
      return { version, status: 'APPLIED', changed: 0, ...ign }
    }
    if (!this.tb.available) return fail('eg.yaml 里没有本地 TB 账号，写不了设备配置')

    // 生成新规则（先全部算好再写，阈值缺项等在这一步就报出来）
    let profiles: TbProfile[]
    const plan: { before: TbProfile; after: TbProfile }[] = []
    try {
      if (this.debugTbDown) throw new Error('调试：假装本地 TB 没就绪')
      const list = await this.tb.get<{ data: { id: { id: string }; name: string }[] }>('/api/deviceProfiles?pageSize=100&page=0')
      profiles = await Promise.all(list.data.filter(p => PROFILES.find(d => d.name === p.name)?.alarms).map(p => this.tb.get<TbProfile>(`/api/deviceProfile/${p.id.id}`)))
    } catch (e) {
      if (transient(e)) return later(`读本地 TB 的设备配置失败：${(e as Error).message}`)
      return fail(`读本地 TB 的设备配置失败：${(e as Error).message}`)
    }
    if (!profiles.length) return fail('本地 TB 上没有带告警规则的设备配置（先跑 provision:eg）')
    for (const p of profiles) {
      const def = PROFILES.find(d => d.name === p.name)!
      let alarms: TbAlarmDef[]
      try {
        alarms = (profileBody(def, { rows: input.thresholds, extras: input.extras }).profileData.alarms ?? []) as TbAlarmDef[]
      } catch (e) {
        return fail(`阈值表不全（设备配置 ${p.name}）：${(e as Error).message}`)
      }
      const next = filterRules(alarms, input.rules)
      if (canon(next) === canon(p.profileData.alarms ?? [])) continue
      plan.push({ before: p, after: { ...p, profileData: { ...p.profileData, alarms: next.length ? next : null } } })
    }

    // 写；失败就把已写的改回去
    const done: TbProfile[] = []
    try {
      for (const x of plan) {
        const saved = await this.tb.req<TbProfile>('POST', '/api/deviceProfile', x.after)
        done.push({ ...x.before, version: saved['version'] })
      }
    } catch (e) {
      for (const b of done) await this.tb.req('POST', '/api/deviceProfile', b).catch(() => undefined)
      if (transient(e)) return later(`写本地 TB 的设备配置失败（已改回）：${(e as Error).message}`)
      return fail(`写本地 TB 的设备配置失败（已改回）：${(e as Error).message}`)
    }

    this.applied = { version: input.version, appliedAt: Date.now(), by: who.name || who.user, hash, thresholds: input.thresholds, rules: input.rules, extras: input.extras, caps: input.caps, devComm: input.devComm }
    writeFileSync(this.file, JSON.stringify(this.applied, null, 2), 'utf8')
    this.caps.set(input.caps, input.devComm)
    // 规则停用 / 类型改名后，没有规则来清的活动告警：清掉
    const typesOf = (ps: TbProfile[]) => new Set(ps.flatMap(x => (x.profileData.alarms ?? []).map(a => a.alarmType)))
    const before = typesOf(profiles)
    const after = typesOf(profiles.map(x => plan.find(y => y.before === x)?.after ?? x))
    const gone = [...before].filter(t => !after.has(t))
    const cleared = gone.length ? await this.clearActive(gone) : 0
    this.bus.publishAttributes(this.cfg.eg.name, { cfg: input.version })
    const off = input.rules.filter(r => !r.on).map(r => r.id)
    const detail = `改了 ${plan.length} 个设备配置${plan.length ? `（${plan.map(x => x.before.name).join('、')}）` : ''}${off.length ? `；停用 ${off.join('、')}` : ''}${input.ignored.length ? `；不认识、跳过 ${input.ignored.join('、')}` : ''}${gone.length ? `；不再有规则的告警类型 ${gone.join('、')}，清掉活动告警 ${cleared} 条` : ''}`
    this.log.log(`版本 ${input.version} 已生效：${detail}`)
    this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: retry ? '应用子站配置（排队后自动）' : '应用子站配置', target: input.version, ok: true, detail })
    return { version: input.version, status: 'APPLIED', changed: plan.length, ...ign }
  }

  /** 本地 TB 上这些类型的活动告警清掉（规则已没了，不清就一直挂着）；失败只记日志，不影响这次应用 */
  private async clearActive(types: string[]): Promise<number> {
    let n = 0
    for (const t of types) {
      try {
        const r = await this.tb.get<{ data: { id: { id: string } }[] }>(`/api/v2/alarms?pageSize=500&page=0&statusList=ACTIVE&typeList=${encodeURIComponent(t)}`)
        for (const a of r.data) {
          await this.tb.req('POST', `/api/alarm/${a.id.id}/clear`)
          n++
        }
      } catch (e) {
        this.log.warn(`清「${t}」的活动告警失败：${(e as Error).message}`)
      }
    }
    return n
  }

  /** 校验请求体（§8.3）：{ version, thresholds: ThresholdRow[], rules: [{ id, on }], devices?, extras?, caps?, capKeys?, devComm? } */
  private parse(b: unknown) {
    if (!isObj(b)) throw new Invalid('请求体要是 JSON 对象')
    const version = b['version']
    if (typeof version !== 'string' || !/^[\w.-]{1,64}$/.test(version)) throw new Invalid('version 要是 1–64 位的字母、数字、. _ -')
    if (!Array.isArray(b['thresholds']) || !b['thresholds'].length) throw new Invalid('thresholds 要是非空数组')
    const num = (v: unknown, where: string) => {
      if (v === null || v === undefined) return null
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Invalid(`${where} 要是不小于 0 的数或 null`)
      return v
    }
    const thresholds: ThresholdRow[] = b['thresholds'].map((r: unknown, i: number) => {
      if (!isObj(r) || typeof r['key'] !== 'string') throw new Invalid(`thresholds[${i}] 缺 key`)
      const k = r['key']
      const s = (x: unknown) => (typeof x === 'string' ? x : '')
      return { key: k, name: s(r['name']), unit: s(r['unit']), note: s(r['note']), mv: num(r['mv'], `${k}.mv`), tr: num(r['tr'], `${k}.tr`), lv: num(r['lv'], `${k}.lv`) }
    })
    const g = this.cfg.cabinet.group
    const val = (k: string) => thresholds.find(r => r.key === k)?.[g] ?? null
    const rise = val('rise')
    const rise2 = val('rise2')
    if (rise !== null && rise2 !== null && rise2 <= rise) throw new Invalid(`温升上上限（${rise2}）要大于上限（${rise}）`)

    const rawRules = b['rules'] ?? []
    if (!Array.isArray(rawRules)) throw new Invalid('rules 要是数组')
    const rules: { id: string; on: boolean }[] = []
    const ignored: string[] = []
    for (const r of rawRules) {
      if (!isObj(r) || typeof r['id'] !== 'string' || typeof r['on'] !== 'boolean') throw new Invalid('rules 每项要是 { id: 字符串, on: 布尔 }')
      // 子站执行的规则（SP-*）与 EG 无关，带了也不管
      if (!r['id'].startsWith('EG-')) continue
      // 不认识的（子站比这台 EG 新）：跳过，回执里列出来，不让整份配置失败
      if (!RULE_ALARM[r['id']]) {
        ignored.push(r['id'])
        continue
      }
      rules.push({ id: r['id'], on: r['on'] })
    }

    let extras = this.applied?.extras ?? DEFAULT_EXTRAS
    if (b['extras'] !== undefined) {
      const e = b['extras']
      if (!isObj(e)) throw new Invalid('extras 要是对象')
      extras = { ...extras }
      for (const k of ['pdCnt', 'pm25Abs', 'commPeriods'] as const) if (e[k] !== undefined) extras[k] = num(e[k], `extras.${k}`) ?? extras[k]
    }

    if (b['devices'] !== undefined) {
      if (!Array.isArray(b['devices'])) throw new Invalid('devices 要是数组')
      const norm = (ds: unknown[]) => JSON.stringify(ds.map(d => (isObj(d) ? [d['name'], d['kind']] : d)).sort())
      if (norm(b['devices']) !== norm(this.cfg.devices as unknown as unknown[])) {
        const now = new Set(this.cfg.devices.map(d => d.name))
        const want = new Set((b['devices'] as { name?: string }[]).map(d => d?.name ?? '?'))
        const add = [...want].filter(n => !now.has(n))
        const del = [...now].filter(n => !want.has(n))
        throw new Invalid(`设备清单与本机不同（${[add.length ? `多 ${add.join('、')}` : '', del.length ? `少 ${del.join('、')}` : ''].filter(Boolean).join('，') || '类型不同'}）：设备清单变更要在子站重新生成 eg.yaml 部署到这台 EG，在线改暂不支持`)
      }
    }
    // 阶段 A：能力清单（本柜那一份）与下挂设备离线判据
    let caps: CapsConfig | null
    try {
      caps = parseCaps(b, this.cfg.cabinet.code)
    } catch (e) {
      throw new Invalid((e as Error).message)
    }
    let devComm: DevCommParams | null = null
    if (b['devComm'] !== undefined) {
      const d = b['devComm']
      if (!isObj(d)) throw new Invalid('devComm 要是对象 { failN, minMs, periods }')
      const pos = (v: unknown, k: string, dflt: number) => {
        if (v === undefined) return dflt
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Invalid(`devComm.${k} 要是正数`)
        return v
      }
      devComm = { failN: pos(d['failN'], 'failN', 5), minMs: pos(d['minMs'], 'minMs', 30_000), periods: pos(d['periods'], 'periods', 5) }
    }
    return { version, thresholds, rules, extras, ignored, caps, devComm }
  }
}

/** 按规则开关去掉停用的告警 / 级别 */
export function filterRules(alarms: TbAlarmDef[], rules: { id: string; on: boolean }[]): TbAlarmDef[] {
  const out: TbAlarmDef[] = []
  for (const a of alarms) {
    const createRules = { ...a.createRules }
    let drop = false
    for (const r of rules) {
      if (r.on) continue
      const m = RULE_ALARM[r.id]
      if (!m || (m.type !== a.alarmType && !m.alias?.includes(a.alarmType))) continue
      if (m.severity) delete createRules[m.severity]
      else drop = true
    }
    if (!drop && Object.keys(createRules).length) out.push({ ...a, createRules })
  }
  return out
}

/** 比较用的规范形：去掉值为 null 的字段、键排序（TB 存进去会补 userValue: null 之类） */
export function canon(v: unknown): string {
  const walk = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(walk)
      : isObj(x)
        ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== null && x[k] !== undefined).map(k => [k, walk(x[k])]))
        : x
  return JSON.stringify(walk(v))
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
