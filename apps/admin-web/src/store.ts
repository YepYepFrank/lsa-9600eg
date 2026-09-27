/* 全页共用的轮询数据：外壳（Shell）起停，各页只读。
 *   状态 2 s；诊断、组件、EG 自身指标 5 s（要调 Docker / Edge 库）；点表目录、配置进来取一次
 * 浏览器标签页在后台时暂停（document.hidden），回到前台立即刷一次。 */
import { reactive } from 'vue'
import { api } from './session'
import type { Catalog, Comp, Config, Diag, Live, Status } from './types'

export const store = reactive<{
  status: Status | null
  diag: Diag | null
  comps: Comp[]
  self: Live | null
  catalog: Catalog | null
  config: Config | null
  error: string
  updatedAt: number
}>({ status: null, diag: null, comps: [], self: null, catalog: null, config: null, error: '', updatedAt: 0 })

let timers: number[] = []

async function fast() {
  try {
    store.status = await api('status')
    store.error = ''
    store.updatedAt = Date.now()
  } catch (e) {
    store.error = (e as Error).message
  }
}

async function slow() {
  const [d, c, s] = await Promise.allSettled([api<Diag>('diag'), api<Comp[]>('components'), store.status ? api<Live>(`live/${store.status.eg}`) : Promise.reject()])
  if (d.status === 'fulfilled') store.diag = d.value
  if (c.status === 'fulfilled') store.comps = c.value
  if (s.status === 'fulfilled') store.self = s.value
}

export async function refreshConfig() {
  try {
    store.config = await api<Config>('config')
  } catch {
    /* 下次进页面再取 */
  }
}

export async function startPolling() {
  stopPolling()
  await fast()
  void slow()
  void refreshConfig()
  api<Catalog>('catalog')
    .then(c => (store.catalog = c))
    .catch(() => {})
  const onVis = () => {
    if (!document.hidden) {
      void fast()
      void slow()
    }
  }
  document.addEventListener('visibilitychange', onVis)
  timers = [
    window.setInterval(() => !document.hidden && fast(), 2000),
    window.setInterval(() => !document.hidden && slow(), 5000),
  ]
}

export function stopPolling() {
  for (const t of timers) clearInterval(t)
  timers = []
}

/** 立刻刷新诊断与组件（重启组件后用） */
export const refreshSlow = slow

/** EG 自身某指标的最新值 */
export function selfVal(key: string): number | null {
  const v = store.self?.telemetry[key]?.v
  return typeof v === 'number' ? v : null
}
