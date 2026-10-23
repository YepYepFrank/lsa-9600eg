/* 能力清单（阶段 A，接口 v1.1，与子站后端会话 2026-10-08 定稿；后端库 docs/V3.0对照与调整方案.md §3.1）。
 *
 * 子站随配置下发（PUT /api/config）：
 *   caps    { "<柜号>": { "<能力>": "confirmed" | "pending" | "unsupported" } }   EG 取自己柜号那一份
 *   capKeys { "<能力>": ["<设备前缀>:<遥测 key>", …] }                          如 pdCount → ["SAM:us.cnt"]、smokePpm → ["SAM:smoke.*"]
 * 只有 confirmed 算启用。设备前缀 = 设备名第一个「-」之前（SAM、PM、PM2、CAM；PM6 0.7.1 起取消）；key 支持整个 key、末尾 * 的前缀、单独 *。
 *
 * EG 怎么用：
 *   - 规则：不看能力（子站对不启用能力的规则直接下 on:false）
 *   - 上送：**一台设备匹配上的能力全都不启用**（至少匹配上一条）时，这台不进 v1/gateway/connect、不上送（源头丢，不进 outbox），
 *     免得子站 TB 自动建出设备；改成 confirmed 后从那一刻起送，以前的不补传
 *   - 本地库（v1.2，协调会话 2026-10-08）：匹配上的能力**全都是 unsupported** 的设备不进 EG 本地 TB（IoT Gateway 不订阅它）；
 *     有 pending 的照常进本地 TB —— pending 多是装了传感器、型号 / 口径没定，现场调试要先看到真实读数才能定 confirmed 还是 unsupported
 *   - 本地页：pending 照常显示数据、标「待定（数据仅供调试核对）」，unsupported 隐藏
 *   - 上报 caps.actual（EG-<柜号> 的属性，JSON 串）：ok = 配了该设备且窗口内有有效值；nodata = 配了但没有；absent = 没配
 *     窗口 = max(10 min, 3 × 该 key 的周期)
 * 子站没下发过能力（老子站、首次部署）= 全部照旧，不过滤。 */

export type CapState = 'confirmed' | 'pending' | 'unsupported'
export type CapActual = 'ok' | 'nodata' | 'absent'

export interface CapsConfig {
  /** 本柜各能力的状态 */
  caps: Record<string, CapState>
  /** 能力 → ["前缀:key", …] */
  capKeys: Record<string, string[]>
}

const STATES: CapState[] = ['confirmed', 'pending', 'unsupported']

/** 设备前缀：设备名第一个「-」之前（EG-AH12 → EG，PM2-AH12 → PM2） */
export function prefixOf(device: string): string {
  const i = device.indexOf('-')
  return i < 0 ? device : device.slice(0, i)
}

/** "SAM:us.cnt" → { prefix: 'SAM', key: 'us.cnt' }；格式不对 null */
export function parsePattern(p: string): { prefix: string; key: string } | null {
  const i = p.indexOf(':')
  if (i <= 0 || i === p.length - 1) return null
  return { prefix: p.slice(0, i), key: p.slice(i + 1) }
}

/** key 匹配：整个 key、末尾 * 的前缀（"el.*"、"el.h*"）、单独 *；不支持中间通配 */
export function keyMatch(pattern: string, key: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return key.startsWith(pattern.slice(0, -1))
  return pattern === key
}

/** 规则 offCabs 按哪个键看（0.18.0 舱室 EG，同 caps / meters 的取键）：下发体的 caps 里有本单元号的键 → 只看单元号；
 *  没有（老子站，或照旧一柜一台：单元号 = 柜号）→ 看柜号。
 *  不能两个都看：能力按单元记以后，AH01-A 已确认、AH01-B 没确认时，子站过渡期给拆了的柜发的柜号键 AH01 按整柜算、多半在 offCabs 里，
 *  两个都看会把 EG-AH01-A 的规则误关 */
export function offCabsKey(body: Record<string, unknown>, unit: string, cabinet: string): string {
  const caps = body['caps']
  return isObj(caps) && caps[unit] !== undefined ? unit : cabinet
}

/** 校验并取出本 EG 的一份（下发体里的 caps、capKeys）；没带 caps 返回 null（= 不过滤）。
 *  key：按顺序找的键 —— 0.18.0 起先找单元号（unit.code），没有再找柜号（子站过渡期两种键都发；老子站只有柜号键） */
export function parseCaps(body: Record<string, unknown>, key: string | readonly string[]): CapsConfig | null {
  const keys = typeof key === 'string' ? [key] : [...new Set(key)]
  const rawCaps = body['caps']
  const rawKeys = body['capKeys']
  if (rawCaps === undefined && rawKeys === undefined) return null
  if (!isObj(rawCaps)) throw new Error('caps 要是对象 { "<单元号或柜号>": { "<能力>": 状态 } }')
  if (!isObj(rawKeys)) throw new Error('capKeys 要是对象 { "<能力>": ["前缀:key", …] }')
  const cabinet = keys.find(k => rawCaps[k] !== undefined)
  if (cabinet === undefined) throw new Error(`caps 里没有本 EG（${keys.join(' / ')}）`)
  const mine = rawCaps[cabinet]
  if (!isObj(mine)) throw new Error(`caps.${cabinet} 要是对象`)
  const caps: Record<string, CapState> = {}
  for (const [k, v] of Object.entries(mine)) {
    if (!STATES.includes(v as CapState)) throw new Error(`caps.${cabinet}.${k} 要是 confirmed / pending / unsupported`)
    caps[k] = v as CapState
  }
  const capKeys: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(rawKeys)) {
    if (!Array.isArray(v) || !v.every(p => typeof p === 'string' && parsePattern(p))) throw new Error(`capKeys.${k} 要是 ["前缀:key", …]`)
    capKeys[k] = v as string[]
  }
  return { caps, capKeys }
}

/** 这台设备匹配上的能力（capKeys 里有前缀相同的条目） */
export function capsOfDevice(device: string, c: CapsConfig): string[] {
  const pre = prefixOf(device)
  return Object.entries(c.capKeys)
    .filter(([, pats]) => pats.some(p => parsePattern(p)?.prefix === pre))
    .map(([k]) => k)
}

/** 能力是否启用：只有 confirmed 算（capKeys 里有、caps 里没写的 = 不启用） */
export function capEnabled(cap: string, c: CapsConfig | null): boolean {
  return !c || c.caps[cap] === 'confirmed'
}

/** 某台设备某个量的能力状态（0.7.3，看护按它定「必有」）：匹配上的能力里有 confirmed → confirmed；没有但有 pending → pending；
 *  都是 unsupported → unsupported；一条都匹配不上、或子站没下发能力 → null（照旧当启用） */
export function keyCapState(device: string, key: string, c: CapsConfig | null): CapState | null {
  if (!c) return null
  const pre = prefixOf(device)
  const states = Object.entries(c.capKeys)
    .filter(([, pats]) => pats.some(p => {
      const pp = parsePattern(p)
      return !!pp && pp.prefix === pre && keyMatch(pp.key, key)
    }))
    .map(([cap]) => c.caps[cap] ?? 'unsupported')
  if (!states.length) return null
  return states.includes('confirmed') ? 'confirmed' : states.includes('pending') ? 'pending' : 'unsupported'
}

/** 设备是否启用：至少匹配上一条能力、且匹配上的全都不启用 → 不启用；一条都匹配不上的照常（如 EG 自己）。
 *  0.8.1（现场 AH01-B）：给了 keys（这台设备点表里的遥测 key，不含 dev.* 这类各设备都有的）时，只要有一个 key 不归任何能力，整台照常启用 ——
 *  子站的 camVideo（双光实况与录像）没有遥测、capKeys 是空的，摄像机只匹配上 thermalRegions（CAM:ir.*）；测温区改成待定后
 *  整台被判不启用，cam.online / cam.vis / cam.ir / dev.* 都不上送了，子站网关页显示离线 */
export function deviceEnabled(device: string, c: CapsConfig | null, keys?: readonly string[]): boolean {
  if (!c) return true
  const mine = capsOfDevice(device, c)
  if (!mine.length || mine.some(cap => capEnabled(cap, c))) return true
  return !!keys?.some(k => keyCapState(device, k, c) === null)
}

/** 设备是否进 EG 本地 TB（v1.2）：至少匹配上一条能力、且匹配上的全都是 unsupported → 不进；有 pending / confirmed 或一条都匹配不上的照常 */
export function deviceLocal(device: string, c: CapsConfig | null): boolean {
  if (!c) return true
  const mine = capsOfDevice(device, c)
  return !mine.length || mine.some(cap => c.caps[cap] !== 'unsupported')
}

/** caps.actual：对每个下发了 capKeys 的能力判 ok / nodata / absent。
 *  hasValid(device, keyPattern) 由调用方按「窗口内有值、且不在 q 里」判。 */
export function capsActual(
  c: CapsConfig,
  devices: string[],
  hasValid: (device: string, keyPattern: string) => boolean,
): Record<string, CapActual> {
  const out: Record<string, CapActual> = {}
  for (const [cap, pats] of Object.entries(c.capKeys)) {
    let configured = false
    let ok = false
    for (const p of pats) {
      const pp = parsePattern(p)
      if (!pp) continue
      for (const d of devices) {
        if (prefixOf(d) !== pp.prefix) continue
        configured = true
        if (hasValid(d, pp.key)) ok = true
      }
    }
    out[cap] = !configured ? 'absent' : ok ? 'ok' : 'nodata'
  }
  return out
}

/** 本地页的卡片 → 能力（任一 confirmed 显示；都不 confirmed 但有 pending 显示「待定」；全 unsupported 隐藏） */
export function cardState(caps: string[], c: CapsConfig | null): 'show' | 'pending' | 'hidden' {
  if (!c) return 'show'
  const states = caps.map(k => c.caps[k]).filter((s): s is CapState => !!s)
  if (states.includes('confirmed')) return 'show'
  if (states.includes('pending')) return 'pending'
  return states.length ? 'hidden' : 'show'
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
