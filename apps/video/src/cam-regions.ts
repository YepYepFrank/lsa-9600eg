/* 给没画测温区的摄像机写一套缺省 R1–R3（EG 0.8.0，子站 0.19.0，用户 10-22 拍板）。厂家 restv1 V1.8（docs/厂家资料/）：
 *   读  GET  /restv1/measurement/region          整份（ID 0–11 对应 R1–R12）
 *   写  POST /restv1/measurement/region/:id      按区号写一个区（只动 R1–R3，别的区不碰）
 *   字段 regionEnable、regionName、regionType（point / line / region / polygon）、region 坐标、localMeasureParam、localParam{distance (0–1000], emissivity [0.01–1]}
 *   坐标是热像主码流 640×480 的像素、原点左上（RESTV1_FRAME）。
 *
 * 0.8.1（现场 AH01-B 摄像机 .180，固件 0000_B37_1.1.17，2026-10-23）：照文档写（regionType "region" + localParam）回 10001、一个区都没写进去。
 *   真机读回的矩形区是 regionType "rectangle"，而且**没有** localMeasureParam / localParam 两个字段 —— 区域没有自己的辐射率 / 距离，按全局测温参数
 *   （GET / POST /restv1/measurement/globMeasureParam：envtemp、detectdist、radrate、humidity）算。所以：
 *   - 写法照读回的来（styleOf）：矩形字样用读回里的（rectangle），读回里没有本地参数就不带；摄像机还是回 10001 再换别的写法试（stylesToTry），
 *     第一个区试出能用的写法，后两个区照它写；
 *   - 区域没有本地参数时，辐射率 / 距离只能改全局：缺省不动（只报现在的值），加 setGlobal 才改成 0.95 / 距离（备份里留原值，恢复时一起写回）；
 *   - probe：只在一个没启用的区上试写一次、读回、立刻按备份写回，先在现场验写法对不对；
 *   - force 必须同时给 yes：覆盖前列出 R1–R3 三个位置现在是什么、哪些启用的区不动（现场的 Area6 是用户手画的）；
 *   - 写回（恢复 / 写到一半出错）只写跟备份不一样的区；出厂空区（0×0）摄像机可能不收原样，原来就没启用的改成「停用」（效果一样：不测温）。
 *
 * 缺省布局（用户定）：左、中、右三竖条，R1 = 左、R2 = 中、R3 = 右；四周各留 5% 的边（x 32–608、y 24–456），
 *   条与条之间留 16 px 缝：R1 x 32 宽 181、R2 x 229 宽 181、R3 x 426 宽 182，三条都是 y 24 高 432。
 *   辐射率 0.95；距离缺省 2 m（文档例子），--distance 可改（0–1000]。regionName 写 R1 / R2 / R3，按名对应。
 *
 * 规矩：
 *   - 只在摄像机上一个启用的测温区都没有时才写；已有启用的区拒绝，force + yes 才覆盖（覆盖的只是 R1–R3 三个位置）；
 *   - 写之前先 GET 整份备份（含全局测温参数；调用方存到 /var/lib/lsa-eg/cam-regions-backup-<时间>.json）；写到一半出错，已写的按备份写回；
 *   - 写完 GET 读回逐项核对，再看 regionTemp 有没有数；记审计；提示到子站把这台的「测温区」能力改回已确认；
 *   - restore <备份文件>：把备份里跟现在不一样的区按区号写回（全局测温参数也是），再读回核对。
 *
 * 命令行（install.sh --cam-regions-default / --cam-regions-probe / --cam-regions-restore 在 lsa-eg-video 容器里调）：写区域由 eg-video 用它正在用的驱动做
 * （POST /api/video/cam-regions/…，摄像机最多 2 个会话、没有退出登录，不另外登录），本脚本只存备份、记审计、打印结果：
 *   node --import @swc-node/register/esm-register src/cam-regions.ts default [--force --yes] [--distance <米>] [--set-global]
 *   node --import @swc-node/register/esm-register src/cam-regions.ts probe
 *   node --import @swc-node/register/esm-register src/cam-regions.ts restore <备份文件>
 * 备份写在 $EG_CONFIG_DIR/cam-regions-backup-<时间>.json（install.sh 挪到 /var/lib/lsa-eg/），审计追加到 $EG_CONFIG_DIR/audit.log。 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DriverError } from './driver-base.js'
import { RESTV1_FRAME, regionTypeOf, type Restv1Driver } from './restv1.js'

export const DEFAULT_EMISSIVITY = 0.95
export const DEFAULT_DISTANCE_M = 2

/** 缺省三竖条（640×480 热像主码流像素） */
export const DEFAULT_STRIPS = [
  { x: 32, y: 24, width: 181, height: 432 },
  { x: 229, y: 24, width: 181, height: 432 },
  { x: 426, y: 24, width: 182, height: 432 },
] as const

type Row = Record<string, unknown>
type Rect = { x: number; y: number; width: number; height: number }

/** 摄像机的写法：矩形区的 regionType 字样；区域有没有自己的本地参数（读回里有没有 localMeasureParam / localParam） */
export interface CamStyle {
  rectType: string
  local: boolean
}
/** 文档的写法（读回里看不出来时用） */
export const DOC_STYLE: CamStyle = { rectType: 'region', local: true }

const RECT_TYPES = new Set(['region', 'rectangle', 'rect'])
const isRect = (t: unknown) => RECT_TYPES.has(String(t ?? '').toLowerCase())

/** 照读回定写法：矩形字样用读回里的（真机 rectangle），读回里一个区都没有本地参数就不带 */
export function styleOf(rows: Row[]): CamStyle {
  const rect = rows.find(r => isRect(r['regionType']))
  return { rectType: rect ? String(rect['regionType']) : DOC_STYLE.rectType, local: rows.some(r => 'localParam' in r || 'localMeasureParam' in r) }
}

/** 写法的候选：先照读回的，摄像机回 10001 再按顺序换（本地参数带 / 不带、region / rectangle） */
export function stylesToTry(s: CamStyle): CamStyle[] {
  const other = s.rectType.toLowerCase() === 'region' ? 'rectangle' : 'region'
  const all: CamStyle[] = [s, { rectType: s.rectType, local: !s.local }, { rectType: other, local: false }, { rectType: other, local: true }]
  return all.filter((x, i) => all.findIndex(y => y.rectType === x.rectType && y.local === x.local) === i)
}
export const styleText = (s: CamStyle) => `regionType "${s.rectType}"、${s.local ? '带' : '不带'}本地参数`

/** 一个矩形区（style.local 时带本地参数：辐射率 0.95、距离） */
export function regionRow(name: string, rect: Rect, distance: number, style: CamStyle): Row {
  const row: Row = { regionEnable: true, regionName: name, regionType: style.rectType, region: { ...rect } }
  if (style.local) Object.assign(row, { localMeasureParam: true, localParam: { distance, emissivity: DEFAULT_EMISSIVITY } })
  return row
}

/** 要写的 R1–R3（区号 0–2） */
export function defaultRegionRows(distance = DEFAULT_DISTANCE_M, style: CamStyle = DOC_STYLE): { id: number; row: Row }[] {
  if (!(distance > 0 && distance <= 1000)) throw new Error(`距离 ${distance} 不对：要在 (0, 1000] 米之间`)
  return DEFAULT_STRIPS.map((r, i) => {
    if (r.x < 0 || r.y < 0 || r.x + r.width > RESTV1_FRAME.w || r.y + r.height > RESTV1_FRAME.h) throw new Error(`R${i + 1} 超出 ${RESTV1_FRAME.w}×${RESTV1_FRAME.h} 画面`)
    return { id: i, row: regionRow(`R${i + 1}`, r, distance, style) }
  })
}

/** 写回时只带文档里的字段（备份里可能多出摄像机自己加的东西）；摄像机的区域没有本地参数（local = false）时这两个也不带 */
export function writableOf(row: Row, local = true): Row {
  const out: Row = {}
  for (const k of ['regionEnable', 'regionName', 'regionType', 'region', ...(local ? ['localMeasureParam', 'localParam'] : [])]) if (k in row) out[k] = row[k]
  return out
}

const GLOBAL_KEYS = ['envtemp', 'detectdist', 'radrate', 'humidity'] as const
/** 全局测温参数里能写的四个字段（读回里有的才带） */
export function globalWritable(g: Row): Row {
  const out: Row = {}
  for (const k of GLOBAL_KEYS) if (k in g) out[k] = g[k]
  return out
}
/** 全局参数一样：只比两边都有的字段（摄像机少回一个字段时不至于永远「不一样」） */
const sameGlobal = (a: Row, b: Row) => GLOBAL_KEYS.filter(k => k in a && k in b).every(k => Number(a[k]) === Number(b[k]))
/** 全局参数的范围（厂家 restv1 V1.8 §2.61）：不对返回说法，对返回 null */
export function globalProblem(g: Row): string | null {
  const lim: Record<(typeof GLOBAL_KEYS)[number], [number, number, boolean]> = { envtemp: [-20, 550, false], detectdist: [0, 1000, true], radrate: [0.01, 1, false], humidity: [0, 100, false] }
  const bad = GLOBAL_KEYS.filter(k => k in g).filter(k => {
    const v = g[k]
    const [lo, hi, open] = lim[k]
    return typeof v !== 'number' || !Number.isFinite(v) || (open ? v <= lo : v < lo) || v > hi
  })
  return bad.length ? `超出范围或不是数：${bad.map(k => `${k}=${JSON.stringify(g[k])}`).join('、')}` : null
}

const is10001 = (e: unknown) => /：10001\b/.test((e as Error)?.message ?? '')
/** 写一格出错时那一格肯定没动：摄像机明确回了错误码（API / TOKEN / AUTH），或者请求根本没发出去（DATA：区号不对）。
 *  超时、连接断了、别的错 → 可能已经写进去了，要按备份写回 */
const surelyNotWritten = (e: unknown) => e instanceof DriverError && ['API', 'TOKEN', 'AUTH', 'DATA'].includes(e.code)
const enabledOf = (rows: Row[]) => rows.map((r, id) => ({ id, r })).filter(({ r }) => r['regionEnable'] === true)
const sameRect = (a: unknown, b: Record<string, number>) => {
  const o = (a ?? {}) as Row
  return ['x', 'y', 'width', 'height'].every(k => Number(o[k]) === b[k])
}
/** 区域坐标一样（不管字段顺序） */
const sameCoords = (a: unknown, b: unknown) => {
  const x = (a ?? {}) as Row
  const y = (b ?? {}) as Row
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  return [...keys].every(k => JSON.stringify(x[k]) === JSON.stringify(y[k]))
}
const sameType = (a: unknown, b: unknown) => regionTypeOf(a) === regionTypeOf(b) && (isRect(a) === isRect(b))
/** 两个区是不是一回事（启用、名字、类型、坐标；本地参数不比 —— 真机没有） */
const sameRow = (a: Row | undefined, b: Row | undefined) =>
  !!a && !!b && Boolean(a['regionEnable']) === Boolean(b['regionEnable']) && String(a['regionName'] ?? '') === String(b['regionName'] ?? '') && sameType(a['regionType'], b['regionType']) && sameCoords(a['region'], b['region'])

/** 一个区的说法：「Area6」启用 rectangle x320 y132 206×169 */
export function rowText(r: Row | undefined, id: number): string {
  if (!r) return `区号 ${id} 没有`
  const g = (r['region'] ?? {}) as Row
  const where = 'width' in g ? `x${String(g['x'])} y${String(g['y'])} ${String(g['width'])}×${String(g['height'])}` : JSON.stringify(g)
  return `「${String(r['regionName'] || `R${id + 1}`)}」${r['regionEnable'] === true ? '启用' : '没启用'} ${String(r['regionType'] ?? '?')} ${where}`
}

/** 把一个区写回成备份里的样子 old。摄像机不收原样（出厂空区 0×0 回 10001）而 old 本来就没启用时，改成「停用」：
 *  坐标用 cur（摄像机现在的 / 刚写进去的），名字照 old —— 效果一样（不测温）。返回说法 */
async function putBack(d: Restv1Driver, id: number, old: Row, cur: Row | undefined, local: boolean): Promise<{ how: 'same' | 'disabled'; text: string }> {
  try {
    await d.setRegion(id, writableOf(old, local))
    return { how: 'same', text: `R${id + 1} 已写回` }
  } catch (e) {
    if (!is10001(e) || old['regionEnable'] === true || !cur) throw e
    await d.setRegion(id, writableOf({ ...cur, regionEnable: false, regionName: old['regionName'] }, local))
    return { how: 'disabled', text: `R${id + 1} 原样（${rowText(old, id)}）摄像机不收（10001），改成停用、坐标留着刚才的` }
  }
}

export interface Backup {
  at: string
  camera: string
  regions: Row[]
  /** 全局测温参数（0.8.1 起；读得到才有） */
  glob?: Row
}

export interface ApplyResult {
  ok: boolean
  /** 写之前的整份区域配置（含全局测温参数） */
  backup: Backup
  /** 实际写了的区号 */
  written: number[]
  /** 读回核对的问题（空 = 都对） */
  mismatch: string[]
  /** R1–R3 的 regionTemp（max / avg；还没有数为 null） */
  temps: { name: string; max: number | null; avg: number | null }[]
  /** 用的写法 */
  style?: CamStyle
  /** 要说给现场的话（换了写法、全局辐射率、哪些区不动……） */
  notes: string[]
  /** 拒绝 / 失败的原因 */
  error?: string
  /** 写到一半出错时按备份写回的情况 */
  rolledBack?: string
}

/** 写缺省 R1–R3。backup 一定先取到（取不到就不写）；已有启用的区、没给 force → 拒绝；给了 force 没给 yes → 列出会被覆盖的、不写 */
export async function applyDefaultRegions(
  d: Restv1Driver,
  o: { force?: boolean; yes?: boolean; distance?: number; setGlobal?: boolean; camera: string; now?: Date; waitTempMs?: number },
): Promise<ApplyResult> {
  const distance = o.distance ?? DEFAULT_DISTANCE_M
  const before = await d.regionsRaw()
  const style0 = styleOf(before)
  const glob = style0.local ? undefined : await d.globalParamRaw().catch(() => undefined)
  const backup: Backup = { at: (o.now ?? new Date()).toISOString(), camera: o.camera, regions: before, ...(glob ? { glob } : {}) }
  const res: ApplyResult = { ok: false, backup, written: [], mismatch: [], temps: [], notes: [] }
  defaultRegionRows(distance, style0) // 距离不对先拒
  if (before.length < 3) {
    res.error = `摄像机只回了 ${before.length} 个区：要有 R1–R3 三个位置（写之前的样子也要在，出错才能按备份写回），不写`
    return res
  }
  const on = enabledOf(before)
  const keep = on.filter(({ id }) => id > 2)
  if (on.length && !o.force) {
    res.error = `摄像机上已经有 ${on.length} 个启用的测温区（${on.map(({ r, id }) => `${String(r['regionName'] || `R${id + 1}`)}/${String(r['regionType'] ?? '?')}`).join('、')}），不写；确认要覆盖 R1–R3 三个位置加 --force --yes（先不加 --yes 看会覆盖什么）`
    return res
  }
  const cover = [0, 1, 2].map(id => `R${id + 1} 位置（区号 ${id}）现在 ${rowText(before[id], id)}`)
  const keepText = keep.length ? `；这些启用的区不在 R1–R3 位置，不动：${keep.map(({ r, id }) => `${rowText(r, id)}（区号 ${id}）`).join('、')}` : ''
  if (o.force && !o.yes) {
    res.error = `--force 会覆盖：${cover.join('；')}${keepText}。确认要覆盖再加 --yes（写之前照样整份备份）`
    return res
  }
  if (o.force) res.notes.push(`--force 覆盖了：${cover.join('；')}${keepText}`)
  else if (keep.length) res.notes.push(keepText.slice(1))
  // 写 R1：照读回的写法，摄像机回 10001 换下一种；试出来的写法 R2、R3 照用
  let style: CamStyle | null = null
  const tried: string[] = []
  /** 正在写的那一格；allRejected = 几种写法都回 10001（摄像机明确没收，那一格没动） */
  let at = -1
  let allRejected = false
  try {
    for (const [i, rect] of DEFAULT_STRIPS.entries()) {
      at = i
      if (i === 0) {
        for (const s of stylesToTry(style0)) {
          try {
            await d.setRegion(0, regionRow('R1', rect, distance, s))
            style = s
            break
          } catch (e) {
            if (!is10001(e)) throw e
            tried.push(`${styleText(s)}：${(e as Error).message}`)
          }
        }
        if (!style) {
          allRejected = true
          throw new Error(`几种写法摄像机都不收（${tried.join('；')}）`)
        }
        if (tried.length) res.notes.push(`照读回的写法（${styleText(style0)}）摄像机回 10001，改用 ${styleText(style)} 写进去了`)
      } else await d.setRegion(i, regionRow(`R${i + 1}`, rect, distance, style!))
      res.written.push(i)
    }
  } catch (e) {
    res.error = `写 R${res.written.length + 1} 失败：${(e as Error).message}`
    const back: string[] = []
    // 写失败的那一格：摄像机明确回了错误码（10001、10008 …）就没动；超时、连接断了可能已经写进去了，一样按备份写回
    const ids = [...res.written, ...(at >= 0 && !res.written.includes(at) && !allRejected && !surelyNotWritten(e) ? [at] : [])]
    const s1 = style ?? style0
    for (const id of ids) {
      const old = before[id]
      if (!old) continue
      try {
        back.push((await putBack(d, id, old, regionRow(`R${id + 1}`, DEFAULT_STRIPS[id]!, distance, s1), s1.local)).text)
      } catch (e2) {
        back.push(`R${id + 1} 写回失败（${(e2 as Error).message}）`)
      }
    }
    res.rolledBack = back.length ? back.join('、') : '一个都还没写，不用写回'
    return res
  }
  res.style = style!
  // 读回核对（矩形字样 region / rectangle 算一种）。读回失败（19999、超时）不抛：区已经写了，结果和备份要交回去存盘、记审计
  let after: Row[]
  try {
    after = await d.regionsRaw()
  } catch (e) {
    res.error = `R1–R3 已经写了，但写完读回失败：${(e as Error).message}（没核对；要撤销用备份恢复）`
    return res
  }
  for (const [i, rect] of DEFAULT_STRIPS.entries()) {
    const got = after[i] ?? {}
    if (got['regionEnable'] !== true) res.mismatch.push(`R${i + 1} 没启用`)
    if (regionTypeOf(got['regionType']) !== 'region') res.mismatch.push(`R${i + 1} 类型是 ${String(got['regionType'])}`)
    if (String(got['regionName'] ?? '') !== `R${i + 1}`) res.mismatch.push(`R${i + 1} 名字是「${String(got['regionName'] ?? '')}」`)
    if (!sameRect(got['region'], rect)) res.mismatch.push(`R${i + 1} 坐标是 ${JSON.stringify(got['region'])}`)
    if (style!.local) {
      const lp = (got['localParam'] ?? {}) as { emissivity?: unknown; distance?: unknown }
      if (got['localMeasureParam'] !== true || Number(lp.emissivity) !== DEFAULT_EMISSIVITY || Number(lp.distance) !== distance)
        res.mismatch.push(`R${i + 1} 本地参数是 ${JSON.stringify({ localMeasureParam: got['localMeasureParam'], localParam: got['localParam'] })}`)
    }
  }
  // 区域没有本地参数：辐射率 / 距离按全局测温参数算
  if (!style!.local) {
    if (!glob) res.notes.push('测温区没有单独的辐射率 / 距离（按全局测温参数算），全局测温参数读不到：到摄像机管理页看「全局测温参数」')
    else if (Number(glob['radrate']) === DEFAULT_EMISSIVITY && Number(glob['detectdist']) === distance) res.notes.push(`测温区按全局测温参数算：辐射率 ${String(glob['radrate'])}、检测距离 ${String(glob['detectdist'])} m（已经是要的值）`)
    else if (!o.setGlobal)
      res.notes.push(`测温区没有单独的辐射率 / 距离，按全局测温参数算：现在辐射率 ${String(glob['radrate'])}、检测距离 ${String(glob['detectdist'])} m；要改成 ${DEFAULT_EMISSIVITY} / ${distance} m 加 --set-global（改的是整台摄像机，全画面测温也跟着变；备份里留着原值，恢复时一起写回）`)
    else {
      const want = { ...globalWritable(glob), radrate: DEFAULT_EMISSIVITY, detectdist: distance }
      try {
        await d.setGlobalParam(want)
        const g2 = await d.globalParamRaw()
        if (sameGlobal(g2, want)) res.notes.push(`全局测温参数：辐射率 ${String(glob['radrate'])} → ${DEFAULT_EMISSIVITY}、检测距离 ${String(glob['detectdist'])} → ${distance} m（--set-global）`)
        else res.mismatch.push(`全局测温参数读回是 ${JSON.stringify(globalWritable(g2))}（要的是 ${JSON.stringify(want)}）`)
      } catch (e) {
        res.mismatch.push(`全局测温参数写不进：${(e as Error).message}`)
      }
    }
  }
  // regionTemp：摄像机 1 s 刷新，刚写完可能还没有数，最多等 waitTempMs
  const deadline = Date.now() + (o.waitTempMs ?? 5000)
  for (;;) {
    const t = await d.regionTempRaw().catch(() => [] as Row[])
    res.temps = [0, 1, 2].map(id => {
      const r = (t[id] ?? {}) as { max?: { value?: unknown }; avg?: { value?: unknown } }
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null)
      return { name: `R${id + 1}`, max: n(r.max?.value), avg: n(r.avg?.value) }
    })
    if (res.temps.every(x => x.max !== null) || Date.now() >= deadline) break
    await new Promise(r => setTimeout(r, 1000))
  }
  res.ok = res.mismatch.length === 0
  return res
}

export interface ProbeResult {
  ok: boolean
  backup: Backup
  /** 试写的区号（第一个没启用的） */
  slot: number | null
  /** 每种写法试的结果；收了的带读回 */
  tries: { style: string; accepted: boolean; error?: string; readback?: Row }[]
  /** 摄像机收的写法 */
  works?: CamStyle
  /** 写回的情况 */
  restored?: string
  /** 试完以后除了试写的区，摄像机上别的都跟备份一样 */
  unchanged: boolean
  error?: string
}

/** 试写：在第一个没启用的区上按写法候选逐个试写 R1 那一条（名字 PROBE），收了就读回、立刻按备份写回；不动启用的区、不动全局参数 */
export async function probeRegions(d: Restv1Driver, o: { camera: string; now?: Date }): Promise<ProbeResult> {
  const before = await d.regionsRaw()
  const style0 = styleOf(before)
  const glob = await d.globalParamRaw().catch(() => undefined)
  const backup: Backup = { at: (o.now ?? new Date()).toISOString(), camera: o.camera, regions: before, ...(glob ? { glob } : {}) }
  const res: ProbeResult = { ok: false, backup, slot: null, tries: [], unchanged: false }
  const slot = before.findIndex(r => r['regionEnable'] !== true)
  if (slot < 0) return { ...res, error: `${before.length} 个区都启用着，没有空位试写` }
  res.slot = slot
  let disabledInstead = false
  for (const s of stylesToTry(style0)) {
    const row = regionRow('PROBE', DEFAULT_STRIPS[0], DEFAULT_DISTANCE_M, s)
    try {
      await d.setRegion(slot, row)
    } catch (e) {
      if (!is10001(e)) {
        res.error = `试写区号 ${slot}（${styleText(s)}）出错：${(e as Error).message}`
        if (surelyNotWritten(e)) break
        // 超时 / 断开时可能已经写进去了：一样按备份写回
        try {
          const b = await putBack(d, slot, before[slot]!, row, s.local)
          disabledInstead = b.how === 'disabled'
          res.restored = b.text
        } catch (e2) {
          res.restored = `R${slot + 1} 写回失败（${(e2 as Error).message}）：用备份恢复`
        }
        break
      }
      res.tries.push({ style: styleText(s), accepted: false, error: (e as Error).message })
      continue
    }
    res.works = s
    const t: ProbeResult['tries'][number] = { style: styleText(s), accepted: true }
    res.tries.push(t)
    try {
      t.readback = (await d.regionsRaw())[slot]
    } catch (e) {
      res.error = `试写后读回失败：${(e as Error).message}`
    } finally {
      try {
        const b = await putBack(d, slot, before[slot]!, row, s.local)
        disabledInstead = b.how === 'disabled'
        res.restored = b.text
      } catch (e) {
        res.restored = `R${slot + 1} 写回失败（${(e as Error).message}）：用备份恢复`
      }
    }
    break
  }
  if (!res.works && !res.error) res.error = `几种写法摄像机都不收：${res.tries.map(x => `${x.style}：${x.error}`).join('；')}`
  let after: Row[]
  try {
    after = await d.regionsRaw()
  } catch (e) {
    res.error = `${res.error ? `${res.error}；` : ''}试完读回失败：${(e as Error).message}（没核对摄像机是不是回到原样；要的话用备份恢复）`
    return res
  }
  res.unchanged = before.every((r, i) => (i === slot && disabledInstead ? after[i]?.['regionEnable'] !== true && String(after[i]?.['regionName'] ?? '') === String(r['regionName'] ?? '') : sameRow(after[i], r)))
  // 收了的那次读回要对得上：启用、名字 PROBE、矩形、坐标
  const rb = res.tries.find(x => x.accepted)?.readback
  const rbOk = !!rb && rb['regionEnable'] === true && rb['regionName'] === 'PROBE' && isRect(rb['regionType']) && sameRect(rb['region'], DEFAULT_STRIPS[0])
  if (res.works && !rbOk && !res.error) res.error = `试写收了，但读回对不上：${JSON.stringify(rb)}`
  res.ok = !!res.works && rbOk && res.unchanged && !res.error
  return res
}

export interface RestoreResult {
  ok: boolean
  written: number[]
  /** 跟备份一样、没写的区数 */
  skipped: number
  mismatch: string[]
  notes: string[]
  error?: string
}

/** 按备份写回（区号 = 下标）：只写跟现在不一样的区；全局测温参数（备份里有）不一样也写回；再读回核对 */
export async function restoreRegions(d: Restv1Driver, b: Backup, o: { camera?: string } = {}): Promise<RestoreResult> {
  const res: RestoreResult = { ok: false, written: [], skipped: 0, mismatch: [], notes: [] }
  if (!Array.isArray(b.regions) || !b.regions.length) return { ...res, error: '备份文件里没有区域配置（regions）' }
  if (o.camera && b.camera && o.camera !== b.camera) return { ...res, error: `备份是摄像机 ${b.camera} 的，现在接的是 ${o.camera}：不写` }
  const cur = await d.regionsRaw()
  const local = styleOf(cur).local
  const disabled = new Set<number>()
  const failed: string[] = []
  for (const [id, row] of b.regions.entries()) {
    if (id > 11) break
    if (sameRow(cur[id], row)) {
      res.skipped++
      continue
    }
    // 某一区写不回也接着写别的区和全局参数，最后一起报
    try {
      const p = await putBack(d, id, row, cur[id], local)
      if (p.how === 'disabled') {
        disabled.add(id)
        res.notes.push(p.text)
      }
      res.written.push(id)
    } catch (e) {
      failed.push(`R${id + 1}（${(e as Error).message}）`)
    }
  }
  const gp = b.glob ? globalProblem(b.glob) : null
  if (b.glob && gp) res.mismatch.push(`备份里的全局测温参数${gp}，没写回`)
  else if (b.glob) {
    try {
      const g = await d.globalParamRaw()
      if (!sameGlobal(g, b.glob)) {
        await d.setGlobalParam(globalWritable(b.glob))
        const g2 = await d.globalParamRaw()
        if (sameGlobal(g2, b.glob)) res.notes.push(`全局测温参数也写回了（辐射率 ${String(b.glob['radrate'])}、检测距离 ${String(b.glob['detectdist'])} m）`)
        else res.mismatch.push(`全局测温参数读回是 ${JSON.stringify(globalWritable(g2))}（备份 ${JSON.stringify(globalWritable(b.glob))}）`)
      }
    } catch (e) {
      res.mismatch.push(`全局测温参数写回失败：${(e as Error).message}`)
    }
  }
  if (failed.length) res.error = `写回失败：${failed.join('、')}（别的区和全局参数照样写了，可以再跑一次）`
  let after: Row[]
  try {
    after = await d.regionsRaw()
  } catch (e) {
    res.error = `${res.error ? `${res.error}；` : ''}写完读回失败：${(e as Error).message}（没核对）`
    return res
  }
  for (const [id, row] of b.regions.entries()) {
    if (id > 11) break
    const got = after[id] ?? {}
    if (Boolean(got['regionEnable']) !== Boolean(row['regionEnable'])) res.mismatch.push(`R${id + 1} 启用 ${String(got['regionEnable'])}（备份 ${String(row['regionEnable'])}）`)
    if (disabled.has(id)) continue
    if (!sameType(got['regionType'], row['regionType'])) res.mismatch.push(`R${id + 1} 类型 ${String(got['regionType'])}（备份 ${String(row['regionType'])}）`)
    if (!sameCoords(got['region'], row['region'])) res.mismatch.push(`R${id + 1} 坐标 ${JSON.stringify(got['region'])}（备份 ${JSON.stringify(row['region'])}）`)
  }
  res.ok = res.mismatch.length === 0 && !res.error
  return res
}

// ---------- 命令行 ----------
// 不自己登录摄像机：摄像机最多 2 个会话、restv1 没有退出登录，令牌一小时才过期 —— 每跑一次占一个会话，连跑两次就 19999。
// 改成调本机 eg-video（它手里那个驱动的令牌一直在用），eg-video 只听 127.0.0.1:9110（install.sh 在 lsa-eg-video 容器里跑本脚本）

function audit(dir: string, action: string, ok: boolean, detail: string): void {
  try {
    appendFileSync(resolve(dir, 'audit.log'), JSON.stringify({ ts: Date.now(), user: 'install.sh', name: '维护（命令行）', via: 'system', ip: '-', action, target: '摄像机测温区', ok, detail }) + '\n')
  } catch {
    /* 审计写不进不挡操作 */
  }
}

async function video<T>(path: string, body?: unknown): Promise<T> {
  const base = (process.env['EG_VIDEO_URL'] ?? 'http://127.0.0.1:9110').replace(/\/$/, '')
  let r: Response
  try {
    r = await fetch(`${base}${path}`, { method: 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  } catch (e) {
    throw new Error(`连不上 eg-video（${base}）：${(e as Error).message}`)
  }
  const j = (await r.json().catch(() => ({}))) as { message?: string } & T
  if (!r.ok) throw new Error(j.message ?? `eg-video 回 HTTP ${r.status}`)
  return j
}

/** 备份存成 cam-regions-backup-<时间>.json（600），返回文件名 */
function saveBackup(dir: string, b: Backup): string {
  const t = new Date(b.at)
  const p2 = (n: number) => String(n).padStart(2, '0')
  const name = `cam-regions-backup-${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}.json`
  writeFileSync(resolve(dir, name), JSON.stringify(b, null, 2) + '\n', { mode: 0o600 })
  const g = b.glob ? `；全局测温参数 辐射率 ${String(b.glob['radrate'])}、检测距离 ${String(b.glob['detectdist'])} m` : ''
  console.log(`写之前的整份区域配置已备份：${name}（${b.regions.length} 个区，启用 ${b.regions.filter(x => x['regionEnable'] === true).length} 个${g}）`)
  return name
}

async function cli(): Promise<number> {
  const dir = process.env['EG_CONFIG_DIR'] ?? '/config'
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd === 'default') {
    const force = argv.includes('--force')
    const yes = argv.includes('--yes')
    const setGlobal = argv.includes('--set-global')
    const di = argv.indexOf('--distance')
    const distance = di > 0 ? Number(argv[di + 1]) : DEFAULT_DISTANCE_M
    const q = new URLSearchParams({ force: force ? '1' : '0', yes: yes ? '1' : '0', setGlobal: setGlobal ? '1' : '0', distance: String(distance) })
    const r = await video<ApplyResult>(`/api/video/cam-regions/default?${q}`)
    const camera = r.backup.camera
    // 只是列出会覆盖什么（--force 没给 --yes）：没动摄像机，不存备份
    if (force && !yes) {
      console.error(`!! ${r.error}`)
      return 1
    }
    const name = saveBackup(dir, r.backup)
    for (const n of r.notes ?? []) console.log(`说明：${n}`)
    if (r.error) {
      console.error(`!! ${r.error}${r.rolledBack ? `；按备份写回：${r.rolledBack}` : ''}`)
      audit(dir, '写缺省测温区', false, `${camera}：${r.error}${r.rolledBack ? `；${r.rolledBack}` : ''}`)
      return 1
    }
    console.log(`已写 R1–R3（左 / 中 / 右三竖条${r.style?.local ? `，辐射率 ${DEFAULT_EMISSIVITY}、距离 ${distance} m` : ''}${force ? '，--force 覆盖' : ''}；写法 ${r.style ? styleText(r.style) : '?'}）`)
    console.log(r.ok ? '读回核对：一致' : `!! 读回核对不一致：${r.mismatch.join('；')}`)
    console.log(`区域温度：${r.temps.map(x => `${x.name} 最高 ${x.max ?? '—'} 平均 ${x.avg ?? '—'}`).join('，')}${r.temps.some(x => x.max === null) ? '（还有没数的：过一会儿到本地页「本柜总览」看）' : ''}`)
    console.log('下一步：到子站网关页，把这台的「测温区」能力改回「已确认」')
    audit(dir, '写缺省测温区', r.ok, `${camera}：R1–R3 三竖条、写法 ${r.style ? styleText(r.style) : '?'}、距离 ${distance} m${force ? '（--force --yes）' : ''}${setGlobal ? '（--set-global）' : ''}；备份 ${name}${r.ok ? '' : `；读回不一致：${r.mismatch.join('；')}`}`)
    return r.ok ? 0 : 1
  }
  if (cmd === 'probe') {
    const r = await video<ProbeResult>('/api/video/cam-regions/probe')
    const camera = r.backup.camera
    const name = saveBackup(dir, r.backup)
    if (r.slot !== null) console.log(`试写区号 ${r.slot}（原来 ${rowText(r.backup.regions[r.slot], r.slot)}）：`)
    for (const t of r.tries) console.log(`  ${t.accepted ? '收了' : '不收'}  ${t.style}${t.error ? `：${t.error}` : ''}${t.readback ? `；读回 ${JSON.stringify(t.readback)}` : ''}`)
    if (r.restored) console.log(`写回：${r.restored}`)
    console.log(r.unchanged ? '试完核对：摄像机上的区跟试之前一样' : `!! 试完核对：摄像机上的区跟试之前不一样，用备份恢复：sudo bash install.sh --cam-regions-restore /var/lib/lsa-eg/${name}`)
    if (r.error) console.error(`!! ${r.error}`)
    if (r.works) console.log(`结论：这台摄像机收 ${styleText(r.works)}；--cam-regions-default 会照这个写`)
    audit(dir, '试写测温区', r.ok, `${camera}：区号 ${r.slot ?? '-'}；${r.tries.map(t => `${t.style} ${t.accepted ? '收' : '不收'}`).join('，')}；${r.restored ?? ''}${r.error ? `；${r.error}` : ''}；备份 ${name}`)
    return r.ok ? 0 : 1
  }
  if (cmd === 'restore') {
    const f = argv[1]
    if (!f) {
      console.error('用法：cam-regions.ts restore <备份文件>')
      return 2
    }
    const b = JSON.parse(readFileSync(f, 'utf8')) as Backup
    const r = await video<RestoreResult>('/api/video/cam-regions/restore', b)
    for (const n of r.notes ?? []) console.log(`说明：${n}`)
    if (r.error) {
      console.error(`!! ${r.error}${r.mismatch?.length ? `；读回不一致：${r.mismatch.join('；')}` : ''}`)
      audit(dir, '恢复测温区', false, `${b.camera}：${r.error}`)
      return 1
    }
    console.log(`已按备份（${b.at}）写回 ${r.written.length} 个区（${r.skipped} 个跟备份一样、没写）；读回核对${r.ok ? '一致' : `不一致：${r.mismatch.join('；')}`}`)
    audit(dir, '恢复测温区', r.ok, `${b.camera}：按备份 ${b.at} 写回 ${r.written.length} 个区${r.notes.length ? `；${r.notes.join('；')}` : ''}${r.ok ? '' : `；不一致：${r.mismatch.join('；')}`}`)
    return r.ok ? 0 : 1
  }
  console.error('用法：cam-regions.ts default [--force --yes] [--distance <米>] [--set-global] | probe | restore <备份文件>')
  return 2
}

if (process.argv[1] && /(^|[\\/])cam-regions\.(ts|js)$/.test(process.argv[1])) {
  cli().then(
    c => process.exit(c),
    e => {
      console.error(`!! ${(e as Error).message}`)
      process.exit(1)
    },
  )
}
