/* 配置下发的 EG 侧（I4，后端库 docs/EG独立TB调整方案.md §2.4、§8.3）。
 *
 *   子站扩展服务 ─PUT /api/config（X-EG-Ticket 服务票据）─► 校验 ─► 写本地 TB 的设备配置（7 类告警规则与阈值）
 *     ─► 回执 { version, status: APPLIED | FAILED, error? } ─► 发 EG 属性 cfg = 实际生效版本（经本地 TB 与上送到子站）
 *
 * 告警规则由后端库 @lsa/model 的同一份代码按阈值表生成（与子站 provision、provision:eg 一致），再按规则开关去掉停用的：
 *   EG-rise / EG-rise2 是「过温」的 MAJOR / CRITICAL 两级，停一级去掉一级，两级都停整条去掉；其余一条规则对应一类告警。
 * 只改本机本来就有的、带告警的设备配置（sam_* / meter / cam_*；0.7.1 起没有 pm_sensor —— PM6 取消，烟雾归 SAM）。写到一半失败把已写的改回去。
 * 生效版本记在配置目录的 applied-config.json（重启后照旧上报；告警事件的 ruleVersion 也取它）。
 * 本地 TB 暂时没就绪（EG 刚开机 TB 还在起、连不上、超时、5xx）：不回 FAILED，回 PENDING（retryable: true），
 *   这份配置落盘（pending-config.json）排队，15 s 起退避到 60 s 自己重试，应用成功后照常更新 cfg 属性（§8.3 的「实际版本」即最终状态）；
 *   配置内容本身的问题（校验不过、阈值表不全、设备清单不同）才回 FAILED。新的一次下发（不论结果）顶替排着的。
 * 不认识的规则 id（子站比这台 EG 新，滚动升级时常见）：跳过、记警告，其余照常应用，回执带 ignored:[…]（§8.3）。
 * 设备清单（devices）在线改暂不支持：与本机 eg.yaml 一致就忽略，不一致回 FAILED（要在子站重新生成 eg.yaml 部署）。
 * 阶段 A（接口 v1.1）：体里另带 caps / capKeys（能力清单，caps/caps.ts）与 devComm（下挂设备离线判据），一并算进内容哈希、
 *   存进 applied-config.json，应用后交给 CapsService；老子站不带 = 全部照旧。
 * 规则停用或告警类型改名（如 EG-rh「环境」→「柜内湿度高」）后，本地 TB 上该类型挂着的活动告警没有规则来清了 ——
 *   写完设备配置后把「之前有、现在没有」的告警类型的活动告警清掉（经钩子 / 对账照常给子站送 CLEARED）。
 *   另在开机后（本地 TB 就绪时）扫一遍：EG 规则的告警类型（含改名前的 alias）在当前设备配置里已经没有、却还挂着的，清掉 ——
 *   子站先升、老 EG 先应用了新配置（老代码不清），再升 EG 时配置没变、不会再走应用（0.10 在 AH12 上验出来的）。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { PROFILES, profileBody, WARMUP_KEY, warmupTypeOf, type ThresholdExtras, type ThresholdRow } from '@lsa/model'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { BusService } from '../bus/bus.service.js'
import { LocalTbService, TbHttpError } from '../tb/local-tb.service.js'
import { offCabsKey, parseCaps, type CapsConfig } from '../caps/caps.js'
import { CapsService, type DevCommParams } from '../caps/caps.service.js'
import { MetersService, parseMeters, type Ratio } from '../meters/meters.service.js'
import { parseGas, type GasParams } from '../warmup/warmup.js'

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
  /** I3（0.4）：APPLIED 时回显各电表实际生效的变比，子站登记「倍率变更」与电表卡显示以它为准 */
  meters?: Record<string, Ratio>
  /** 阶段 A11：请求体里的 requestId 原样带回（老子站不带就没有） */
  requestId?: string
  /** 阶段 A11：FAILED / PENDING 时给机器看的出错码（error 是给人看的） */
  errorCode?: ErrorCode
}

/** 配置回执的出错码（阶段 A11，与子站后端定稿）：
 *   BAD_REQUEST 格式 / 字段不对（含 caps、capKeys、devComm）；BAD_VERSION 版本号不合法；BAD_THRESHOLD 阈值表缺项 / 不合法（如温升上上限 ≤ 上限）；
 *   DEVICES_MISMATCH 设备清单与本机 eg.yaml 不同（要重新生成 eg.yaml 部署）；LOCAL_NOT_READY 本地 TB 暂未就绪（只用于 PENDING，EG 自己重试）；
 *   LOCAL_NOT_CONFIGURED 本机没配本地 TB 账号 / 没 provision（不可重试）；INTERNAL 其余（写本地 TB 失败已改回等）。
 *   UNKNOWN_RULE 保留不用：不认识的规则照旧跳过、列进 ignored。票据错误不在回执里，见 apply.controller.ts 的 401。 */
export type ErrorCode = 'BAD_REQUEST' | 'BAD_VERSION' | 'BAD_THRESHOLD' | 'DEVICES_MISMATCH' | 'LOCAL_NOT_READY' | 'LOCAL_NOT_CONFIGURED' | 'INTERNAL' | 'UNKNOWN_RULE'

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
  /** I3：子站下发的电表变比（没下发为 null / 缺省 —— 用 eg.yaml 的初值） */
  meters?: Record<string, Partial<Ratio>> | null
  /** 0.17：传感器预热参数（extras 里的 gasWarmupS / gasGapS / gasBootWarmupOffCabs；都没带为 null = 缺省） */
  gas?: GasParams | null
  /** 0.7.1：这台 EG 不认识、跳过了的规则的开关（本柜生效后的 { id, on }）。EG 升级后开机重算时按它，不违背子站的开关；
   *  0.7.0 及以前没有这个字段（被跳过的规则开关没记，见 regenRules） */
  ignoredRules?: { id: string; on: boolean }[]
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
  // 0.7.1（舱室方案 v0.9 §10）：独立颗粒物 PM6 取消，烟雾取 SAM 的 smoke.ppm —— 规则 EG-smoke 两级（smoke2 紧急 / smoke 重要，各持续 30 s），
  // 类型仍是「烟气」（北向 SMOKE_HIGH）；气体有预热，@lsa/model 另派生「预热期读数越限（烟气）」。两级一个开关，所以不写 severity
  'EG-smoke': { type: '烟气' },
  // G4：摄像机区域温差（ir.dmax > dphase 持续 5 min，设备配置 cam_*）
  'EG-dphase': { type: '区域温差' },
  // 下挂设备失联（dev.link == 0，通信类、重要；后端 provision:eg 加规则）
  'EG-devlost': { type: '设备失联' },
}

/** 预热期的降级告警（0.17，@lsa/model warmupTypeOf）：带 warmup 的规则多派生一条「预热期读数越限（原类型）」——
 *  规则开关跟着原类型走（停了原规则，降级那支一起去掉） */
export { warmupTypeOf }

/** 安全兜底（0.17，协调要求「dev.warmup_s 缺失时正式告警不能因此不触发」）：
 *  TB 告警条件里的 key 没值时判假 —— 带 warmup 的正式规则（越限 且 dev.warmup_s < 1）在 dev.warmup_s 从没上送时永远不报。
 *  所以凡是设备配置的规则里用到 dev.warmup_s 的，它下面的设备在本地 TB 里**没有**这个值时，预置一条 ts = 1 的 0：
 *  以后真上送的值时刻都比它新、照常生效；从没上送（agent 漏发、eg.yaml 没标 warmup、老配置）时正式那支照常能报。
 *  只在「没有」时预置：已经有值（比如正在预热的 150）时再写 ts = 1 的 0，TB 的告警状态不看时刻、会被它覆盖成「就绪」（一次性 TB 实测，E4）。
 *  调用：应用配置写完设备配置之后、开机清扫时。返回预置了几台 */
export async function seedWarmupKey(tb: { get<T>(path: string): Promise<T>; req<T>(method: string, path: string, body?: unknown): Promise<T> }, profiles: { id: { id: string }; name: string; profileData: { alarms: unknown } }[]): Promise<string[]> {
  const seeded: string[] = []
  for (const p of profiles) {
    if (!JSON.stringify(p.profileData.alarms ?? null).includes(`"${WARMUP_KEY}"`)) continue
    const list = await tb.get<{ data: { id: { id: string }; name: string }[] }>(`/api/tenant/deviceInfos?pageSize=1000&page=0&deviceProfileId=${p.id.id}`)
    for (const d of list.data) {
      // TB 对没有的 key 也回一条 { ts: 现在, value: null }：value 不为 null 才算有
      const have = await tb.get<Record<string, { value: unknown }[]>>(`/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=${encodeURIComponent(WARMUP_KEY)}`)
      if ((have[WARMUP_KEY] ?? []).some(x => x.value !== null && x.value !== undefined)) continue
      await tb.req('POST', `/api/plugins/telemetry/DEVICE/${d.id.id}/timeseries/ANY`, { ts: 1, values: { [WARMUP_KEY]: 0 } })
      seeded.push(d.name)
    }
  }
  return seeded
}

/** 已退役的规则 id：老子站（0.18.0 及以前）还会发，这台 EG 认得、不必列进 ignored（列了会被当成「EG 比子站旧」）—— 直接不管。
 *  EG-pm（PM2.5 越上限）随 PM6 在 0.7.1 取消：它管的「烟气」现在归 EG-smoke，老子站的 EG-pm 开关不能再去动烟雾那条 */
const RETIRED_RULES = new Set(['EG-pm'])

/** 阈值表外的常量（后端 tb/model.yaml thresholdExtras）；子站没带、本机也没应用过时用。
 *  pm25Abs 0.7.1 起不用（PM6 取消）：老子站还带也不存，免得同一份内容因它不同而算成新配置 */
const DEFAULT_EXTRAS: ThresholdExtras = { pdCnt: 20, commPeriods: 5 }

class Invalid extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'BAD_REQUEST',
  ) {
    super(message)
  }
}

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
  /** 开机后的遗留告警清扫做完了没有（本地 TB 没就绪时下一轮再试） */
  private swept = false
  private sweptResolve: () => void = () => undefined
  private readonly sweptP = new Promise<void>(r => (this.sweptResolve = r))
  /** 调试（EG_DEBUG）：假装本地 TB 没就绪，测 PENDING → 自动应用 */
  debugTbDown = false

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly tb: LocalTbService,
    private readonly bus: BusService,
    private readonly audit: AuditService,
    private readonly caps: CapsService,
    private readonly meters: MetersService,
  ) {
    this.file = resolve(cfg.dir, 'applied-config.json')
    this.pendingFile = resolve(cfg.dir, 'pending-config.json')
    try {
      if (existsSync(this.file)) this.applied = JSON.parse(readFileSync(this.file, 'utf8')) as Applied
    } catch (e) {
      this.log.warn(`applied-config.json 读不了：${(e as Error).message}`)
    }
    this.caps.set(this.applied?.caps ?? null, this.applied?.devComm ?? null, this.applied?.gas ?? null)
    this.meters.set(this.applied?.meters ?? null)
    // 上次没应用成的（比如断电重启时本地 TB 还没起来）：接着重试
    try {
      if (existsSync(this.pendingFile)) {
        this.pending = { ...(JSON.parse(readFileSync(this.pendingFile, 'utf8')) as Pending), nextAt: Date.now() + RETRY_MS[0]! }
        this.log.log(`有排着的配置 ${this.pending.version}（${new Date(this.pending.since).toISOString()} 起），本地 TB 就绪后自动应用`)
      }
    } catch (e) {
      this.log.warn(`pending-config.json 读不了：${(e as Error).message}`)
    }
    this.timer = setInterval(() => {
      void this.retryPending()
      if (!this.swept) void this.sweepOnce()
    }, 5000)
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
    if (retry && this.pending?.body !== body) return { version: '', status: 'FAILED', error: '已被新的下发顶替', errorCode: 'INTERNAL' }
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
    // 阶段 A11：requestId 原样带回（字符串、不超过 128 字；别的形状不认、也不因此拒收）
    const rq = isObj(body) ? body['requestId'] : undefined
    const rid = typeof rq === 'string' && rq.length <= 128 ? { requestId: rq } : {}
    const fail = (error: string, errorCode: ErrorCode): ApplyReceipt => {
      this.log.warn(`版本 ${version || '?'} 应用失败（${errorCode}）：${error}`)
      this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: '应用子站配置', target: version || '?', ok: false, detail: `${errorCode}：${error}` })
      return { version, status: 'FAILED', error, errorCode, ...rid }
    }
    const later = (error: string): ApplyReceipt => ({ version, status: 'PENDING', retryable: true, error: `本地 TB 暂未就绪，已排队自动重试：${error}`, errorCode: 'LOCAL_NOT_READY', ...rid })
    let input: { version: string; thresholds: ThresholdRow[]; rules: { id: string; on: boolean }[]; extras: ThresholdExtras; ignored: string[]; ignoredRules: { id: string; on: boolean }[]; caps: CapsConfig | null; devComm: DevCommParams | null; meters: Record<string, Partial<Ratio>> | null; gas: GasParams | null }
    try {
      input = this.parse(body)
    } catch (e) {
      if (e instanceof Invalid) return fail(e.message, e.code)
      throw e
    }
    const hash = configHash(input)
    const ign = input.ignored.length ? { ignored: input.ignored } : {}
    if (input.ignored.length) this.log.warn(`版本 ${input.version}：这台 EG 不认识规则 ${input.ignored.join('、')}（EG 版本比子站旧），跳过，其余照常应用`)
    if (this.applied?.version === input.version && this.applied.hash === hash) {
      // 内容相同的重发：不动本地 TB，但把 cfg 再报一次 —— 子站重发多半是因为它看到的 cfg 不对
      this.bus.publishAttributes(this.cfg.eg.name, { cfg: input.version })
      return { version, status: 'APPLIED', changed: 0, ...ign, ...rid, meters: this.meters.effective() }
    }
    if (!this.tb.available) return fail('eg.yaml 里没有本地 TB 账号，写不了设备配置', 'LOCAL_NOT_CONFIGURED')

    // 生成新规则（先全部算好再写，阈值缺项等在这一步就报出来）
    let profiles: TbProfile[]
    const plan: { before: TbProfile; after: TbProfile }[] = []
    try {
      if (this.debugTbDown) throw new Error('调试：假装本地 TB 没就绪')
      const list = await this.tb.get<{ data: { id: { id: string }; name: string }[] }>('/api/deviceProfiles?pageSize=100&page=0')
      profiles = await Promise.all(list.data.filter(p => PROFILES.find(d => d.name === p.name)?.alarms).map(p => this.tb.get<TbProfile>(`/api/deviceProfile/${p.id.id}`)))
    } catch (e) {
      if (transient(e)) return later(`读本地 TB 的设备配置失败：${(e as Error).message}`)
      return fail(`读本地 TB 的设备配置失败：${(e as Error).message}`, 'INTERNAL')
    }
    if (!profiles.length) return fail('本地 TB 上没有带告警规则的设备配置（先跑 provision:eg）', 'LOCAL_NOT_CONFIGURED')
    try {
      plan.push(...planProfiles(profiles, input))
    } catch (e) {
      if (e instanceof Invalid) return fail(e.message, e.code)
      throw e
    }

    // 写；失败就把已写的改回去
    try {
      await this.writePlan(plan)
    } catch (e) {
      if (transient(e)) return later(`写本地 TB 的设备配置失败（已改回）：${(e as Error).message}`)
      return fail(`写本地 TB 的设备配置失败（已改回）：${(e as Error).message}`, 'INTERNAL')
    }

    this.applied = { version: input.version, appliedAt: Date.now(), by: who.name || who.user, hash, thresholds: input.thresholds, rules: input.rules, extras: input.extras, caps: input.caps, devComm: input.devComm, meters: input.meters, gas: input.gas, ignoredRules: input.ignoredRules }
    writeFileSync(this.file, JSON.stringify(this.applied, null, 2), 'utf8')
    this.caps.set(input.caps, input.devComm, input.gas)
    this.meters.set(input.meters)
    // 规则停用 / 类型改名后，没有规则来清的活动告警：清掉
    const typesOf = (ps: TbProfile[]) => new Set(ps.flatMap(x => (x.profileData.alarms ?? []).map(a => a.alarmType)))
    const before = typesOf(profiles)
    const after = typesOf(profiles.map(x => plan.find(y => y.before === x)?.after ?? x))
    const gone = [...before].filter(t => !after.has(t))
    const cleared = gone.length ? await this.clearActive(gone) : 0
    await this.seedWarmup(profiles.map(x => plan.find(y => y.before === x)?.after ?? x))
    this.bus.publishAttributes(this.cfg.eg.name, { cfg: input.version })
    const off = input.rules.filter(r => !r.on).map(r => r.id)
    const detail = `改了 ${plan.length} 个设备配置${plan.length ? `（${plan.map(x => x.before.name).join('、')}）` : ''}${off.length ? `；停用 ${off.join('、')}` : ''}${input.ignored.length ? `；不认识、跳过 ${input.ignored.join('、')}` : ''}${gone.length ? `；不再有规则的告警类型 ${gone.join('、')}，清掉活动告警 ${cleared} 条` : ''}`
    this.log.log(`版本 ${input.version} 已生效：${detail}`)
    this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: retry ? '应用子站配置（排队后自动）' : '应用子站配置', target: input.version, ok: true, detail })
    return { version: input.version, status: 'APPLIED', changed: plan.length, ...ign, ...rid, meters: this.meters.effective() }
  }

  /** 依次写设备配置；中途失败把已写的改回去、再抛出 */
  private async writePlan(plan: { before: TbProfile; after: TbProfile }[]): Promise<void> {
    const done: TbProfile[] = []
    try {
      for (const x of plan) {
        const saved = await this.tb.req<TbProfile>('POST', '/api/deviceProfile', x.after)
        done.push({ ...x.before, version: saved['version'] })
      }
    } catch (e) {
      for (const b of done) await this.tb.req('POST', '/api/deviceProfile', b).catch(() => undefined)
      throw e
    }
  }

  /** 等开机清扫做完（告警事件开机重发要等它）；本地 TB 一直没就绪就等到 ms 为止 */
  sweepDone(ms: number): Promise<void> {
    return Promise.race([this.sweptP, new Promise<void>(r => setTimeout(r, ms).unref?.())])
  }

  /** 开机清扫（排进应用队列，不与下发并发）：EG 规则的告警类型里，本地设备配置已经没有的，活动告警清掉；
   *  0.7.3：发起设备已经不在本机 eg.yaml 设备清单里的（拆柜后改归别的单元，如 SAM-AH01-A 不再归 EG-AH01-B），活动告警也清掉。
   *  应用新 eg.yaml（apply-config / 拆柜 rebind）以后 agent 会重启，所以也是开机清扫这一步 */
  private sweepOnce(): Promise<void> {
    if (!this.tb.available || this.debugTbDown) return Promise.resolve()
    const p = this.chain.then(async () => {
      if (this.swept) return
      const list = await this.tb.get<{ data: { id: { id: string }; name: string }[] }>('/api/deviceProfiles?pageSize=100&page=0')
      let profiles = await Promise.all(list.data.filter(x => PROFILES.find(d => d.name === x.name)?.alarms).map(x => this.tb.get<TbProfile>(`/api/deviceProfile/${x.id.id}`)))
      if (!profiles.length) return
      profiles = await this.regenerate(profiles)
      await this.seedWarmup(profiles)
      const now = new Set(profiles.flatMap(x => (x.profileData.alarms ?? []).map(a => a.alarmType)))
      const known = new Set(Object.values(RULE_ALARM).flatMap(r => [r.type, ...(r.alias ?? [])]).flatMap(t => [t, warmupTypeOf(t)]))
      const gone = [...known].filter(t => !now.has(t))
      this.swept = true
      const n = gone.length ? await this.clearActive(gone) : 0
      if (n) {
        this.log.log(`开机清扫：规则已停用 / 改名、还挂着的活动告警清掉 ${n} 条（不再有规则的类型 ${gone.join('、')}）`)
        this.audit.write({ user: 'system', name: '配置下发', via: 'system', ip: '-', action: '清除遗留告警', target: gone.join('、'), ok: true, detail: `开机清扫：清掉 ${n} 条` })
      }
      const foreign = await this.clearForeign()
      for (const [dev, k] of foreign) {
        this.log.log(`开机清扫：${dev} 已不归本单元（${this.cfg.unit.code}），还挂着的活动告警清掉 ${k} 条`)
        this.audit.write({ user: 'system', name: '配置下发', via: 'system', ip: '-', action: '清除遗留告警', target: dev, ok: true, detail: `开机清扫：设备不再归本单元 ${this.cfg.unit.code}（不在 eg.yaml 设备清单里），清掉 ${k} 条` })
      }
      this.sweptResolve()
    })
    this.chain = p.catch(() => undefined)
    return p.catch(() => undefined)
  }

  /** 开机按已生效的配置重算一遍告警规则（0.7.1）：EG 升级后 @lsa/model 生成的规则可能变了（如 0.7.1 起 SAM 有 EG-smoke 烟雾两级），
   *  而子站的配置版本没变、不会重发 —— 不重算的话新规则要等子站下一次改阈值才有。重算结果与本地 TB 现有的不同就写进去。
   *  规则开关一律以已生效配置里子站给的为准（regenRules）：当时被跳过的规则 0.7.1 起也记了开关；0.7.0 及以前存的没记，
   *  这些规则保持本地 TB 现状（现在有就算开、没有就算停）—— 不会把子站关掉的告警打开，子站下次下发再以子站为准。
   *  有排着的配置时不动（它应用时会整份重写）；阈值表缺项只记警告；本地 TB 暂时写不进抛出，清扫下一轮再来 */
  private async regenerate(profiles: TbProfile[]): Promise<TbProfile[]> {
    const a = this.applied
    if (!a || this.pending) return profiles
    let plan: { before: TbProfile; after: TbProfile }[]
    try {
      const present = new Set(profiles.flatMap(x => (x.profileData.alarms ?? []).map(y => y.alarmType)))
      const { rules, unknown } = regenRules(a, present)
      if (unknown.length) this.log.log(`开机重算：已生效配置 ${a.version} 是老 EG 存的，没记它当时跳过的规则的开关 —— ${unknown.map(r => `${r.id} 按本地现状${r.on ? '开' : '停'}`).join('、')}，子站下次下发再以子站为准`)
      plan = planProfiles(profiles, { ...a, rules })
    } catch (e) {
      if (!(e instanceof Invalid)) throw e
      this.log.warn(`开机按已生效配置 ${a.version} 重算告警规则失败：${e.message}（等子站下次下发）`)
      return profiles
    }
    if (!plan.length) return profiles
    await this.writePlan(plan)
    const names = plan.map(x => x.before.name).join('、')
    this.log.log(`开机按已生效配置 ${a.version} 重算告警规则：本机程序生成的规则与本地 TB 现有的不同（多半是 EG 刚升级），改了 ${plan.length} 个设备配置（${names}）`)
    this.audit.write({ user: 'system', name: '配置下发', via: 'system', ip: '-', action: '重算告警规则', target: a.version, ok: true, detail: `开机按已生效配置重算：改了 ${names}` })
    return profiles.map(x => plan.find(y => y.before === x)?.after ?? x)
  }

  /** seedWarmupKey 的包装：失败只记日志（不影响应用；开机清扫下次还会再查） */
  private async seedWarmup(profiles: TbProfile[]): Promise<void> {
    try {
      const n = await seedWarmupKey(this.tb, profiles)
      if (n.length) this.log.log(`${n.join('、')} 在本地 TB 里还没有 ${WARMUP_KEY}：预置 0（ts = 1），正式告警不会因缺这个值而不报`)
    } catch (e) {
      this.log.warn(`预置 ${WARMUP_KEY} 失败：${(e as Error).message}`)
    }
  }

  /** 本地 TB 上这些类型的活动告警清掉（规则已没了，不清就一直挂着）；失败只记日志，不影响这次应用 */
  /** 0.7.3：本地 TB 的活动告警里，发起设备不在本机 eg.yaml 设备清单（也不是 EG 自己）的，清掉；返回 设备名 → 条数 */
  private async clearForeign(): Promise<Map<string, number>> {
    const mine = new Set([this.cfg.eg.name, ...this.cfg.devices.map(d => d.name)])
    const out = new Map<string, number>()
    try {
      const r = await this.tb.get<{ data: { id: { id: string }; originatorName?: string }[] }>('/api/v2/alarms?pageSize=500&page=0&statusList=ACTIVE')
      for (const a of r.data) {
        const dev = a.originatorName
        if (!dev || mine.has(dev)) continue
        try {
          await this.tb.req('POST', `/api/alarm/${a.id.id}/clear`)
          out.set(dev, (out.get(dev) ?? 0) + 1)
        } catch (e) {
          this.log.warn(`清 ${dev} 的遗留告警失败：${(e as Error).message}`)
        }
      }
    } catch (e) {
      this.log.warn(`查不归本单元设备的遗留告警失败：${(e as Error).message}`)
    }
    return out
  }

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
    if (typeof version !== 'string' || !/^[\w.-]{1,64}$/.test(version)) throw new Invalid('version 要是 1–64 位的字母、数字、. _ -', 'BAD_VERSION')
    if (!Array.isArray(b['thresholds']) || !b['thresholds'].length) throw new Invalid('thresholds 要是非空数组', 'BAD_THRESHOLD')
    const num = (v: unknown, where: string) => {
      if (v === null || v === undefined) return null
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Invalid(`${where} 要是不小于 0 的数或 null`, 'BAD_THRESHOLD')
      return v
    }
    const thresholds: ThresholdRow[] = b['thresholds'].map((r: unknown, i: number) => {
      if (!isObj(r) || typeof r['key'] !== 'string') throw new Invalid(`thresholds[${i}] 缺 key`, 'BAD_THRESHOLD')
      const k = r['key']
      const s = (x: unknown) => (typeof x === 'string' ? x : '')
      return { key: k, name: s(r['name']), unit: s(r['unit']), note: s(r['note']), mv: num(r['mv'], `${k}.mv`), tr: num(r['tr'], `${k}.tr`), lv: num(r['lv'], `${k}.lv`) }
    })
    const g = this.cfg.cabinet.group
    const val = (k: string) => thresholds.find(r => r.key === k)?.[g] ?? null
    const rise = val('rise')
    const rise2 = val('rise2')
    if (rise !== null && rise2 !== null && rise2 <= rise) throw new Invalid(`温升上上限（${rise2}）要大于上限（${rise}）`, 'BAD_THRESHOLD')

    const rawRules = b['rules'] ?? []
    if (!Array.isArray(rawRules)) throw new Invalid('rules 要是数组')
    const rules: { id: string; on: boolean }[] = []
    const ignored: string[] = []
    const ignoredRules: { id: string; on: boolean }[] = []
    // offCabs 按哪个键看：caps 里有本单元号的键就只看单元号，没有才看柜号（见 offCabsKey）
    const offKey = offCabsKey(b, this.cfg.unit.code, this.cfg.cabinet.code)
    for (const r of rawRules) {
      if (!isObj(r) || typeof r['id'] !== 'string' || typeof r['on'] !== 'boolean') throw new Invalid('rules 每项要是 { id: 字符串, on: 布尔, offCabs?: [柜号] }')
      // v1.2 补：规则全站一份、能力按柜 —— offCabs 里有本柜号就算本柜停用（子站按能力算：能力不是 confirmed 的柜放进来）
      const offCabs = r['offCabs'] ?? []
      if (!Array.isArray(offCabs) || !offCabs.every(x => typeof x === 'string')) throw new Invalid(`rules[${r['id']}].offCabs 要是柜号数组`)
      // 子站执行的规则（SP-*）与 EG 无关，带了也不管
      if (!r['id'].startsWith('EG-') || RETIRED_RULES.has(r['id'])) continue
      // 不认识的（子站比这台 EG 新）：跳过，回执里列出来，不让整份配置失败
      if (!RULE_ALARM[r['id']]) {
        ignored.push(r['id'])
        // 0.7.1：开关也记下（存进 applied-config.json），以后 EG 升级认得它了，开机重算按子站给的开关
        ignoredRules.push({ id: r['id'], on: r['on'] && !offCabs.includes(offKey) })
        continue
      }
      // 存与算哈希的都是本柜生效后的 { id, on }：别的柜进出 offCabs 对本柜不算新内容；不带 offCabs 与老哈希一致
      rules.push({ id: r['id'], on: r['on'] && !offCabs.includes(offKey) })
    }

    // 0.7.0 以前存下的 applied 里可能还有 pm25Abs：只取在用的两项
    let extras: ThresholdExtras = { pdCnt: this.applied?.extras.pdCnt ?? DEFAULT_EXTRAS.pdCnt, commPeriods: this.applied?.extras.commPeriods ?? DEFAULT_EXTRAS.commPeriods }
    let gas = this.applied?.gas ?? null
    if (b['extras'] !== undefined) {
      const e = b['extras']
      if (!isObj(e)) throw new Invalid('extras 要是对象')
      extras = { ...extras }
      for (const k of ['pdCnt', 'commPeriods'] as const) if (e[k] !== undefined) extras[k] = num(e[k], `extras.${k}`) ?? extras[k]
      // 0.17 传感器预热参数：单独存、单独计哈希（extras 只留阈值三项，老配置哈希不变）；都没带 = 缺省
      try {
        gas = parseGas(e)
      } catch (err) {
        throw new Invalid((err as Error).message)
      }
    }

    if (b['devices'] !== undefined) {
      if (!Array.isArray(b['devices'])) throw new Invalid('devices 要是数组')
      const norm = (ds: unknown[]) => JSON.stringify(ds.map(d => (isObj(d) ? [d['name'], d['kind']] : d)).sort())
      if (norm(b['devices']) !== norm(this.cfg.devices as unknown as unknown[])) {
        const now = new Set(this.cfg.devices.map(d => d.name))
        const want = new Set((b['devices'] as { name?: string }[]).map(d => d?.name ?? '?'))
        const add = [...want].filter(n => !now.has(n))
        const del = [...now].filter(n => !want.has(n))
        throw new Invalid(`设备清单与本机不同（${[add.length ? `多 ${add.join('、')}` : '', del.length ? `少 ${del.join('、')}` : ''].filter(Boolean).join('，') || '类型不同'}）：设备清单变更要在子站重新生成 eg.yaml 部署到这台 EG，在线改暂不支持`, 'DEVICES_MISMATCH')
      }
    }
    // 阶段 A：能力清单（本柜那一份）与下挂设备离线判据
    let caps: CapsConfig | null
    try {
      caps = parseCaps(b, [this.cfg.unit.code, this.cfg.cabinet.code])
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
    let meters: Record<string, Partial<Ratio>> | null
    try {
      meters = parseMeters(b['meters'], [this.cfg.unit.code, this.cfg.cabinet.code], this.meters.names)
    } catch (e) {
      throw new Invalid((e as Error).message)
    }
    return { version, thresholds, rules, extras, ignored, ignoredRules, caps, devComm, meters, gas }
  }
}

/** 配置内容哈希（判重复下发）。老版本（没有能力字段）的哈希只算前三样：caps / devComm 都没带时与老哈希一致，
 *  升级后同一份配置不会被当成新内容；meters（I3）、gas（0.17 预热参数）也是带了才计进去 */
export function configHash(i: { thresholds: unknown; rules: unknown; extras: unknown; caps: unknown; devComm: unknown; meters: unknown; gas: unknown; ignoredRules?: { id: string; on: boolean }[] }): string {
  const parts: unknown[] = [i.thresholds, i.rules, i.extras]
  if (i.caps || i.devComm) parts.push(i.caps, i.devComm)
  if (i.meters) parts.push({ meters: i.meters })
  if (i.gas) parts.push({ gas: i.gas })
  // 0.7.1：被跳过的规则的开关也算内容（子站只改了它也要重新记下）；没有被跳过的与老哈希一致
  if (i.ignoredRules?.length) parts.push({ ignoredRules: i.ignoredRules })
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

/** 开机重算用的规则开关（0.7.1，协调 10-20）：以已生效配置里子站给的为准 ——
 *   1. rules（当时认得的）与 ignoredRules（当时跳过的，0.7.1 起才记）里有的，照它的 on；
 *   2. 都没有的：已生效配置是 0.7.1 起存的（有 ignoredRules 字段）= 子站根本没发这条，按缺省开；
 *      是 0.7.0 及以前存的（没有这个字段）= 可能被跳过了、开关没记，不知道 —— 保持本地 TB 现状（presentTypes 里有这条的告警类型算开，没有算停），
 *      免得把子站关掉的告警（如 EG-pm 关、迁成 EG-smoke 关）重新打开。unknown 列出这一类，给日志用 */
export function regenRules(a: Pick<Applied, 'rules' | 'ignoredRules'>, presentTypes: ReadonlySet<string>): { rules: { id: string; on: boolean }[]; unknown: { id: string; on: boolean }[] } {
  const given = [...a.rules, ...(a.ignoredRules ?? [])]
  const ids = new Set(given.map(r => r.id))
  const missing = Object.keys(RULE_ALARM).filter(id => !ids.has(id))
  if (a.ignoredRules) return { rules: given, unknown: [] }
  const unknown = missing.map(id => {
    const m = RULE_ALARM[id]!
    return { id, on: [m.type, ...(m.alias ?? [])].some(t => presentTypes.has(t)) }
  })
  return { rules: [...given, ...unknown], unknown }
}

/** 按阈值表与规则开关算本地 TB 各设备配置的告警规则，只列出与现有不同的；阈值表缺项抛 Invalid（BAD_THRESHOLD） */
function planProfiles(profiles: TbProfile[], input: { thresholds: ThresholdRow[]; rules: { id: string; on: boolean }[]; extras: ThresholdExtras }): { before: TbProfile; after: TbProfile }[] {
  const plan: { before: TbProfile; after: TbProfile }[] = []
  for (const p of profiles) {
    const def = PROFILES.find(d => d.name === p.name)!
    let alarms: TbAlarmDef[]
    try {
      alarms = (profileBody(def, { rows: input.thresholds, extras: input.extras }).profileData.alarms ?? []) as TbAlarmDef[]
    } catch (e) {
      throw new Invalid(`阈值表不全（设备配置 ${p.name}）：${(e as Error).message}`, 'BAD_THRESHOLD')
    }
    const next = filterRules(alarms, input.rules)
    if (canon(next) === canon(p.profileData.alarms ?? [])) continue
    plan.push({ before: p, after: { ...p, profileData: { ...p.profileData, alarms: next.length ? next : null } } })
  }
  return plan
}

/** 按规则开关去掉停用的告警 / 级别。预热期的降级那支（「预热期读数越限（原类型）」，只有 WARNING 一级）跟着原类型：
 *  原类型整条停用（或分级的各级都停了）就一起去掉 */
export function filterRules(alarms: TbAlarmDef[], rules: { id: string; on: boolean }[]): TbAlarmDef[] {
  const out: TbAlarmDef[] = []
  const typeOf = (m: { type: string; alias?: string[] }) => [m.type, ...(m.alias ?? [])]
  for (const a of alarms) {
    const createRules = { ...a.createRules }
    let drop = false
    const base = Object.values(RULE_ALARM).flatMap(typeOf).find(t => warmupTypeOf(t) === a.alarmType)
    if (base !== undefined) {
      // 降级那支：管这个类型的规则全停了才去掉
      const ids = Object.keys(RULE_ALARM).filter(id => typeOf(RULE_ALARM[id]!).includes(base))
      const off = new Set(rules.filter(r => !r.on).map(r => r.id))
      if (ids.length && ids.every(id => off.has(id))) continue
      out.push({ ...a, createRules })
      continue
    }
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
