/* 质量码看护（接入规范 §6.7，开发计划 §6.1）。
 *
 * 同事的转换程序只管发读数；某个量没按周期来，由这里标出来，写进该设备的遥测 key `q`（字符串化 JSON，只列非有效的量）：
 *   超过 3 个周期没来            → stale（陈旧）
 *   超过 max(30 s, 5 个周期)没来 → invalid（无效）
 * 周期取点表目录（@lsa/points 的 catalog = 规范 §6）。按 agent 收到的时刻判，不按设备时间戳（设备时钟可能偏）。
 *
 * 同事若自己也发了 q（他知道哪个传感器坏了），与看护的结果合并后再发 —— 否则两边的 q 互相覆盖。
 * 一台设备的必有量全部 invalid = 整台失效，EG 状态降级（eg.state=degraded，由 SelfService 发）；
 * 同一判据另发 dev.link（1 在线 / 0 失联，与 q 同发、每分钟重发）—— EG 本地 TB 按它出「设备失联」告警（§8 dev.link）。
 * 派生量（el.load_pct）跟随它的输入：三相电流有一相不有效，负荷率同样标。
 *
 * q 变化时立即发，另外每分钟重发一次（恢复后发 "{}"，子站据此清掉标记）。
 *
 * 阶段 A（接口 v1.1，V3.0 §13）：
 *   - q 另有转换程序给的 warmup / calibrating（透传、合并），合并优先级 invalid > calibrating / warmup > stale（同一个 key 取高的）
 *   - 每台下挂设备另发 dev.comm：ONLINE / DEGRADED（有数据但 q 里有非正常项）/ OFFLINE / UNKNOWN（agent 刚起、≤ 30 s）
 *     dev.last_ok：转换程序报了用它的，否则按 agent 收到测量值的时刻；dev.last_try / dev.err / dev.fails 转换程序报了原样转发
 *     （它们本来就随它的遥测走），没报时 EG 兜底：fails = 错过的周期数 floor(距 last_ok / 周期) - 1（正常到达的抖动不算失败），err 在 fails > 0 时为 TIMEOUT、恢复清空，last_try 不发
 *   - 离线判据：fails ≥ failN 且距 last_ok > max(minMs, periods × 周期)（参数随配置下发 devComm，缺省 5 / 30000 / 5）；
 *     0.17 起另加一条：这台设备最近 max(30 s, 5 个周期) 内还有测量值到达，就最多 DEGRADED、不判 OFFLINE
 *     （转换程序按「fails 取最大、last_ok 取最早」汇总一个设备名下几路传感器后，一路坏了不能把整台判成离线）；
 *     dev.link 保留 = dev.comm != OFFLINE（本地「设备失联」规则照旧按它判）
 *   - 能力全都不启用的设备（caps）不发 dev.*（上送那边也整台不送）
 *   - q / dev.comm / dev.link 变了立即发，dev.last_ok / fails / err 随每分钟那一次
 *
 * 0.17 传感器预热（docs/气体传感器预热方案.md v2，WarmupService）：
 *   - 需要预热的设备：预热中它的量在 q 里标 warmup；另发 dev.warmup_s（剩余秒数，0 = 就绪）：启动后第一次评估就发（哪怕是 0）、
 *     进出预热立即发、预热中每 10 s、就绪后随每分钟那一次 —— 本地规则带 warmup 的按它分正式 / 降级两支，没有这个值正式那支永远不触发
 *   - 转换程序标了 warmup（T1，型号自报）时 dev.warmup_s 至少报 1
 *   - 每收到这台设备的一条读数，马上补发一条同一时刻的 dev.warmup_s（读数是转换程序发的，agent 改不了那条消息；
 *     上送子站那边 UplinkService 直接并进同一行）；本地 TB 从没收到过的另由 ApplyService 预置 0（seedWarmupKey）
 *   - 转换程序发的 q 加新鲜度窗口（同 dev.*：max(minMs, periods × 周期) × 2）：转换程序挂了以后不会永远停在它最后报的状态
 *
 * 0.6.2 预期测点（全链路联调 W1 / W2，ConvExpectService）：
 *   - 转换程序配置里有传感器挂这台设备时，必有量 = 它们的 key（不再按物模型全量）；判离线的周期取这些量里最快的
 *   - 不在预期里的量：没来过不看护；来过的（传感器改挂别处以后旧设备上留下的）照常过期成 stale / invalid 写进 q，
 *     子站据此给最后值打标记（W2），但不算进 dev.comm（DEGRADED 只看预期测点和转换程序自己报的）
 *
 * 0.7.3（子站 0.18.3，现场 AH01-B）：「必有」另看本单元能力 —— 这个量对应的能力不是 confirmed（pending 待定 / unsupported 不支持）时，
 *   没来过不算缺（来过的照常看护）。以前地电波改成「不支持」以后 SAM-AH01-B 还是一直 DEGRADED（q 里 tev.amp invalid 上送子站）。
 *   与检查工具 lsa_check 1.2 --applied 同一口径（子站 0.18.3 起地电波、SAM 红外的全局缺省改回 pending，S19 由本站模型声明 confirmed） */
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { expectedPeriodMs, pointsOf } from '@lsa/points'
import { CAM_MAX_REGIONS, camRegionLimit, type EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { BusService, type Entry } from '../bus/bus.service.js'
import { CapsService } from '../caps/caps.service.js'
import { WarmupService } from '../warmup/warmup.service.js'
import { warmupScope } from '../warmup/warmup.js'
import { ConvExpectService } from '../conv/conv-expect.service.js'

export type Quality = 'stale' | 'invalid'
export type Comm = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN'

/** 同一个 key 几个来源都标了时取高的：invalid > calibrating / warmup（及转换程序的其它值）> stale */
const RANK: Record<string, number> = { invalid: 3, stale: 1 }
const rank = (q: string | undefined) => (q ? (RANK[q] ?? 2) : 0)
/** agent 刚起、某台设备还一条都没收到时报 UNKNOWN 的最长时间 */
const UNKNOWN_MS = 30_000

interface Watch {
  period: number
  optional: boolean
  /** 没来过也算缺：有预期测点时 = 在预期里，否则 = 物模型里不是可选量 */
  required: boolean
  /** agent 最近一次收到的时刻；从没收到过则为 agent 启动时刻（启动后留出等第一批数据的时间） */
  lastAt: number
  seen: boolean
}

interface DeviceWatch {
  keys: Map<string, Watch>
  /** 同事自己发的 q */
  fromSource: Record<string, string>
  /** 同事的 q 最近一次来的时刻（新鲜度窗口外就不算数） */
  fromSourceAt: number
  /** agent 自己算的派生量标的（跨设备的输入：区域温升要看 SAM 的 env.t，DeriveService 标） */
  derived: Record<string, string>
  /** 上一次发出去的 q（JSON） */
  published: string | null
  /** 上一次发出去的 dev.link */
  link: 0 | 1 | null
  /** 上一次发出去的 dev.comm */
  comm: Comm | null
  publishedAt: number
  /** 上一次发出去的 dev.warmup_s（不是需要预热的设备一直是 null） */
  warm: number | null
  /** 哪些量归预热管（warmupScope：SAM 只有 smoke.*） */
  warmScope: (key: string) => boolean
  warmAt: number
  /** 判离线用的周期：必有量里最快的（没有必有量取全部里最快的） */
  period: number
  /** 转换程序配置推出的预期测点（null = 按物模型全量） */
  expect: ReadonlySet<string> | null
}

/** 派生量 → 它的输入（摄像机测温区按上限 R1–R12 全列，没配的区不看护、自然不影响结果；I18） */
const REGION_MAXES = Array.from({ length: CAM_MAX_REGIONS }, (_, i) => `ir.R${i + 1}.max`)
const DERIVED: Record<string, string[]> = {
  'el.load_pct': ['el.Ia', 'el.Ib', 'el.Ic'],
  // 摄像机区域测温（G4 摄像机测温约定 §3、§5）：温升还依赖 env.t（跨设备，由 DeriveService 另标），这里只跟随本设备的输入
  ...Object.fromEntries(REGION_MAXES.map((k, i) => [`ir.R${i + 1}.rise`, [k]])),
  'ir.dmax': REGION_MAXES,
  // §8.6 补充的汇总量（本地规则按它们判）
  'ir.rise': REGION_MAXES,
  'ir.rmax': REGION_MAXES,
  'ir.hot': REGION_MAXES,
}
/** 点目录展开用的测温区：本柜配了几个就展开几个（都按矩形区；point 区的 .pt 来过才看护，同 R1–R3 时的做法） */
const camRegions = (attrs: Record<string, unknown>) => Object.fromEntries(Array.from({ length: camRegionLimit(attrs) }, (_, i) => [`R${i + 1}`, 'region' as const]))
const EVAL_MS = 2_000
const REPUBLISH_MS = 60_000
/** 预热中 dev.warmup_s 的重发间隔 */
const WARM_REPUBLISH_MS = 10_000

@Injectable()
export class QualityService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('质量码')
  private readonly devices = new Map<string, DeviceWatch>()
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly bus: BusService,
    private readonly caps: CapsService,
    private readonly warmup: WarmupService,
    @Optional() private readonly expect?: ConvExpectService,
  ) {
    for (const d of cfg.devices) {
      // 0.7.1：pm（PM6）已取消，老 eg.yaml 里还挂着也不看护（转换程序不读它，看护了只会一直判失联）
      if (d.kind === 'eg' || d.kind === 'pm') continue
      const keys = new Map<string, Watch>()
      for (const p of pointsOf(d.kind, cfg.cabinet.group, d.kind === 'camera' ? camRegions(d.attrs) : true)) {
        // I6（0.4）：按点目录的期望周期（局放 us.* / tev.* / uhf.* 是 3 s，装置 3 s 才刷新一次），没写的按 fast / slow 档
        const ms = expectedPeriodMs(p)
        // 事件型（弧光脉冲）不按周期看护；派生量跟随输入，不单独看护
        if (ms === null || p.key in DERIVED) continue
        keys.set(p.key, { period: ms, optional: !!p.optional, required: !p.optional, lastAt: this.startedAt, seen: false })
      }
      const dw: DeviceWatch = { keys, fromSource: {}, fromSourceAt: 0, derived: {}, published: null, link: null, comm: null, publishedAt: 0, warm: null, warmAt: 0, warmScope: warmupScope(d.kind), period: 60_000, expect: null }
      this.applyExpect(d.name, dw)
      this.devices.set(d.name, dw)
    }
  }

  /** 按预期测点定每个量是不是必有、判离线的周期 */
  private applyExpect(name: string, d: DeviceWatch): void {
    const e = this.expect?.expected(name) ?? null
    // 预期里一个能看护的量都没有（比如只配了物模型外的 key）：还是按全量
    d.expect = e && [...d.keys.keys()].some(k => e.has(k)) ? e : null
    // 0.7.3：能力不是 confirmed 的量（待定 / 不支持）没来过不算缺
    const capOk = (k: string) => {
      const st = this.caps.keyState(name, k)
      return st === null || st === 'confirmed'
    }
    for (const [k, w] of d.keys) w.required = (d.expect ? d.expect.has(k) : !w.optional) && capOk(k)
    const must = [...d.keys.values()].filter(w => w.required).map(w => w.period)
    d.period = Math.min(...(must.length ? must : [...d.keys.values()].map(w => w.period)), 60_000)
  }

  onModuleInit(): void {
    const reapply = () => {
      for (const [name, d] of this.devices) this.applyExpect(name, d)
      this.evaluate()
    }
    this.expect?.onChange(reapply)
    // 0.7.3：能力清单变了（子站改了 confirmed / pending / unsupported）也重算必有量
    this.caps.onChange(reapply)
    this.bus.onTelemetry((dev, entries, own) => this.take(dev, entries, own))
    this.timer = setInterval(() => this.evaluate(), EVAL_MS)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** DeriveService 标派生量出不来的原因（null = 恢复）；变了马上重发 q */
  setDerived(device: string, key: string, q: Quality | null): void {
    const d = this.devices.get(device)
    if (!d || (d.derived[key] ?? null) === q) return
    if (q) d.derived[key] = q
    else delete d.derived[key]
    this.evaluate(device)
  }

  /** 某设备当前的质量码（合并后），本地页与状态接口用 */
  qualityOf(device: string, now = Date.now()): Record<string, string> {
    const d = this.devices.get(device)
    if (!d) return {}
    const out: Record<string, string> = {}
    const put = (k: string, q: string) => {
      if (rank(q) > rank(out[k])) out[k] = q
    }
    if (this.sourceFresh(d, now)) for (const [k, q] of Object.entries(d.fromSource)) put(k, q)
    for (const [k, q] of Object.entries(d.derived)) put(k, q)
    // 0.17：预热中，这台设备的量都标 warmup（可选量来过才标）
    // 0.7.1：SAM 只有气体那路（smoke.*）标，局放、温湿度不受预热影响（warmupScope）
    if (this.warmup.remaining(device, now) > 0) for (const [k, w] of d.keys) if ((w.seen || w.required) && d.warmScope(k)) put(k, 'warmup')
    for (const [key, w] of d.keys) {
      const q = judge(w, now)
      if (q) put(key, q)
    }
    for (const [derived, inputs] of Object.entries(DERIVED)) {
      if (!d.keys.has(inputs[0]!)) continue
      const worst = inputs.map(k => out[k]).find(q => q === 'invalid') ?? inputs.map(k => out[k]).find(Boolean)
      if (worst) out[derived] = worst
    }
    return out
  }

  /** 转换程序的 q 还算不算数（窗口同 dev.*） */
  private sourceFresh(d: DeviceWatch, now: number): boolean {
    const p = this.caps.devComm
    return now - d.fromSourceAt <= Math.max(p.minMs, p.periods * d.period) * 2
  }

  /** 0.17：要报的 dev.warmup_s（不是需要预热的设备返回 null）：agent 判的剩余秒数；转换程序标了 warmup 时至少 1 */
  warmupOf(device: string, now = Date.now()): number | null {
    if (!this.warmup.has(device)) return null
    // 0.7.1（D4）：预热时长 0 = 不做预热 —— 转换程序自报 warmup 也不抬成 1，一直报 0（q 里转换程序标的 warmup 照旧显示）
    if (this.warmup.seconds(device) === 0) return 0
    const r = this.warmup.remaining(device, now)
    const d = this.devices.get(device)
    const src = !!d && this.sourceFresh(d, now) && Object.values(d.fromSource).includes('warmup')
    return src ? Math.max(r, 1) : r
  }

  /** 整台失效的设备（dev.comm = OFFLINE；能力不启用的不算） */
  deadDevices(now = Date.now()): string[] {
    const out: string[] = []
    for (const name of this.devices.keys()) if (this.caps.deviceEnabled(name) && this.commOf(name, now).comm === 'OFFLINE') out.push(name)
    return out
  }

  /** 某台设备的通信状态（§13）；本地页与状态接口也用 */
  commOf(device: string, now = Date.now()): { comm: Comm; lastOk: number | null; fails: number; err: string; fromSource: { lastOk: boolean; fails: boolean; err: boolean } } {
    const d = this.devices.get(device)
    if (!d) return { comm: 'UNKNOWN', lastOk: null, fails: 0, err: '', fromSource: { lastOk: false, fails: false, err: false } }
    const p = this.caps.devComm
    const tel = this.bus.live.get(device)?.telemetry ?? {}
    // 转换程序报的（不是 agent 自己发的）：窗口内来过才算数
    const fresh = Math.max(p.minMs, p.periods * d.period) * 2
    const src = (k: string) => {
      const l = tel[k]
      return l && !l.own && now - l.at <= fresh ? l.v : undefined
    }
    const sLastOk = src('dev.last_ok')
    const sFails = src('dev.fails')
    const sErr = src('dev.err')
    const seen = [...d.keys.values()].filter(w => w.seen).map(w => w.lastAt)
    const lastOk = typeof sLastOk === 'number' ? sLastOk : seen.length ? Math.max(...seen) : null
    const since = lastOk ?? this.startedAt
    const fails = typeof sFails === 'number' ? sFails : Math.max(0, Math.floor((now - since) / d.period) - 1)
    const err = typeof sErr === 'string' ? sErr : fails > 0 ? 'TIMEOUT' : ''
    // 0.17：转换程序按「fails 取最大、last_ok 取最早」把一个设备名下几路传感器的 dev.* 汇总以后，一路坏了整台看起来就像离线；
    // 这台设备最近 max(30 s, 5 个周期) 内还有测量值到达 → 最多判 DEGRADED，不判 OFFLINE（dev.link 仍是 1，不出「设备失联」）
    const alive = [...d.keys.values()].some(w => w.seen && now - w.lastAt <= Math.max(30_000, 5 * w.period))
    const failing = fails >= p.failN && now - since > Math.max(p.minMs, p.periods * d.period)
    let comm: Comm
    if (lastOk === null && now - this.startedAt < UNKNOWN_MS) comm = 'UNKNOWN'
    else if (failing && !alive) comm = 'OFFLINE'
    // 有预期测点时只看预期里的量（旧设备上留下的量照常进 q，但不让这台一直 DEGRADED，W1 / W2）
    else comm = failing || Object.keys(this.qualityOf(device, now)).some(k => !d.expect || d.expect.has(k)) ? 'DEGRADED' : 'ONLINE'
    return { comm, lastOk, fails, err, fromSource: { lastOk: sLastOk !== undefined, fails: sFails !== undefined, err: sErr !== undefined } }
  }

  private take(device: string, entries: Entry[], own: boolean): void {
    if (own) return
    const d = this.devices.get(device)
    if (!d) return
    const now = Date.now()
    let sourceQChanged = false
    let measured = false
    let gas = false
    for (const e of entries) {
      for (const [k, v] of Object.entries(e.values)) {
        if (k === 'q') {
          const parsed = parseQ(v)
          // 过了新鲜度窗口又来了同样的 q：也算变化（窗口外它已经不算数了）
          if (JSON.stringify(parsed) !== JSON.stringify(d.fromSource) || !this.sourceFresh(d, now)) sourceQChanged = true
          d.fromSource = parsed
          d.fromSourceAt = now
          continue
        }
        if (!k.startsWith('dev.')) {
          measured = true
          if (d.warmScope(k)) gas = true
        }
        const w = d.keys.get(k)
        // 可选量（分区测温）与目录外的量：来过才看护
        if (!w) continue
        w.lastAt = now
        w.seen = true
      }
    }
    // 0.17：读到测量值，交给预热计时（T2 读数中断后恢复、T3 开机后第一次读到）；进了预热马上发
    // （0.7.1：SAM 只看气体那路的读数 —— 局放照常到、气体断了也要算中断）
    const warmed = gas && this.warmup.read(device, now)
    // 每条读数后补发同一时刻的 dev.warmup_s（evaluate 的定时发照旧）
    if (measured && this.caps.deviceEnabled(device)) {
      const ws = this.warmupOf(device, now)
      if (ws !== null) {
        this.bus.publish(device, { 'dev.warmup_s': ws }, Math.max(...entries.map(e => e.ts)))
        if (!warmed) {
          d.warm = ws
          d.warmAt = now
        }
      }
    }
    if (sourceQChanged || warmed) this.evaluate(device)
  }

  private evaluate(only?: string): void {
    const now = Date.now()
    for (const [name, d] of this.devices) {
      if (only && name !== only) continue
      const q = JSON.stringify(sortKeys(this.qualityOf(name, now)))
      const enabled = this.caps.deviceEnabled(name)
      const c = this.commOf(name, now)
      const link = c.comm === 'OFFLINE' ? 0 : 1
      const ws = enabled ? this.warmupOf(name, now) : null
      const warmDue = ws !== null && (d.warm === null || ws > 0 !== d.warm > 0 || (ws > 0 && now - d.warmAt >= WARM_REPUBLISH_MS))
      if (q === d.published && link === d.link && c.comm === d.comm && now - d.publishedAt < REPUBLISH_MS && !warmDue) continue
      if (ws !== null && d.warm !== null && ws > 0 !== d.warm > 0) this.log.log(`${name} ${ws > 0 ? (this.warmup.waiting(name, now) ? `读数一回来就要预热（读数中断已满 ${this.caps.gas.gapS} s 或主机刚开机），先报 ${ws} s` : `预热中（剩 ${ws} s）`) : '预热结束，读数可信'}`)
      if (link !== d.link && d.link !== null) this.log.log(`${name} ${link ? '恢复在线' : '整台失效（dev.link = 0）'}`)
      if (c.comm !== d.comm && d.comm !== null) this.log.log(`${name} 通信状态 ${d.comm} → ${c.comm}（fails ${c.fails}${c.err ? `、${c.err}` : ''}）`)
      if (q !== d.published) {
        const n = Object.keys(JSON.parse(q)).length
        if (d.published !== null || n) this.log.log(`${name} 质量码 ${n ? q : '全部有效'}`)
      }
      const values: Record<string, unknown> = { q }
      if (enabled) {
        values['dev.link'] = link
        values['dev.comm'] = c.comm
        // 转换程序报了的不替它发（它的值随它自己的遥测已经走了）
        if (!c.fromSource.lastOk && c.lastOk !== null) values['dev.last_ok'] = c.lastOk
        if (!c.fromSource.fails) values['dev.fails'] = c.fails
        if (!c.fromSource.err) values['dev.err'] = c.err
        if (ws !== null) {
          values['dev.warmup_s'] = ws
          d.warm = ws
          d.warmAt = now
        }
      }
      this.bus.publish(name, values, now)
      d.published = q
      d.link = link
      d.comm = c.comm
      d.publishedAt = now
    }
  }
}

function judge(w: Watch, now: number): Quality | null {
  // 不是必有的量（可选量、不在预期测点里的量）没来过不算缺
  if (!w.required && !w.seen) return null
  const age = now - w.lastAt
  if (age > Math.max(30_000, 5 * w.period)) return 'invalid'
  if (age > 3 * w.period) return 'stale'
  return null
}

function parseQ(v: unknown): Record<string, string> {
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, string>
    } catch {
      /* 不是 JSON 就当没有 */
    }
    return {}
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}
