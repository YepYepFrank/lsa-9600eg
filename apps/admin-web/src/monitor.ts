/* 单柜监测页（本柜总览 / 电气量 / 事件与录像）的真实数据：只用 agent 已有与 eg-ui-v2 新开的接口，不回退到演示数据。
 *   实时值   GET live/<设备>               3 s（只取当前页用得到的设备）
 *   趋势     GET history?device=&keys=…   60 s，近 24 h 按 5 min 一桶（弧光脉冲 uv.pulse 原样取）
 *   测温区   GET video/status              30 s（区域定义与画面尺寸：按摄像机坐标画框）
 *   事件     GET alarms、GET evidence      10 s（事件与录像页）
 * 设备按种类找：camera（双光摄像机）、sam（按名字排序，A / B 隔室）、meter（多功能电表）、pm（颗粒物 / 烟气）。 */
import { computed, onBeforeUnmount, onMounted, reactive, watch, type Ref } from 'vue'
import { api } from './session'
import { store } from './store'
import type { Live } from './types'

export type MonitorTab = 'overview' | 'electric' | 'events'
export type Sample = [number, number | null]

export interface Region {
  id: string
  name: string
  label: string
  type: 'point' | 'line' | 'region' | 'polygon'
  coords: Record<string, number>
  frame: { w: number; h: number }
}
export interface AlarmRow {
  eventId: string
  revision: number
  device: string
  type: string
  severity: string
  state: 'ACTIVE' | 'CLEARED'
  occurredAt: number
  clearedAt: number | null
  details: Record<string, unknown>
  pending: boolean
}
export interface EvidenceItem {
  evidenceId: string
  eventId: string | null
  groupId: string
  channelId: 'visible' | 'ir' | 'data'
  kind: 'video' | 'image' | 'wave'
  requestedStart: number
  actualStart: number | null
  actualEnd: number | null
  status: string
  sizeBytes: number | null
  hasFile: boolean
  missingReason: string | null
}
interface History {
  series: Record<string, [number, number | string][]>
}

const HOURS = 24
const POINTS = 288

export function useMonitor(tab: Ref<MonitorTab>, enabled: Ref<boolean>) {
  const m = reactive({
    live: {} as Record<string, Live>,
    hist: {} as Record<string, History['series']>,
    regions: [] as Region[],
    alarms: [] as AlarmRow[],
    evidence: [] as EvidenceItem[],
    error: '',
    histAt: 0,
  })

  const devs = computed(() => store.status?.devices ?? [])
  const cam = computed(() => devs.value.find(d => d.kind === 'camera')?.name ?? null)
  const sams = computed(() => devs.value.filter(d => d.kind === 'sam').map(d => d.name).sort())
  const meter = computed(() => devs.value.find(d => d.kind === 'meter')?.name ?? null)
  const pm = computed(() => devs.value.find(d => d.kind === 'pm')?.name ?? null)
  const labelOf = (name: string) => devs.value.find(d => d.name === name)?.label || name

  /** 某量的最新值：设备或量不在、或质量码标了 invalid 就是 null（页面显示「—」，不拿陈旧值冒充） */
  function num(dev: string | null, key: string): number | null {
    if (!dev) return null
    const l = m.live[dev]
    const p = l?.telemetry[key]
    if (!p || l?.q[key] === 'invalid') return null
    const n = typeof p.v === 'number' ? p.v : Number(p.v)
    return Number.isFinite(n) ? n : null
  }
  function text(dev: string | null, key: string): string | null {
    const v = dev ? m.live[dev]?.telemetry[key]?.v : undefined
    return v === undefined || v === null ? null : String(v)
  }
  /** 趋势：数值序列（null 断线） */
  function series(dev: string | null, key: string): Sample[] {
    if (!dev) return []
    return (m.hist[dev]?.[key] ?? []).map(([t, v]) => [t, typeof v === 'number' ? v : null])
  }
  function has(dev: string | null, key: string): boolean {
    return !!dev && (!!m.live[dev]?.telemetry[key] || !!m.hist[dev]?.[key]?.length)
  }

  const liveDevices = computed(() =>
    tab.value === 'overview' ? [cam.value, ...sams.value, pm.value] : tab.value === 'electric' ? [meter.value] : [],
  )

  async function loadLive() {
    const names = liveDevices.value.filter((x): x is string => !!x)
    const got = await Promise.allSettled(names.map(n => api<Live>(`live/${encodeURIComponent(n)}`)))
    got.forEach((r, i) => {
      if (r.status === 'fulfilled') m.live[names[i]!] = r.value
    })
    const bad = got.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
    m.error = bad ? (bad.reason as Error).message : ''
  }

  async function hist(dev: string | null, keys: string[], agg = 'AVG') {
    if (!dev || !keys.length) return
    try {
      const r = await api<History>(`history?device=${encodeURIComponent(dev)}&keys=${keys.join(',')}&hours=${HOURS}&points=${POINTS}&agg=${agg}`)
      m.hist[dev] = { ...(m.hist[dev] ?? {}), ...r.series }
    } catch (e) {
      m.error = (e as Error).message
    }
  }
  async function loadHist() {
    if (tab.value === 'overview') {
      await Promise.all([
        hist(cam.value, ['ir.R1.max', 'ir.R2.max', 'ir.R3.max', 'ir.rmax', 'ir.rise']),
        ...sams.value.map(s => hist(s, ['env.t', 'env.rh', 'us.amp', 'us.cnt'])),
        ...sams.value.map(s => hist(s, ['uv.pulse'], 'NONE')),
        hist(pm.value, ['pm.1.0', 'pm.2.5', 'pm.10']),
      ])
    } else if (tab.value === 'electric') {
      await hist(meter.value, ['el.Ia', 'el.Ib', 'el.Ic', 'el.P'])
    }
    m.histAt = Date.now()
  }
  async function loadRegions() {
    try {
      const v = await api<{ measure?: { regions?: Region[] } }>('video/status')
      m.regions = v.measure?.regions ?? []
    } catch {
      m.regions = []
    }
  }
  async function loadEvents() {
    const [a, e] = await Promise.allSettled([api<{ alarms: AlarmRow[] }>('alarms?limit=200'), api<{ items: EvidenceItem[] }>('evidence?limit=500')])
    if (a.status === 'fulfilled') m.alarms = a.value.alarms
    if (e.status === 'fulfilled') m.evidence = e.value.items
  }

  let timers: number[] = []
  function stop() {
    for (const t of timers) clearInterval(t)
    timers = []
  }
  function start() {
    stop()
    if (!enabled.value || !store.status) return
    const every = (fn: () => Promise<void>, ms: number) => {
      void fn()
      timers.push(window.setInterval(() => !document.hidden && void fn(), ms))
    }
    if (tab.value !== 'events') {
      every(loadLive, 3000)
      every(loadHist, 60_000)
    }
    if (tab.value === 'overview') every(loadRegions, 30_000)
    // 总览顶上的事件条也要用活动告警
    every(loadEvents, 10_000)
  }
  onMounted(start)
  onBeforeUnmount(stop)
  watch([tab, enabled, () => !!store.status], start)

  return { m, cam, sams, meter, pm, labelOf, num, text, series, has, refresh: start }
}

/** 露点（Magnus 公式，与领导原型同一组系数） */
export function dewPoint(t: number | null, rh: number | null): number | null {
  if (t === null || rh === null || rh <= 0) return null
  const a = Math.log(rh / 100) + (17.62 * t) / (243.12 + t)
  return Math.round(((243.12 * a) / (17.62 - a)) * 10) / 10
}

/** 本柜实时画面：同源相对地址，经 agent 带会话鉴权反代到本机 mediamtx（WHEP，连不通退 HLS）。
 *  缺省用两路子码流（EG 上常拉常录，秒开、不去摄像机拉主码流）；main = true 用主码流（全屏看细节）。热像子码流与主码流同宽高比，测温框照样对得上 */
export function streamsOf(cab: string | undefined, main = false) {
  if (!cab) return null
  const one = (path: string) => ({ whep: `api/stream/${path}/whep`, hls: `api/stream/${path}/index.m3u8` })
  return main ? { vis: one(cab), ir: one(`${cab}-ir`) } : { vis: one(`${cab}-sub`), ir: one(`${cab}-ir-sub`) }
}
