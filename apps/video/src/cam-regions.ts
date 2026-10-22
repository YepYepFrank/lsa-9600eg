/* 给没画测温区的摄像机写一套缺省 R1–R3（EG 0.8.0，子站 0.19.0，用户 10-22 拍板）。厂家 restv1 V1.8（docs/厂家资料/）：
 *   读  GET  /restv1/measurement/region          整份（ID 0–11 对应 R1–R12）
 *   写  POST /restv1/measurement/region/:id      按区号写一个区（只动 R1–R3，别的区不碰）
 *   字段 regionEnable、regionName、regionType（point / line / region / polygon）、region 坐标、localMeasureParam、localParam{distance (0–1000], emissivity [0.01–1]}
 *   坐标是热像主码流 640×480 的像素、原点左上（RESTV1_FRAME）。
 *
 * 缺省布局（用户定）：左、中、右三竖条，R1 = 左、R2 = 中、R3 = 右，regionType = region；四周各留 5% 的边（x 32–608、y 24–456），
 *   条与条之间留 16 px 缝：R1 x 32 宽 181、R2 x 229 宽 181、R3 x 426 宽 182，三条都是 y 24 高 432。
 *   辐射率 0.95、localMeasureParam = true；距离缺省 2 m（文档例子），--distance 可改（0–1000]。regionName 写 R1 / R2 / R3，按名对应。
 *
 * 规矩：
 *   - 只在摄像机上一个启用的测温区都没有时才写；已有启用的区拒绝，--force 才覆盖（覆盖的只是 R1–R3 三个位置）；
 *   - 写之前先 GET 整份备份（调用方存到 /var/lib/lsa-eg/cam-regions-backup-<时间>.json）；写到一半出错，已写的按备份写回；
 *   - 写完 GET 读回逐项核对，再看 regionTemp 有没有数；记审计；提示到子站把这台的「测温区」能力改回已确认；
 *   - restore <备份文件>：把备份里的每个区按区号原样写回，再读回核对。
 *
 * 命令行（install.sh --cam-regions-default / --cam-regions-restore 在 lsa-eg-video 容器里调）：写区域由 eg-video 用它正在用的驱动做
 * （POST /api/video/cam-regions/…，摄像机最多 2 个会话、没有退出登录，不另外登录），本脚本只存备份、记审计、打印结果：
 *   node --import @swc-node/register/esm-register src/cam-regions.ts default [--force] [--distance <米>]
 *   node --import @swc-node/register/esm-register src/cam-regions.ts restore <备份文件>
 * 备份写在 $EG_CONFIG_DIR/cam-regions-backup-<时间>.json（install.sh 挪到 /var/lib/lsa-eg/），审计追加到 $EG_CONFIG_DIR/audit.log。 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RESTV1_FRAME, regionTypeOf, type Restv1Driver } from './restv1.js'

export const DEFAULT_EMISSIVITY = 0.95
export const DEFAULT_DISTANCE_M = 2

/** 缺省三竖条（640×480 热像主码流像素） */
export const DEFAULT_STRIPS = [
  { x: 32, y: 24, width: 181, height: 432 },
  { x: 229, y: 24, width: 181, height: 432 },
  { x: 426, y: 24, width: 182, height: 432 },
] as const

/** 要写的 R1–R3（区号 0–2） */
export function defaultRegionRows(distance = DEFAULT_DISTANCE_M): { id: number; row: Record<string, unknown> }[] {
  if (!(distance > 0 && distance <= 1000)) throw new Error(`距离 ${distance} 不对：要在 (0, 1000] 米之间`)
  return DEFAULT_STRIPS.map((r, i) => {
    if (r.x < 0 || r.y < 0 || r.x + r.width > RESTV1_FRAME.w || r.y + r.height > RESTV1_FRAME.h) throw new Error(`R${i + 1} 超出 ${RESTV1_FRAME.w}×${RESTV1_FRAME.h} 画面`)
    return {
      id: i,
      row: {
        regionEnable: true,
        regionName: `R${i + 1}`,
        regionType: 'region',
        region: { ...r },
        localMeasureParam: true,
        localParam: { distance, emissivity: DEFAULT_EMISSIVITY },
      },
    }
  })
}

/** 写回时只带文档里的字段（备份里可能多出摄像机自己加的东西） */
export function writableOf(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['regionEnable', 'regionName', 'regionType', 'region', 'localMeasureParam', 'localParam']) if (k in row) out[k] = row[k]
  return out
}

const enabledOf = (rows: Record<string, unknown>[]) => rows.map((r, id) => ({ id, r })).filter(({ r }) => r['regionEnable'] === true)
const sameRect = (a: unknown, b: Record<string, number>) => {
  const o = (a ?? {}) as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(k => Number(o[k]) === b[k])
}

export interface Backup {
  at: string
  camera: string
  regions: Record<string, unknown>[]
}

export interface ApplyResult {
  ok: boolean
  /** 写之前的整份区域配置 */
  backup: Backup
  /** 实际写了的区号 */
  written: number[]
  /** 读回核对的问题（空 = 都对） */
  mismatch: string[]
  /** R1–R3 的 regionTemp（max / avg；还没有数为 null） */
  temps: { name: string; max: number | null; avg: number | null }[]
  /** 拒绝 / 失败的原因 */
  error?: string
  /** 写到一半出错时按备份写回的情况 */
  rolledBack?: string
}

/** 写缺省 R1–R3。backup 一定先取到（取不到就不写）；已有启用的区、没给 force → 拒绝 */
export async function applyDefaultRegions(d: Restv1Driver, o: { force?: boolean; distance?: number; camera: string; now?: Date; waitTempMs?: number }): Promise<ApplyResult> {
  const before = await d.regionsRaw()
  const backup: Backup = { at: (o.now ?? new Date()).toISOString(), camera: o.camera, regions: before }
  const res: ApplyResult = { ok: false, backup, written: [], mismatch: [], temps: [] }
  const on = enabledOf(before)
  if (on.length && !o.force) {
    res.error = `摄像机上已经有 ${on.length} 个启用的测温区（${on.map(({ r, id }) => `${String(r['regionName'] || `R${id + 1}`)}/${String(r['regionType'] ?? '?')}`).join('、')}），不写；确认要覆盖 R1–R3 加 --force`
    return res
  }
  const rows = defaultRegionRows(o.distance)
  try {
    for (const { id, row } of rows) {
      await d.setRegion(id, row)
      res.written.push(id)
    }
  } catch (e) {
    res.error = `写 R${res.written.length + 1} 失败：${(e as Error).message}`
    const back: string[] = []
    for (const id of res.written) {
      const old = before[id]
      if (!old) continue
      try {
        await d.setRegion(id, writableOf(old))
        back.push(`R${id + 1} 已写回`)
      } catch (e2) {
        back.push(`R${id + 1} 写回失败（${(e2 as Error).message}）`)
      }
    }
    res.rolledBack = back.length ? back.join('、') : '一个都还没写，不用写回'
    return res
  }
  // 读回核对（真机矩形区回 regionType "rectangle"，按同一种算）
  const after = await d.regionsRaw()
  for (const { id, row } of rows) {
    const got = after[id] ?? {}
    const want = row as { regionName: string; region: Record<string, number>; localParam: { distance: number; emissivity: number } }
    if (got['regionEnable'] !== true) res.mismatch.push(`R${id + 1} 没启用`)
    if (regionTypeOf(got['regionType']) !== 'region') res.mismatch.push(`R${id + 1} 类型是 ${String(got['regionType'])}`)
    if (String(got['regionName'] ?? '') !== want.regionName) res.mismatch.push(`R${id + 1} 名字是「${String(got['regionName'] ?? '')}」`)
    if (!sameRect(got['region'], want.region)) res.mismatch.push(`R${id + 1} 坐标是 ${JSON.stringify(got['region'])}`)
    const lp = (got['localParam'] ?? {}) as { emissivity?: unknown; distance?: unknown }
    if (got['localMeasureParam'] !== true || Number(lp.emissivity) !== want.localParam.emissivity || Number(lp.distance) !== want.localParam.distance)
      res.mismatch.push(`R${id + 1} 本地参数是 ${JSON.stringify({ localMeasureParam: got['localMeasureParam'], localParam: got['localParam'] })}`)
  }
  // regionTemp：摄像机 1 s 刷新，刚写完可能还没有数，最多等 waitTempMs
  const deadline = Date.now() + (o.waitTempMs ?? 5000)
  for (;;) {
    const t = await d.regionTempRaw().catch(() => [] as Record<string, unknown>[])
    res.temps = rows.map(({ id }) => {
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

export interface RestoreResult {
  ok: boolean
  written: number[]
  mismatch: string[]
  error?: string
}

/** 按备份把每个区原样写回（区号 = 下标），再读回核对 */
export async function restoreRegions(d: Restv1Driver, b: Backup): Promise<RestoreResult> {
  const res: RestoreResult = { ok: false, written: [], mismatch: [] }
  if (!Array.isArray(b.regions) || !b.regions.length) return { ...res, error: '备份文件里没有区域配置（regions）' }
  try {
    for (const [id, row] of b.regions.entries()) {
      if (id > 11) break
      await d.setRegion(id, writableOf(row))
      res.written.push(id)
    }
  } catch (e) {
    return { ...res, error: `写回 R${res.written.length + 1} 失败：${(e as Error).message}（已写回 ${res.written.length} 个，可以再跑一次）` }
  }
  const after = await d.regionsRaw()
  for (const [id, row] of b.regions.entries()) {
    if (id > 11) break
    const got = after[id] ?? {}
    if (Boolean(got['regionEnable']) !== Boolean(row['regionEnable'])) res.mismatch.push(`R${id + 1} 启用 ${String(got['regionEnable'])}（备份 ${String(row['regionEnable'])}）`)
    if (regionTypeOf(got['regionType']) !== regionTypeOf(row['regionType'])) res.mismatch.push(`R${id + 1} 类型 ${String(got['regionType'])}（备份 ${String(row['regionType'])}）`)
    if (JSON.stringify(got['region'] ?? {}) !== JSON.stringify(row['region'] ?? {})) res.mismatch.push(`R${id + 1} 坐标 ${JSON.stringify(got['region'])}（备份 ${JSON.stringify(row['region'])}）`)
  }
  res.ok = res.mismatch.length === 0
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

async function cli(): Promise<number> {
  const dir = process.env['EG_CONFIG_DIR'] ?? '/config'
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd === 'default') {
    const force = argv.includes('--force')
    const di = argv.indexOf('--distance')
    const distance = di > 0 ? Number(argv[di + 1]) : DEFAULT_DISTANCE_M
    const r = await video<ApplyResult>(`/api/video/cam-regions/default?force=${force ? 1 : 0}&distance=${encodeURIComponent(String(distance))}`)
    const t = new Date(r.backup.at)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`
    const name = `cam-regions-backup-${stamp}.json`
    writeFileSync(resolve(dir, name), JSON.stringify(r.backup, null, 2) + '\n', { mode: 0o600 })
    const camera = r.backup.camera
    console.log(`写之前的整份区域配置已备份：${name}（${r.backup.regions.length} 个区，启用 ${r.backup.regions.filter(x => x['regionEnable'] === true).length} 个）`)
    if (r.error) {
      console.error(`!! ${r.error}${r.rolledBack ? `；按备份写回：${r.rolledBack}` : ''}`)
      audit(dir, '写缺省测温区', false, `${camera}：${r.error}${r.rolledBack ? `；${r.rolledBack}` : ''}`)
      return 1
    }
    console.log(`已写 R1–R3（左 / 中 / 右三竖条，辐射率 ${DEFAULT_EMISSIVITY}、距离 ${distance} m${force ? '，--force 覆盖' : ''}）`)
    console.log(r.ok ? '读回核对：一致' : `!! 读回核对不一致：${r.mismatch.join('；')}`)
    console.log(`区域温度：${r.temps.map(x => `${x.name} 最高 ${x.max ?? '—'} 平均 ${x.avg ?? '—'}`).join('，')}${r.temps.some(x => x.max === null) ? '（还有没数的：过一会儿到本地页「本柜总览」看）' : ''}`)
    console.log('下一步：到子站网关页，把这台的「测温区」能力改回「已确认」')
    audit(dir, '写缺省测温区', r.ok, `${camera}：R1–R3 三竖条、辐射率 ${DEFAULT_EMISSIVITY}、距离 ${distance} m${force ? '（--force）' : ''}；备份 ${name}${r.ok ? '' : `；读回不一致：${r.mismatch.join('；')}`}`)
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
    if (r.error) {
      console.error(`!! ${r.error}`)
      audit(dir, '恢复测温区', false, `${b.camera}：${r.error}`)
      return 1
    }
    console.log(`已按备份（${b.at}）写回 ${r.written.length} 个区；读回核对${r.ok ? '一致' : `不一致：${r.mismatch.join('；')}`}`)
    audit(dir, '恢复测温区', r.ok, `${b.camera}：按备份 ${b.at} 写回 ${r.written.length} 个区${r.ok ? '' : `；不一致：${r.mismatch.join('；')}`}`)
    return r.ok ? 0 : 1
  }
  console.error('用法：cam-regions.ts default [--force] [--distance <米>] | restore <备份文件>')
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
