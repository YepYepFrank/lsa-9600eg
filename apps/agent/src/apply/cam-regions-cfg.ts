/* 配置下发里的测温区（0.9.0，子站「测温区设置」）：体里 camRegions: { <单元号 | 柜号>: { R<n>: { label, env } } }，只取本单元那份。
 *   有 → 写配置目录的 cam-regions.json（@lsa-eg/config 的 loadConfig 叠到摄像机属性 regions 上；eg-video 每轮看修改时间、马上换部位名和个数）；
 *   没有（子站没在网页改过这台，或老子站）→ 删掉 cam-regions.json，回到 eg.yaml 的。
 * 区的个数或温升对哪台 SAM 变了：agent 里派生 / 到数看护是开机时按区展开的，要重启 agent 才按新的来 —— 应用完几秒后自己退出，容器 unless-stopped 拉起来。
 * 只改部位名不重启（agent 不用部位名）。 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CAM_MAX_REGIONS, CAM_REGIONS_FILE, loadConfig, readCamRegions, type CamRegionsOverride, type EgConfig } from '@lsa-eg/config'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 部位名最长几个字（页面同样限制） */
export const LABEL_MAX = 32

/** 取本单元那份并校验；没带或没有本单元的返回 null；格式不对抛错（说法给回执） */
export function parseCamRegions(b: Record<string, unknown>, keys: string[]): CamRegionsOverride | null {
  const all = b['camRegions']
  if (all === undefined || all === null) return null
  if (!isObj(all)) throw new Error('camRegions 要是对象 { 单元号: { R<n>: { label, env } } }')
  const mine = keys.map(k => all[k]).find(v => v !== undefined)
  if (mine === undefined || mine === null) return null
  if (!isObj(mine)) throw new Error('camRegions 本单元那份要是对象 { R<n>: { label, env } }')
  const out: CamRegionsOverride = {}
  for (const [k, v] of Object.entries(mine)) {
    const m = /^R(\d{1,2})$/.exec(k)
    if (!m || Number(m[1]) < 1 || Number(m[1]) > CAM_MAX_REGIONS) throw new Error(`camRegions 的区号 ${k} 不对（R1–R${CAM_MAX_REGIONS}）`)
    if (!isObj(v) || typeof v['label'] !== 'string' || !v['label'].trim() || v['label'].length > LABEL_MAX) throw new Error(`camRegions.${k}.label 要是 1–${LABEL_MAX} 个字`)
    const env = v['env']
    if (env !== undefined && env !== null && typeof env !== 'string') throw new Error(`camRegions.${k}.env 要是设备名或空串`)
    out[k] = { label: v['label'].trim(), ...(env !== undefined ? { env } : {}) }
  }
  if (!Object.keys(out).length) throw new Error('camRegions 本单元那份一个区都没有（至少 1 个）')
  // 按区号排好（算哈希、比较都按这个顺序）
  return Object.fromEntries(Object.entries(out).sort(([a], [b2]) => Number(a.slice(1)) - Number(b2.slice(1))))
}

/** 区的「形状」：有哪几个区、各自 env（agent 开机按它展开派生 / 看护）；部位名不算 */
const shapeOf = (regions: unknown) =>
  JSON.stringify(
    Object.entries(isObj(regions) ? regions : {})
      .filter(([k]) => /^R\d{1,2}$/.test(k))
      .map(([k, v]) => [k, isObj(v) && 'env' in v ? v['env'] : '-'])
      .sort(([a], [b]) => Number(String(a).slice(1)) - Number(String(b).slice(1))),
  )

/** 写 / 删 cam-regions.json，把摄像机属性就地换成新的；返回要不要重启 agent（区的个数 / env 变了）与说法 */
export function applyCamRegions(cfg: EgConfig, o: CamRegionsOverride | null): { restart: boolean; text: string | null } {
  const file = resolve(cfg.dir, CAM_REGIONS_FILE)
  const had = readCamRegions(cfg.dir, cfg.unit.code)
  if (JSON.stringify(had) === JSON.stringify(o)) return { restart: false, text: null }
  if (o) writeFileSync(file, JSON.stringify({ unit: cfg.unit.code, regions: o, at: Date.now() }, null, 2) + '\n', 'utf8')
  else if (existsSync(file)) unlinkSync(file)
  const cam = cfg.devices.find(d => d.kind === 'camera')
  if (!cam) return { restart: false, text: null }
  // 新的样子：有覆盖就是它，没有就重读 eg.yaml（文件已删，loadConfig 不再叠）
  let next: unknown = o
  if (!o) {
    try {
      next = loadConfig(cfg.dir).devices.find(d => d.kind === 'camera')?.attrs['regions']
    } catch {
      next = undefined
    }
  }
  const restart = shapeOf(cam.attrs['regions']) !== shapeOf(next)
  cam.attrs = { ...cam.attrs, regions: next }
  const names = isObj(next) ? Object.entries(next).map(([k, v]) => `${k} ${isObj(v) ? String(v['label'] ?? '') : ''}`.trim()) : []
  return { restart, text: `测温区${o ? '按子站网页改的' : '回到 eg.yaml 的'}：${names.join('、') || '（缺省）'}${restart ? '；区的个数或温升来源变了，agent 稍后自动重启生效' : ''}` }
}

/** 开机核对：applied-config.json 里有测温区覆盖而文件没了（手工删、拷错目录）就补写（不重启：开机 loadConfig 时没叠上，派生按 eg.yaml，下次下发会纠正） */
export function ensureCamRegionsFile(cfg: EgConfig, o: CamRegionsOverride | null | undefined): boolean {
  if (!o) return false
  const file = resolve(cfg.dir, CAM_REGIONS_FILE)
  try {
    if (existsSync(file) && JSON.stringify((JSON.parse(readFileSync(file, 'utf8')) as { regions?: unknown }).regions) === JSON.stringify(o)) return false
  } catch {
    /* 坏了就重写 */
  }
  writeFileSync(file, JSON.stringify({ unit: cfg.unit.code, regions: o, at: Date.now() }, null, 2) + '\n', 'utf8')
  return true
}
