/* 能力清单（阶段 A，接口 v1.1，与子站后端会话 2026-10-08 定稿；后端库 docs/V3.0对照与调整方案.md §3.1）。
 *
 * 子站随配置下发（PUT /api/config）：
 *   caps    { "<柜号>": { "<能力>": "confirmed" | "pending" | "unsupported" } }   EG 取自己柜号那一份
 *   capKeys { "<能力>": ["<设备前缀>:<遥测 key>", …] }                          如 pdCount → ["SAM:us.cnt"]、pm6 → ["PM6:*"]
 * 只有 confirmed 算启用。设备前缀 = 设备名第一个「-」之前（SAM、PM、PM2、PM6、CAM）；key 支持整个 key、末尾 * 的前缀、单独 *。
 *
 * EG 怎么用：
 *   - 规则：不看能力（子站对不启用能力的规则直接下 on:false）
 *   - 数据：照常采、照常进本地 TB；**一台设备匹配上的能力全都不启用**（至少匹配上一条）时，这台不进 v1/gateway/connect、
 *     不上送（源头丢，不进 outbox），免得子站 TB 自动建出设备；改成启用后从那一刻起送，以前的不补传
 *   - 本地页：pending 显示「待定」，unsupported 隐藏
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

/** 校验并取出本柜的一份（下发体里的 caps、capKeys）；没带 caps 返回 null（= 不过滤） */
export function parseCaps(body: Record<string, unknown>, cabinet: string): CapsConfig | null {
  const rawCaps = body['caps']
  const rawKeys = body['capKeys']
  if (rawCaps === undefined && rawKeys === undefined) return null
  if (!isObj(rawCaps)) throw new Error('caps 要是对象 { "<柜号>": { "<能力>": 状态 } }')
  if (!isObj(rawKeys)) throw new Error('capKeys 要是对象 { "<能力>": ["前缀:key", …] }')
  const mine = rawCaps[cabinet]
  if (mine === undefined) throw new Error(`caps 里没有本柜 ${cabinet}`)
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

/** 设备是否启用：至少匹配上一条能力、且匹配上的全都不启用 → 不启用；一条都匹配不上的照常（如 EG 自己） */
export function deviceEnabled(device: string, c: CapsConfig | null): boolean {
  if (!c) return true
  const mine = capsOfDevice(device, c)
  return !mine.length || mine.some(cap => capEnabled(cap, c))
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
