<!-- 单柜监测（界面基线：领导 80e01ad「完善边缘网关单柜界面」）：本柜总览 / 电气量 / 事件与录像。
     demo = 开发服务器的 ?demo=1 演示（monitor-demo.ts）；否则一律接真实接口（monitor.ts），取不到显示「—」或「待接入」，不回退到演示数据。
     健康评分不在网关计算（设计文档）。点表里没有的通道显示「待确认」。 -->
<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import DualLightPlayer, { type Palette } from './kit/DualLightPlayer.vue'
import ThermoHygroDial from './kit/ThermoHygroDial.vue'
import MultiUnitTrend, { type UnitSeries } from './kit/MultiUnitTrend.vue'
import SensorPreviewTrend from './kit/SensorPreviewTrend.vue'
import { arcPreview, smokeSeries, climateSeries, countSeries, currentSeries, demoEvents, pdSeries } from '../monitor-demo'
import { dewPoint, streamsOf, useMonitor, type AlarmRow, type EvidenceItem } from '../monitor'
import { session } from '../session'
import { store } from '../store'

const props = defineProps<{ demo: boolean; tab: 'overview' | 'electric' | 'events' }>()
const emit = defineEmits<{ navigate: [tab: 'overview' | 'electric' | 'events' | 'manage'] }>()
const palette = ref<Palette>('iron')
const boxes = ref(true)
const camera = ref<HTMLElement>()
const selected = ref<Record<string, boolean>>({})
const eventFilter = ref('全部')
const TZ = 'Asia/Shanghai'
const time = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false, timeZone: TZ })
const f1 = (v: number | null, d = 1) => (v === null ? '—' : v.toFixed(d))
async function fullscreen() {
  try { await camera.value?.requestFullscreen() } catch { ElMessage.warning('当前浏览器无法进入全屏') }
}

const { m, cam, sams, meter, pm, labelOf, num, text, series, has } = useMonitor(toRef(props, 'tab'), computed(() => !props.demo))
const cab = computed(() => store.status?.cabinet.code)
/** 页面上的单位一律取点表；局放幅值按子站与现场口径写 dBμV（点表目前写的是 dB，已报后端统一） */
const UNIT_FIX: Record<string, string> = { 'us.amp': 'dBμV', 'uv.int': 'a.u.' }
const catalogUnit = (kind: string, key: string, fallback = '') => UNIT_FIX[key] ?? (store.catalog?.devices[kind]?.find(p => p.key === key)?.unit || fallback)

/* ---------- 总览：双光与测温区 ---------- */
const streams = computed(() => (cam.value ? streamsOf(cab.value) : null))
const hotId = computed(() => {
  const h = text(cam.value, 'ir.hot')
  return h === null ? null : /^\d+$/.test(h) ? `R${h}` : h
})
/** 测温区的部位名（eg.yaml CAM regions.R<n>.label，经 eg-video 的区域定义带来） */
const regionLabel = (id: string) => m.regions.find(r => r.id === id)?.label ?? ''
const rois = computed(() =>
  m.regions
    .map(r => {
      const W = r.frame?.w || 640
      const H = r.frame?.h || 512
      const c = r.coords
      const temp = r.type === 'point' ? num(cam.value, `ir.${r.id}.pt`) : num(cam.value, `ir.${r.id}.max`)
      const label = r.id
      const name = r.label
      if (r.type === 'point') return { label, name, temp, hot: r.id === hotId.value, x: c.x! / W - 0.015, y: c.y! / H - 0.02, w: 0.03, h: 0.04, point: true }
      if (c.width !== undefined) return { label, name, temp, hot: r.id === hotId.value, x: c.x! / W, y: c.y! / H, w: c.width / W, h: c.height! / H }
      // 线 / 多边形：画外接框
      const xs = Object.entries(c).filter(([k]) => /^x\d*$/.test(k)).map(([, v]) => v)
      const ys = Object.entries(c).filter(([k]) => /^y\d*$/.test(k)).map(([, v]) => v)
      if (!xs.length || !ys.length) return null
      return { label, name, temp, hot: r.id === hotId.value, x: Math.min(...xs) / W, y: Math.min(...ys) / H, w: (Math.max(...xs) - Math.min(...xs)) / W || 0.01, h: (Math.max(...ys) - Math.min(...ys)) / H || 0.01 }
    })
    .filter((x): x is NonNullable<typeof x> => !!x),
)
const frameAspect = computed(() => (m.regions[0]?.frame ? m.regions[0].frame.w / m.regions[0].frame.h : 1.25))
const tmax = computed(() => num(cam.value, 'ir.rmax') ?? num(cam.value, 'ir.max'))
const rise = computed(() => num(cam.value, 'ir.rise'))

/* ---------- 总览：柜内温湿度（按隔室的 SAM 选） ---------- */
const samSel = ref('')
watch(sams, s => { if (!s.includes(samSel.value)) samSel.value = s[0] ?? '' }, { immediate: true })
const envT = computed(() => num(samSel.value || null, 'env.t'))
const envRh = computed(() => num(samSel.value || null, 'env.rh'))
const dew = computed(() => dewPoint(envT.value, envRh.value))
const realClimate = computed<UnitSeries[]>(() => [
  ...['R1', 'R2', 'R3'].map((r, i) => ({ name: `测温区 ${r}`, unit: '℃', color: ['var(--s3)', 'var(--s4)', 'var(--s5)'][i], data: series(cam.value, `ir.${r}.max`) })).filter(s => s.data.length),
  { name: '环境温度', unit: '℃', color: 'var(--s2)', data: series(samSel.value || null, 'env.t') },
  { name: '相对湿度', unit: '%', color: 'var(--s1)', data: series(samSel.value || null, 'env.rh') },
])
const climate = computed(() => (props.demo ? climateSeries : realClimate.value))

/* ---------- 总览：超声局放（各 SAM 取大） ---------- */
const ampUnit = computed(() => catalogUnit('sam', 'us.amp', 'dBμV'))
const cntUnit = computed(() => catalogUnit('sam', 'us.cnt', '次/min'))
const maxOver = (key: string) => {
  const vs = sams.value.map(s => ({ s, v: num(s, key) })).filter((x): x is { s: string; v: number } => x.v !== null)
  return vs.length ? vs.reduce((a, b) => (b.v > a.v ? b : a)) : null
}
const pdAmp = computed(() => maxOver('us.amp'))
const pdCnt = computed(() => maxOver('us.cnt'))
const shortSam = (s: string) => s.replace(/^SAM-[^-]+-?/, 'SAM-') || s
const realDischarge = computed<UnitSeries[]>(() => [
  ...sams.value.map((s, i) => ({ name: `局放幅值 ${shortSam(s)}`, unit: ampUnit.value, color: ['var(--s1)', 'var(--s6)', 'var(--s7)'][i % 3], data: series(s, 'us.amp') })),
  ...sams.value.map((s, i) => ({ name: `局放次数 ${shortSam(s)}`, unit: cntUnit.value, color: ['var(--s2)', 'var(--s4)', 'var(--s8)'][i % 3], data: series(s, 'us.cnt') })),
])
const dischargeSeries = computed(() => (props.demo ? [...pdSeries, ...countSeries] : realDischarge.value))
const dischargeUnits = computed(() => (props.demo ? ['dBμV', '次'] : [ampUnit.value, cntUnit.value]))
const dischargeScales = computed(() => {
  const cnt = props.demo ? countSeries.flatMap(s => s.data.map(p => p[1])) : realDischarge.value.filter(s => s.unit === cntUnit.value).flatMap(s => s.data.map(p => p[1] ?? 0))
  return { [dischargeUnits.value[1]!]: { min: 0, max: Math.max(4, ...cnt), interval: Math.max(1, Math.ceil(Math.max(4, ...cnt) / 4)) } }
})
const pdAxisColors = computed(() => ({ [dischargeUnits.value[0]!]: 'var(--s1)', [dischargeUnits.value[1]!]: 'var(--s2)' }))
const hasPd = computed(() => sams.value.some(s => has(s, 'us.amp')))

/* ---------- 总览：烟雾 / 气体（照点表：≥1.0 μm 颗粒数 个/L、PM2.5、PM10 μg/m³；传感器选型定了再改） ---------- */
const PM_KEYS = [
  { key: 'pm.1.0', name: '≥1.0 μm 颗粒数', color: 'var(--s3)' },
  { key: 'pm.2.5', name: 'PM2.5', color: 'var(--s1)' },
  { key: 'pm.10', name: 'PM10', color: 'var(--s4)' },
]
const pmReadings = computed(() => PM_KEYS.map(p => ({ ...p, unit: catalogUnit('pm', p.key), v: num(pm.value, p.key) })))
// 趋势只画质量浓度（μg/m³）两路；PM1.0 点表是颗粒数（个/L），量级不同，只给读数
const pmSeries = computed<UnitSeries[]>(() => PM_KEYS.slice(1).map(p => ({ name: p.name, unit: catalogUnit('pm', p.key, 'μg/m³'), color: p.color, data: series(pm.value, p.key) })))

/* ---------- 总览：UV 弧光（各 SAM 的 uv.pulse 近 24 h） ---------- */
const arcPulses = computed(() =>
  sams.value
    .flatMap(s => (m.hist[s]?.['uv.pulse'] ?? []).map(([t, v]) => {
      try {
        const o = (typeof v === 'string' ? JSON.parse(v) : {}) as { peak?: number; ms?: number }
        return { time: t, value: Number(o.peak) || 0, duration: Number(o.ms) || 0 }
      } catch { return null }
    }))
    .filter((p): p is { time: number; value: number; duration: number } => !!p)
    .sort((a, b) => a.time - b.time),
)
const arcNow = computed(() => maxOver('uv.int'))
const arcFrom = computed(() => Date.now() - 86_400_000)
const hasArc = computed(() => sams.value.some(s => has(s, 'uv.int')))

/* ---------- 电气量（多功能电表 el.*） ---------- */
const eu = (key: string, fb = '') => catalogUnit('meter', key, fb)
const eRow = (label: string, key: string, digits = 1, unit?: string) => {
  const v = num(meter.value, key)
  const u = unit ?? eu(key)
  return [label, v === null ? '—' : `${v.toFixed(digits)}${u ? ' ' + u : ''}`] as [string, string]
}
const electricDemo = [
  { label: '相电压', unit: 'V', items: [['Ua', '229.9 V'], ['Ub', '230.7 V'], ['Uc', '230.2 V']] },
  { label: '三相电流', unit: 'A', items: [['Ia', '216.4 A'], ['Ib', '210.8 A'], ['Ic', '213.6 A']] },
  { label: '功率', unit: '', items: [['有功', '142.6 kW'], ['无功', '28.4 kvar'], ['视在', '145.4 kVA']] },
  { label: '其他测量', unit: '', items: [['功率因数', '0.981'], ['频率', '50.00 Hz'], ['正向有功电能', '125680.4 kWh'], ['负荷率', '54.1 %']] },
]
const electric = computed(() =>
  props.demo
    ? electricDemo
    : [
        { label: '相电压', unit: 'V', items: [eRow('Ua', 'el.Ua', 1, 'V'), eRow('Ub', 'el.Ub', 1, 'V'), eRow('Uc', 'el.Uc', 1, 'V')] },
        { label: '三相电流', unit: 'A', items: [eRow('Ia', 'el.Ia', 1, 'A'), eRow('Ib', 'el.Ib', 1, 'A'), eRow('Ic', 'el.Ic', 1, 'A')] },
        { label: '功率', unit: '', items: [eRow('有功', 'el.P', 1, 'kW'), eRow('无功', 'el.Q', 1, 'kvar'), eRow('视在', 'el.S', 1, 'kVA')] },
        { label: '其他测量', unit: '', items: [eRow('功率因数', 'el.PF', 3, ''), eRow('频率', 'el.F', 2, 'Hz'), eRow('正向有功电能', 'el.Ep', 1, 'kWh'), eRow('负荷率', 'el.load_pct', 1, '%')] },
      ],
)
const realCurrent = computed<UnitSeries[]>(() => ['a', 'b', 'c'].map((p, i) => ({ name: `${p.toUpperCase()} 相电流`, unit: 'A', color: ['var(--s4)', 'var(--s3)', 'var(--s6)'][i], data: series(meter.value, `el.I${p}`) })))
const current = computed(() => (props.demo ? currentSeries : realCurrent.value))

/* ---------- 事件与录像 ---------- */
const SEV: Record<string, [string, string]> = { CRITICAL: ['紧急', 'var(--crit)'], MAJOR: ['重要', 'var(--major)'], MINOR: ['次要', 'var(--minor)'], WARNING: ['提示', 'var(--info)'], INDETERMINATE: ['记录', 'var(--muted)'] }
const SEV_ORDER = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'INDETERMINATE']
/** 量的简称（告警描述用）；没列的取点表标签 */
const QTY: Record<string, string> = {
  'ir.rise': '温升', 'ir.rmax': '最高温', 'ir.max': '最高温', 'ir.dmax': '区域温差', 'uv.int': '弧光强度', 'us.amp': '局放幅值', 'us.cnt': '局放次数',
  'env.t': '环境温度', 'env.rh': '相对湿度', 'el.load_pct': '负荷率', 'dev.link': '通信',
}
function qtyOf(dev: string, key: string): string {
  if (QTY[key]) return QTY[key]!
  if (/^ir\.R\d+\.(max|pt)$/.test(key)) return '温度'
  const kind = store.status?.devices.find(d => d.name === dev)?.kind ?? ''
  return store.catalog?.devices[kind]?.find(p => p.key === key)?.label ?? key
}
/** 与子站同一口径：「部位 — 量 值 单位，阈值 x 单位」。摄像机告警的部位用热点区（details.hot，或键里的 R<n>） */
function detailOf(a: AlarmRow): string {
  const d = a.details
  const key = typeof d['key'] === 'string' ? d['key'] : ''
  const kind = store.status?.devices.find(x => x.name === a.device)?.kind ?? ''
  const unit = UNIT_FIX[key] ?? (typeof d['unit'] === 'string' ? d['unit'] : '')
  const u = (x: unknown) => `${x}${unit ? ' ' + unit : ''}`
  let place = labelOf(a.device)
  if (kind === 'camera') {
    const rn = typeof d['hot'] === 'number' ? `R${d['hot']}` : /^ir\.(R\d+)\./.exec(key)?.[1]
    if (rn) place = `${regionLabel(rn) || '测温区'}（${rn}）`
  }
  if (key === 'dev.link') return `${place} — 通信中断`
  const v = d['value'] ?? d['val']
  const th = d['threshold']
  const val = v !== undefined && v !== null ? `${qtyOf(a.device, key)} ${u(v)}` : typeof d['rule'] === 'string' ? d['rule'] : ''
  return `${place}${val ? ' — ' + val : ''}${th !== undefined && th !== null ? `，阈值 ${u(th)}` : ''}`
}
interface EvRow { id: string; time: number; level: string; color: string; type: string; detail: string; state: string; ev: EvidenceItem[] }
const evByEvent = computed(() => {
  const g = new Map<string, EvidenceItem[]>()
  for (const e of m.evidence) if (e.eventId) g.set(e.eventId, [...(g.get(e.eventId) ?? []), e])
  return g
})
const realEvents = computed<EvRow[]>(() =>
  m.alarms.map(a => ({
    id: a.eventId,
    time: a.occurredAt,
    level: SEV[a.severity]?.[0] ?? a.severity,
    color: SEV[a.severity]?.[1] ?? 'var(--muted)',
    type: a.type,
    detail: detailOf(a),
    state: a.state === 'ACTIVE' ? '发生' : `已恢复 ${new Date(a.clearedAt ?? a.occurredAt).toLocaleTimeString('zh-CN', { hour12: false, timeZone: TZ })}`,
    ev: evByEvent.value.get(a.eventId) ?? [],
  })),
)
const eventTypes = computed(() => (props.demo ? ['温升', '通信'] : [...new Set(m.alarms.map(a => a.type))]))
const events = computed<EvRow[]>(() => {
  const all = props.demo ? demoEvents.map(e => ({ ...e, ev: [] as EvidenceItem[] })) : realEvents.value
  return all.filter(e => eventFilter.value === '全部' || e.type.includes(eventFilter.value))
})
/** 顶上的事件条：级别最高、最新的一条活动告警 */
const topAlarm = computed(() => {
  const act = m.alarms.filter(a => a.state === 'ACTIVE')
  act.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || b.occurredAt - a.occurredAt)
  return act[0] ?? null
})
const EVK: Record<string, string> = { video: '视频', image: '抓图', wave: '录波' }
const EVC: Record<string, string> = { visible: '可见光', ir: '热像', data: '传感器' }
const evText = (list: EvidenceItem[]) => {
  const ok = list.filter(e => e.hasFile)
  return list.length ? `${ok.length} / ${list.length} 个文件` : '—'
}

/* 录像回放：选中一个事件的证据组，双光视频并排放，抓图、录波可下载 */
const play = ref<{ title: string; items: { id: string; label: string; kind: string; url: string | null; err: string }[] } | null>(null)
async function blobOf(id: string): Promise<string> {
  const r = await fetch(`api/evidence/${encodeURIComponent(id)}/file`, { headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} })
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? `取文件失败（${r.status}）`)
  return URL.createObjectURL(await r.blob())
}
async function openEvidence(row: EvRow) {
  for (const it of play.value?.items ?? []) if (it.url) URL.revokeObjectURL(it.url)
  const list = [...row.ev].sort((a, b) => ['video', 'image', 'wave'].indexOf(a.kind) - ['video', 'image', 'wave'].indexOf(b.kind) || a.channelId.localeCompare(b.channelId))
  play.value = { title: `${row.type} · ${time(row.time)}`, items: list.map(e => ({ id: e.evidenceId, label: `${EVK[e.kind]} · ${EVC[e.channelId]}`, kind: e.kind, url: null, err: e.hasFile ? '' : e.missingReason ? `缺证：${e.missingReason}` : e.status })) }
  for (const it of play.value.items) {
    if (it.err || it.kind === 'wave') continue
    try { it.url = await blobOf(it.id) } catch (e) { it.err = (e as Error).message }
  }
}
async function download(id: string, label: string) {
  try {
    const url = await blobOf(id)
    const a = document.createElement('a')
    a.href = url
    a.download = `${label.replace(/\s|·/g, '')}-${id.slice(0, 8)}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  } catch (e) { ElMessage.error((e as Error).message) }
}
</script>

<template>
  <div class="cab-monitor" :class="{ 'overview-page': tab === 'overview' }">
    <div v-if="demo" class="cab-warning"><span class="warning-tag">演示事件</span>温升越限 · 测温区 R2 78.6℃，温升 52.1 K <button @click="emit('navigate', 'events')">查看事件 ›</button></div>
    <div v-else-if="topAlarm" class="cab-warning" :class="'sev-' + topAlarm.severity"><span class="warning-tag">{{ SEV[topAlarm.severity]?.[0] ?? topAlarm.severity }}</span>{{ topAlarm.type }} · {{ detailOf(topAlarm) }} · {{ time(topAlarm.occurredAt) }} <button @click="emit('navigate', 'events')">查看事件 ›</button></div>

    <div v-if="tab === 'overview'" class="monitor-grid">
      <section class="monitor-card camera-card">
        <div class="monitor-card-heading"><b>双光摄像头</b><span v-if="!demo && cam" class="muted">{{ labelOf(cam) }}</span><span class="grow"/><select v-model="palette" aria-label="热像调色板" :disabled="!demo" :title="demo ? '' : '实况热像的伪彩由摄像机出'"><option value="iron">铁红</option><option value="white">白热</option><option value="rainbow">彩虹</option></select><label><input v-model="boxes" type="checkbox" :disabled="!demo && !rois.length" />测温标注</label><button @click="fullscreen">全屏</button></div>
        <div ref="camera" class="camera-frame">
          <DualLightPlayer v-if="demo" fill big mode="side" :palette="palette" :boxes="boxes ? [62.2, 78.6, 62.4] : false" :box-labels="['R1', 'R2', 'R3']" :tmax="78.6" :env-t="26.5" />
          <DualLightPlayer v-else fill big mode="side" :palette="palette" :streams="streams" :boxes="boxes && rois.length ? true : false" :rois="rois" :frame-aspect="frameAspect" :tmax="tmax" :env-t="envT" :offline="!cam" offline-text="本柜没有配置双光摄像机" />
        </div>
        <div class="camera-summary"><div>最高温 <b>{{ demo ? '78.6' : f1(tmax) }}</b><small>℃</small></div><div>温升 <b>{{ demo ? '52.1' : f1(rise) }}</b><small>K</small></div></div>
      </section>
      <div class="sensor-stack">
      <section class="monitor-card pd-card">
        <div class="monitor-card-heading"><b>超声局放</b><span v-if="!demo && pdAmp && sams.length > 1" class="muted" :title="'各隔室取大，当前最大在 ' + labelOf(pdAmp.s)">{{ shortSam(pdAmp.s) }} 最大</span><span class="grow"/><span class="muted">近 24h</span></div>
        <div class="sensor-values"><div><span>局放幅值</span><b>{{ demo ? '6.2' : f1(pdAmp?.v ?? null) }} <small>{{ demo ? 'dBμV' : ampUnit }}</small></b></div><div><span>局放次数</span><b>{{ demo ? '2' : f1(pdCnt?.v ?? null, 0) }} <small>{{ demo ? '次' : cntUnit }}</small></b></div></div>
        <MultiUnitTrend v-if="demo || hasPd" :series="dischargeSeries" :units="dischargeUnits" :height="125" compact hide-legend center-unit-names :scales="dischargeScales" :axis-colors="pdAxisColors" />
        <div v-else class="monitor-empty">尚未接入局放监测数据</div>
      </section>
      <section class="monitor-card smoke-card">
        <div class="monitor-card-heading"><b>烟雾 / 气体监测</b><span class="grow"/><span class="pending" :title="demo ? '颗粒物通道用于演示，待实际传感器选型后调整' : '按点表 pm 设备的 key 与单位接入；传感器型号待确认'">{{ demo ? '模拟 · μg/m³' : pm ? '实测 · 型号待确认' : '选型待定' }}</span></div>
        <template v-if="demo">
          <div class="preview-readings smoke-readings"><div v-for="s in smokeSeries" :key="s.name"><span><i :style="{ background: s.color }"/>{{ s.name }}</span><b>{{ s.data[s.data.length - 1][1] }}</b></div></div>
          <SensorPreviewTrend :series="smokeSeries" />
        </template>
        <template v-else-if="pm">
          <div class="preview-readings smoke-readings"><div v-for="s in pmReadings" :key="s.key" :title="s.unit"><span><i :style="{ background: s.color }"/>{{ s.name }}</span><b>{{ f1(s.v, s.key === 'pm.1.0' ? 0 : 1) }}</b><small>{{ s.unit }}</small></div></div>
          <SensorPreviewTrend :series="pmSeries" />
        </template>
        <div v-else class="monitor-empty"><span class="empty-symbol">◌</span><strong>传感器待确认</strong><span>确定型号与接口后接入</span></div>
      </section>
      </div>
      <section class="monitor-card climate-card">
        <div class="monitor-card-heading"><b>柜内温湿度</b><select v-if="!demo && sams.length > 1" v-model="samSel" aria-label="隔室" class="sam-sel"><option v-for="s in sams" :key="s" :value="s">{{ labelOf(s) }}</option></select><span class="grow"/><div class="climate-legend"><button v-for="s in climate" :key="s.name" :aria-pressed="selected[s.name] !== false" :class="{ inactive: selected[s.name] === false }" @click="selected = { ...selected, [s.name]: selected[s.name] === false }"><i :style="{ background: s.color }"/>{{ s.name }}</button></div></div>
        <div class="climate-layout"><div class="dial-column"><ThermoHygroDial compact :temperature="demo ? 26.5 : envT" :humidity="demo ? 56 : envRh" :min="0" :max="100" /><div class="dew-reading">计算露点 <b>{{ demo ? dewPoint(26.5, 56) : f1(dew) }}<small> ℃</small></b><el-tooltip content="计算露点由柜内空气温度和相对湿度计算得到。壳体表面温度低于此温度时，有凝露风险。" placement="bottom" :popper-style="{ maxWidth: '320px', lineHeight: '1.6' }"><button aria-label="计算露点说明">?</button></el-tooltip></div></div><MultiUnitTrend v-if="demo || climate.some(s => s.data.length)" :series="climate" :height="215" compact hide-legend center-unit-names :selected="selected" :scales="{ '℃': { min: 0, max: 100, interval: 20 }, '%': { min: 0, max: 100, interval: 20 } }" :axis-colors="{ '℃': 'var(--s2)', '%': 'var(--s1)' }" /><div v-else class="monitor-empty">等待温湿度数据</div></div>
      </section>
      <section class="monitor-card arc-card">
        <div class="monitor-card-heading"><b>UV 弧光监测</b><span class="grow"/><span v-if="!demo && hasArc" class="muted">当前 {{ f1(arcNow?.v ?? null, 0) }} a.u.</span><span class="pending" title="相对强度使用任意单位 a.u.，待实际产品确定后调整">{{ demo ? '模拟 · 近 24h' : hasArc ? '实测 · 近 24h' : '接口待确认' }}</span></div>
        <template v-if="demo">
          <div class="preview-readings arc-readings"><div><span>峰值强度</span><b>{{ Math.max(...arcPreview.pulses.map(p => p.value)) }}<small> a.u.</small></b></div><div><span>脉冲次数</span><b>{{ arcPreview.pulses.length }}<small> 次</small></b></div></div>
          <SensorPreviewTrend :pulses="arcPreview.pulses" :from="arcPreview.from" :to="arcPreview.to" />
        </template>
        <template v-else-if="hasArc">
          <div class="preview-readings arc-readings"><div><span>峰值强度</span><b>{{ arcPulses.length ? Math.max(...arcPulses.map(p => p.value)) : '—' }}<small> a.u.</small></b></div><div><span>脉冲次数</span><b>{{ arcPulses.length }}<small> 次</small></b></div></div>
          <SensorPreviewTrend :pulses="arcPulses" :from="arcFrom" :to="Date.now()" />
        </template>
        <div v-else class="arc-placeholder"><b>—</b><span>量值与单位待协议确认</span></div>
      </section>
    </div>

    <template v-else-if="tab === 'electric'">
      <div v-if="!demo && !meter" class="monitor-card"><div class="monitor-empty">本柜没有配置电表（eg.yaml 设备清单里没有 meter）</div></div>
      <template v-else>
      <div class="electric-grid"><section v-for="group in electric" :key="group.label" class="monitor-card"><div class="monitor-card-heading"><b>{{ group.label }}</b><span class="grow"/><span class="muted">{{ group.unit }}</span></div><div v-for="item in group.items" :key="item[0]" class="electric-row"><span>{{ item[0] }}</span><b>{{ item[1] }}</b></div></section></div>
      <section class="monitor-card electric-chart"><div class="monitor-card-heading"><b>三相电流趋势</b><span class="grow"/><span class="muted">近 24h{{ demo ? ' · 模拟数据' : ' · 5 min 平均' }}</span></div><MultiUnitTrend v-if="demo || current.some(s => s.data.length)" :series="current" :height="320" /><div v-else class="monitor-empty">等待电表数据</div></section>
      </template>
    </template>

    <template v-else>
      <section class="monitor-card"><div class="monitor-card-heading"><b>本地事件记录</b><span v-if="!demo" class="muted">EG 本地 TB 告警 · 事件库</span><span class="grow"/><select v-model="eventFilter" aria-label="事件类型"><option>全部</option><option v-for="t in eventTypes" :key="t">{{ t }}</option></select></div><div class="table-scroll" :class="{ 'events-scroll': !demo }"><table class="event-table"><thead><tr><th>时间</th><th>级别</th><th>事件</th><th>描述</th><th>状态</th><th>关联录像</th></tr></thead><tbody><tr v-for="e in events" :key="e.id"><td>{{ time(e.time) }}</td><td :style="{ color: e.color }">{{ e.level }}</td><td>{{ e.type }}</td><td>{{ e.detail }}</td><td>{{ e.state }}</td><td><template v-if="demo"><span class="muted">演示事件 · 无录像文件</span></template><button v-else-if="e.ev.length" class="text-link" @click="openEvidence(e)">{{ evText(e.ev) }} ›</button><span v-else class="muted">—</span></td></tr><tr v-if="!events.length"><td colspan="6" class="monitor-empty">{{ demo || m.alarms.length ? '没有匹配的事件' : '本机还没有告警事件' }}</td></tr></tbody></table></div></section>
      <section class="monitor-card recording-card"><div class="monitor-card-heading"><b>双光录像</b><span v-if="play" class="muted">{{ play.title }}</span><span class="grow"/><span class="pending">{{ demo ? '待接入' : '告警证据 · 前 30 s / 后 60 s' }}</span></div>
        <div v-if="play" class="evidence-play">
          <div v-for="it in play.items" :key="it.id" class="ev-item" :class="it.kind">
            <div class="ev-cap">{{ it.label }}<span class="grow"/><button v-if="!it.err" class="text-link" @click="download(it.id, it.label)">下载</button></div>
            <video v-if="it.kind === 'video' && it.url" :src="it.url" controls muted playsinline />
            <img v-else-if="it.kind === 'image' && it.url" :src="it.url" alt="告警抓拍" />
            <div v-else class="ev-note">{{ it.err || (it.kind === 'wave' ? '录波数据（JSON），点「下载」查看' : '加载中…') }}</div>
          </div>
        </div>
        <div v-else class="monitor-empty"><span class="empty-symbol">▷</span><strong>{{ demo ? '尚未连接本地录像服务' : '在上表点「关联录像」回放' }}</strong><span>{{ demo ? '接入后可按时间回看，并从事件定位前后录像片段。' : '告警发生时 EG 自动锁定双光视频、抓图与录波（循环录像留 24 h）。' }}</span></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.smoke-card{display:flex;flex-direction:column;min-height:0}
.smoke-card>.monitor-card-heading,.arc-card>.monitor-card-heading{flex:none}
.preview-readings{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 14px 4px;flex:none}
.preview-readings>div{display:flex;align-items:baseline;gap:6px;white-space:nowrap}
.preview-readings span{font-size:10px;color:var(--muted)}
.preview-readings b{font-size:17px;font-variant-numeric:tabular-nums}
.preview-readings small{font-size:10px;font-weight:400;color:var(--text2)}
.preview-readings i{display:inline-block;width:6px;height:2px;vertical-align:middle;margin-right:4px}
.arc-readings{justify-content:flex-start;gap:20px}
.sensor-stack{display:grid;grid-template-rows:auto minmax(0,1fr);gap:12px;min-width:0}.arc-card{display:flex;flex-direction:column}.arc-card>.monitor-card-heading{flex:none}.arc-placeholder{flex:1}
.cab-monitor{font-size:13px}.pd-card{align-self:start;padding-bottom:12px}button,select{font:inherit;color:var(--text2);background:var(--surface2);border:1px solid var(--line2);border-radius:4px;padding:4px 9px;cursor:pointer}button:hover{color:var(--brand-ink);border-color:var(--brand)}button:focus-visible,select:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.cab-warning{margin-bottom:12px;display:flex;align-items:center;gap:10px;background:rgba(var(--major-rgb),.10);border:1px solid rgba(var(--major-rgb),.35);padding:7px 10px;border-radius:4px;font-size:12px}.warning-tag{background:var(--major);color:#171d20;padding:1px 5px;border-radius:3px}.cab-warning button{margin-left:auto;background:none;border:0;color:var(--brand-ink)}.monitor-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(300px,2fr);gap:12px}.monitor-card{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;overflow:hidden}.monitor-card-heading{display:flex;align-items:center;gap:10px;padding:12px;min-height:22px;font-size:12px}.monitor-card-heading label{display:flex;align-items:center;gap:4px;color:var(--s1);font-size:11px}.monitor-card-heading select,.monitor-card-heading button{font-size:11px}.grow{flex:1}.camera-frame{margin:0 12px;height:305px;min-width:0}.camera-frame:fullscreen{height:100vh;margin:0;background:#080b0d;padding:20px;box-sizing:border-box}.camera-summary{display:flex;justify-content:flex-end;align-items:center;gap:20px;padding:12px;color:var(--muted);font-size:12px}.camera-summary b{font-size:22px;color:var(--major);margin-left:8px}.camera-summary small{margin-left:4px}.sensor-values{display:flex;align-items:baseline;gap:18px;margin:2px 20px 14px}.sensor-values>div{display:flex;align-items:baseline;gap:6px;white-space:nowrap}.sensor-values span{color:var(--muted);font-size:11px}.sensor-values b{font-size:22px}.sensor-values small{font-size:11px;font-weight:400;color:var(--text2)}.climate-card>.monitor-card-heading{justify-content:flex-end}.climate-legend{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.climate-legend button{display:flex;align-items:center;gap:4px;border:0;background:none;padding:0;font-size:10px}.climate-legend .inactive{opacity:.35}.climate-legend i{width:9px;height:2px}.climate-layout{display:grid;grid-template-columns:minmax(220px,28%) minmax(0,1fr);align-items:center;padding:0 6px 10px}.dial-column{min-width:0}.dial-column :deep(.climate-dial){justify-content:center;--dial-size:155px}.dew-reading{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:4px;font-size:11px;color:var(--muted)}.dew-reading b{color:var(--text);font-size:15px}.dew-reading small{font-weight:400;font-size:11px}.dew-reading button{width:17px;height:17px;padding:0;border-radius:50%;background:none;font-size:10px}.pending{font-size:10px;color:var(--muted);border:1px solid var(--line2);border-radius:3px;padding:2px 5px}.monitor-empty{display:flex;min-height:160px;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--muted);font-size:12px;text-align:center;padding:12px}.monitor-empty strong{font-weight:400;color:var(--text2)}.empty-symbol{font-size:36px;opacity:.55}.event-list{padding:0 12px 8px}.event-row{display:flex;align-items:center;gap:10px;border-top:1px solid var(--line);padding:10px 0;font-size:11px}.event-row time{color:var(--muted);font-variant-numeric:tabular-nums}.event-level{white-space:nowrap}.event-detail{flex:1}.event-state{color:var(--muted);white-space:nowrap}.text-link{border:0;background:none;color:var(--brand-ink)}.arc-placeholder{display:flex;gap:12px;align-items:center;padding:26px 18px;color:var(--muted);font-size:12px}.arc-placeholder b{font-size:30px}.electric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.electric-row{display:flex;justify-content:space-between;gap:10px;margin:0 14px;padding:16px 0;border-top:1px solid var(--line);color:var(--text2);font-size:12px}.electric-row b{color:var(--text);font-size:17px;font-variant-numeric:tabular-nums}.electric-chart,.recording-card{margin-top:12px}.table-scroll{overflow:auto}.event-table{width:100%;border-collapse:collapse;font-size:12px;text-align:left;white-space:nowrap}.event-table th,.event-table td{padding:15px 14px;border-top:1px solid var(--line)}.event-table th{color:var(--muted);font-weight:400}.event-table td.monitor-empty{display:table-cell}.recording-card .monitor-empty{min-height:230px}
/* EG：接真实数据后补的几处（不用 color-mix，照顾 Chromium 88） */
.smoke-readings{flex-wrap:wrap;justify-content:flex-start;gap:2px 14px}.events-scroll{max-height:min(46vh,480px)}.events-scroll th{position:sticky;top:0;background:var(--surface);z-index:1}
.muted{color:var(--muted)}.monitor-card-heading>.muted{font-size:11px}.src-tag{font-size:10px;color:var(--muted);border:1px solid var(--line2);border-radius:3px;padding:1px 5px}.sam-sel{font-size:11px;padding:2px 6px}
.cab-warning.sev-CRITICAL{background:rgba(var(--crit-rgb),.10);border-color:rgba(var(--crit-rgb),.4)}.cab-warning.sev-CRITICAL .warning-tag{background:var(--crit);color:#fff}
.evidence-play{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 12px 12px}.ev-item{min-width:0;display:flex;flex-direction:column;gap:6px}.ev-item.wave{grid-column:1/-1}.ev-cap{display:flex;align-items:center;font-size:11px;color:var(--text2)}.ev-item video,.ev-item img{width:100%;aspect-ratio:16/10;object-fit:contain;background:#0b0d0e;border-radius:4px}.ev-note{padding:14px;border:1px dashed var(--line2);border-radius:4px;color:var(--muted);font-size:11px}
@media(min-width:1600px){.camera-frame{height:355px}.sensor-values{margin:16px 20px 28px}.pd-card :deep(.multi-unit-trend){margin-top:10px}.climate-layout{padding-bottom:16px}}
@media(max-width:1150px){.monitor-grid{grid-template-columns:minmax(0,1fr) 300px}.climate-layout{grid-template-columns:1fr}.dial-column{display:flex;align-items:center;justify-content:center}.dial-column :deep(.climate-dial){width:auto;--dial-size:120px}.dew-reading{margin-left:16px}.climate-legend{gap:5px}.electric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.camera-frame{height:270px}.camera-summary{gap:10px}}
@media(max-width:1150px){.arc-card :deep(.sensor-preview-trend),.smoke-card :deep(.sensor-preview-trend){min-height:110px}}
@media(max-width:850px){.monitor-grid{grid-template-columns:1fr}.camera-frame{height:300px}.cab-warning{flex-wrap:wrap}.climate-layout{grid-template-columns:1fr}.electric-grid{grid-template-columns:1fr 1fr}.evidence-play{grid-template-columns:1fr}}
@media(max-width:520px){.camera-frame{height:200px}.electric-grid{grid-template-columns:1fr}.dial-column{flex-direction:column}}
/* 桌面总览使用可用高度分配两行，不通过隐藏溢出裁掉监测内容。 */
@media(min-width:1151px) and (min-height:700px){
  .overview-page{height:100%;display:flex;flex-direction:column;min-height:0}
  .overview-page>.cab-warning{flex:none}
  .overview-page>.monitor-grid{flex:1;min-height:0;grid-template-rows:minmax(0,1fr) clamp(174px,24.5vh,230px)}
  .camera-card,.climate-card,.smoke-card{display:flex;flex-direction:column;min-height:0}
  .monitor-card-heading,.camera-summary{flex:none}
  .camera-frame:not(:fullscreen){flex:1;min-height:120px;height:auto}
  .climate-card>.monitor-card-heading{padding-top:6px;padding-bottom:6px}
  .climate-layout{flex:1;min-height:0;padding-bottom:4px}
  .climate-layout>.multi-unit-trend{height:100% !important;min-height:0}
  .dial-column{margin-top:-18px}
  .dial-column :deep(.climate-dial){--dial-size:clamp(126px,18.5vh,182px);gap:10px}
  .dial-column :deep(.readings>div){align-items:flex-start}
  .dial-column .dew-reading{margin-top:0;transform:translateX(-20px)}
  .smoke-card>.monitor-empty{flex:1;min-height:0;gap:6px;padding:6px 12px}
  .smoke-card .empty-symbol{font-size:26px}
  .sensor-values{margin:2px 20px 14px}
  .pd-card :deep(.multi-unit-trend){margin-top:0}
}
</style>
