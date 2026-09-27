/* 配置下发的 EG 侧（I4，后端库 docs/EG独立TB调整方案.md §2.4、§8.3）。
 *
 *   子站扩展服务 ─PUT /api/config（X-EG-Ticket 服务票据）─► 校验 ─► 写本地 TB 的设备配置（7 类告警规则与阈值）
 *     ─► 回执 { version, status: APPLIED | FAILED, error? } ─► 发 EG 属性 cfg = 实际生效版本（经本地 TB 与上送到子站）
 *
 * 告警规则由后端库 @lsa/model 的同一份代码按阈值表生成（与子站 provision、provision:eg 一致），再按规则开关去掉停用的：
 *   EG-rise / EG-rise2 是「过温」的 MAJOR / CRITICAL 两级，停一级去掉一级，两级都停整条去掉；其余一条规则对应一类告警。
 * 只改本机本来就有的、带告警的设备配置（sam_* / meter / pm_sensor）。写到一半失败把已写的改回去。
 * 生效版本记在配置目录的 applied-config.json（重启后照旧上报；告警事件的 ruleVersion 也取它）。
 * 设备清单（devices）在线改暂不支持：与本机 eg.yaml 一致就忽略，不一致回 FAILED（要在子站重新生成 eg.yaml 部署）。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { PROFILES, profileBody, type ThresholdExtras, type ThresholdRow } from '@lsa/model'
import type { EgConfig } from '@lsa-eg/config'
import { EG_CONFIG } from '../config.js'
import { AuditService } from '../audit/audit.service.js'
import { BusService } from '../bus/bus.service.js'
import { LocalTbService } from '../tb/local-tb.service.js'

export interface ApplyReceipt {
  version: string
  status: 'APPLIED' | 'FAILED'
  error?: string
  /** 实际改了几个设备配置（0 = 与现状一致或重复下发） */
  changed?: number
}

export interface Applied {
  version: string
  appliedAt: number
  by: string
  hash: string
  thresholds: ThresholdRow[]
  rules: { id: string; on: boolean }[]
  extras: ThresholdExtras
}

/** 规则 id（子站 /ext/rules 的 EG-*）→ 本地 TB 的告警类型与级别 */
export const RULE_ALARM: Record<string, { type: string; severity?: string }> = {
  'EG-rise': { type: '过温', severity: 'MAJOR' },
  'EG-rise2': { type: '过温', severity: 'CRITICAL' },
  'EG-tabs': { type: '绝对超温' },
  'EG-pd': { type: '局放异常' },
  'EG-arc': { type: '弧光异常' },
  'EG-rh': { type: '环境' },
  'EG-ol': { type: '过载' },
  'EG-pm': { type: '烟气' },
  // G4：摄像机区域温差（ir.dmax > dphase 持续 5 min，设备配置 cam_*）
  'EG-dphase': { type: '区域温差' },
}

/** 阈值表外的常量（后端 tb/model.yaml thresholdExtras）；子站没带、本机也没应用过时用 */
const DEFAULT_EXTRAS: ThresholdExtras = { pdCnt: 20, pm25Abs: 75, commPeriods: 5 }

class Invalid extends Error {}

type TbAlarmDef = { id: string; alarmType: string; createRules: Record<string, unknown> }
type TbProfile = { id: { id: string }; name: string; profileData: { alarms: TbAlarmDef[] | null } & Record<string, unknown> } & Record<string, unknown>

@Injectable()
export class ApplyService {
  private readonly log = new Logger('配置下发')
  private readonly file: string
  private applied: Applied | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    @Inject(EG_CONFIG) private readonly cfg: EgConfig,
    private readonly tb: LocalTbService,
    private readonly bus: BusService,
    private readonly audit: AuditService,
  ) {
    this.file = resolve(cfg.dir, 'applied-config.json')
    try {
      if (existsSync(this.file)) this.applied = JSON.parse(readFileSync(this.file, 'utf8')) as Applied
    } catch (e) {
      this.log.warn(`applied-config.json 读不了：${(e as Error).message}`)
    }
  }

  /** 实际生效的配置版本：应用过就是应用的那一版，否则是 eg.yaml 带来的（部署时的） */
  version(): string | null {
    if (this.applied) return this.applied.version
    const v = this.cfg.eg.attrs['cfg']
    return typeof v === 'string' ? v : null
  }

  summary() {
    const a = this.applied
    return a ? { version: a.version, appliedAt: a.appliedAt, by: a.by, rulesOff: a.rules.filter(r => !r.on).map(r => r.id) } : { version: this.version(), appliedAt: null, by: null, rulesOff: [] }
  }

  /** 一次只应用一份 */
  apply(body: unknown, who: { user: string; name: string; ip: string }): Promise<ApplyReceipt> {
    const p = this.chain.then(() => this.doApply(body, who))
    this.chain = p.catch(() => undefined)
    return p
  }

  private async doApply(body: unknown, who: { user: string; name: string; ip: string }): Promise<ApplyReceipt> {
    const version = isObj(body) && typeof body['version'] === 'string' ? body['version'] : ''
    const fail = (error: string): ApplyReceipt => {
      this.log.warn(`版本 ${version || '?'} 应用失败：${error}`)
      this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: '应用子站配置', target: version || '?', ok: false, detail: error })
      return { version, status: 'FAILED', error }
    }
    let input: { version: string; thresholds: ThresholdRow[]; rules: { id: string; on: boolean }[]; extras: ThresholdExtras }
    try {
      input = this.parse(body)
    } catch (e) {
      if (e instanceof Invalid) return fail(e.message)
      throw e
    }
    const hash = createHash('sha256').update(JSON.stringify([input.thresholds, input.rules, input.extras])).digest('hex').slice(0, 16)
    if (this.applied?.version === input.version && this.applied.hash === hash) return { version, status: 'APPLIED', changed: 0 }
    if (!this.tb.available) return fail('eg.yaml 里没有本地 TB 账号，写不了设备配置')

    // 生成新规则（先全部算好再写，阈值缺项等在这一步就报出来）
    let profiles: TbProfile[]
    const plan: { before: TbProfile; after: TbProfile }[] = []
    try {
      const list = await this.tb.get<{ data: { id: { id: string }; name: string }[] }>('/api/deviceProfiles?pageSize=100&page=0')
      profiles = await Promise.all(list.data.filter(p => PROFILES.find(d => d.name === p.name)?.alarms).map(p => this.tb.get<TbProfile>(`/api/deviceProfile/${p.id.id}`)))
    } catch (e) {
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
      return fail(`写本地 TB 的设备配置失败（已改回）：${(e as Error).message}`)
    }

    this.applied = { version: input.version, appliedAt: Date.now(), by: who.name || who.user, hash, thresholds: input.thresholds, rules: input.rules, extras: input.extras }
    writeFileSync(this.file, JSON.stringify(this.applied, null, 2), 'utf8')
    this.bus.publishAttributes(this.cfg.eg.name, { cfg: input.version })
    const off = input.rules.filter(r => !r.on).map(r => r.id)
    const detail = `改了 ${plan.length} 个设备配置${plan.length ? `（${plan.map(x => x.before.name).join('、')}）` : ''}${off.length ? `；停用 ${off.join('、')}` : ''}`
    this.log.log(`版本 ${input.version} 已生效：${detail}`)
    this.audit.write({ user: who.user, name: who.name, via: 'sp', ip: who.ip, action: '应用子站配置', target: input.version, ok: true, detail })
    return { version: input.version, status: 'APPLIED', changed: plan.length }
  }

  /** 校验请求体（§8.3）：{ version, thresholds: ThresholdRow[], rules: [{ id, on }], devices?, extras? } */
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
    for (const r of rawRules) {
      if (!isObj(r) || typeof r['id'] !== 'string' || typeof r['on'] !== 'boolean') throw new Invalid('rules 每项要是 { id: 字符串, on: 布尔 }')
      // 子站执行的规则（SP-*）与 EG 无关，带了也不管
      if (!r['id'].startsWith('EG-')) continue
      if (!RULE_ALARM[r['id']]) throw new Invalid(`不认识的规则 ${r['id']}（EG 上只有 ${Object.keys(RULE_ALARM).join('、')}）`)
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
    return { version, thresholds, rules, extras }
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
      if (!m || m.type !== a.alarmType) continue
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
