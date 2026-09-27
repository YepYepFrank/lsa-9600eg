<!-- 实时数据：按设备看每个量的当前值、质量、设备时间与到达时间；该有没来的量也列出来；原始消息给同事排错 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../session'
import { store } from '../store'
import { ago, hms, period, QTEXT, val } from '../utils/fmt'
import type { Live, PointDef, RawMessage } from '../types'

const props = defineProps<{ device?: string }>()
const router = useRouter()

const devices = computed(() => {
  const s = store.status
  if (!s) return []
  return [...s.devices.map(d => ({ name: d.name, label: d.label, bad: d.dead || Object.keys(d.q).length > 0, keys: d.keys })), { name: s.eg, label: 'EG 自身指标', bad: false, keys: 0 }]
})
const sel = computed(() => props.device || devices.value[0]?.name || '')
const live = ref<Live | null>(null)
const err = ref('')
const filter = ref('')
const onlyBad = ref(false)
const frozen = ref(false)

async function load() {
  if (!sel.value || frozen.value) return
  try {
    live.value = await api<Live>(`live/${encodeURIComponent(sel.value)}`)
    err.value = ''
  } catch (e) {
    live.value = null
    err.value = (e as Error).message
  }
}
watch(sel, () => {
  live.value = null
  void load()
}, { immediate: true })
const timer = window.setInterval(() => !document.hidden && load(), 2000)
onBeforeUnmount(() => clearInterval(timer))

/** 只有同事的程序知道的南向统计：eg-agent 不替它编，没报就是「未上报」，不算异常 */
const SOURCE_ONLY = new Set(['dev.crc_24h', 'dev.retry_24h'])

interface Row extends PointDef {
  v: unknown
  ts: number | null
  at: number | null
  own: boolean
  q: string | null
  extra: boolean
  missing: boolean
  /** 没来但正常：事件型没发生过、只有同事程序能报的量 */
  benign: string | null
}

const rows = computed<Row[]>(() => {
  const cat = store.catalog
  const defs: PointDef[] = [...(cat?.devices[sel.value] ?? []), ...(sel.value === store.status?.eg ? [] : cat?.common ?? [])]
  const t = live.value?.telemetry ?? {}
  const q = live.value?.q ?? {}
  const known = new Set(defs.map(d => d.key))
  // EG 自身指标全是 eg-agent 采的；取不到的（开发机上的机内温度、X26A 没有的供电电压）不算异常
  const isEg = sel.value === store.status?.eg
  const out: Row[] = []
  for (const d of defs) {
    const l = t[d.key]
    // 可选量（分区测温）没来过就不列
    if (!l && d.optional) continue
    const benign = l ? null : isEg ? '本机取不到' : d.periodMs === null ? '无事件' : SOURCE_ONLY.has(d.key) ? '未上报' : null
    const own = isEg || (SOURCE_ONLY.has(d.key) ? false : !!l?.own || (cat?.derived.includes(d.key) ?? false))
    out.push({ ...d, v: l?.v, ts: l?.ts ?? null, at: l?.at ?? null, own, q: q[d.key] ?? null, extra: false, missing: !l && !benign, benign })
  }
  for (const [k, l] of Object.entries(t)) {
    if (known.has(k)) continue
    out.push({ key: k, label: '（目录外）', unit: '', periodMs: null, optional: false, json: false, v: l.v, ts: l.ts, at: l.at, own: l.own, q: q[k] ?? null, extra: true, missing: false, benign: null })
  }
  const f = filter.value.trim().toLowerCase()
  return out.filter(r => (!f || r.key.toLowerCase().includes(f) || r.label.toLowerCase().includes(f)) && (!onlyBad.value || r.q || r.missing || r.extra))
})
/** 最近一条的到达时刻（EG 自身指标是 agent 自己发的，不计「已收条数」，按遥测里最新的算） */
const lastAt = computed(() => Math.max(live.value?.lastAt ?? 0, ...Object.values(live.value?.telemetry ?? {}).map(t => t.at)))
const badCount = computed(() => rows.value.filter(r => r.q || r.missing).length)

function quality(r: Row): [string, string] {
  if (r.q) return QTEXT[r.q] ? [QTEXT[r.q]![0], QTEXT[r.q]![1]] : [r.q, 'minor']
  if (r.benign) return [r.benign, '']
  if (r.missing) return ['没来过', 'crit']
  if (r.extra) return ['目录外', 'info']
  return ['有效', 'good']
}
function lag(r: Row): string {
  if (!r.ts || !r.at) return ''
  const s = (r.at - r.ts) / 1000
  return Math.abs(s) >= 3 ? `（差 ${s.toFixed(1)} s）` : ''
}

/* 原始消息 */
const rawOpen = ref(false)
const raw = ref<RawMessage[]>([])
async function openRaw() {
  rawOpen.value = true
  try {
    raw.value = ((await api<{ messages: RawMessage[] }>(`raw/${encodeURIComponent(sel.value)}`)).messages ?? []).slice().reverse()
  } catch {
    raw.value = []
  }
}
const pretty = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
</script>

<template>
  <div class="live">
    <aside class="devs panel">
      <div class="panel-h">设备</div>
      <button v-for="d in devices" :key="d.name" class="dev" :class="{ on: d.name === sel }" @click="router.replace('/manage/live/' + d.name)">
        <span class="dot" :class="d.bad ? 'minor' : 'good'" />
        <span class="n"><span class="mono">{{ d.name }}</span><small>{{ d.label }}</small></span>
      </button>
    </aside>
    <section class="panel tbl">
      <div class="panel-h">
        <span class="mono">{{ sel }}</span>
        <span class="t2">{{ live ? `${live.msgs ? `已收 ${live.msgs} 条 · ` : ''}最近 ${lastAt ? ago(Date.now() - lastAt) : '—'}` : err || '…' }}</span>
        <span class="sp" />
        <el-input v-model="filter" size="small" placeholder="筛选点名 / 名称" clearable style="width: 180px" />
        <el-checkbox v-model="onlyBad" size="small">只看异常（{{ badCount }}）</el-checkbox>
        <el-button size="small" @click="frozen = !frozen">{{ frozen ? '▶ 继续' : 'Ⅱ 冻结' }}</el-button>
        <el-button size="small" @click="openRaw">原始消息</el-button>
      </div>
      <el-table :data="rows" size="small" height="100%" empty-text="没有数据">
        <el-table-column label="点名" min-width="130"><template #default="{ row }"><span class="mono">{{ row.key }}</span></template></el-table-column>
        <el-table-column prop="label" label="名称" min-width="130" />
        <el-table-column label="当前值" width="120" align="right">
          <template #default="{ row }"><span class="num" :title="typeof row.v === 'string' ? row.v : ''">{{ val(row.v) }}</span></template>
        </el-table-column>
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column label="质量" width="90"><template #default="{ row }"><span class="tag" :class="quality(row)[1]">{{ quality(row)[0] }}</span></template></el-table-column>
        <el-table-column label="设备时间" width="150"><template #default="{ row }"><span class="num">{{ hms(row.ts) }}</span><span class="minor">{{ lag(row) }}</span></template></el-table-column>
        <el-table-column label="到达" width="100"><template #default="{ row }"><span class="num">{{ hms(row.at) }}</span></template></el-table-column>
        <el-table-column label="周期" width="70"><template #default="{ row }">{{ period(row.periodMs) }}</template></el-table-column>
        <el-table-column label="来源" width="90"><template #default="{ row }"><span :class="row.own ? 'info' : 't2'">{{ row.own ? 'agent 算' : '传感器' }}</span></template></el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="rawOpen" :title="`${sel} · 本机总线最近的原始消息`" size="560px">
      <p class="note">同事的程序发到 <code>lsa/{{ sel }}/telemetry</code> 的原样载荷（最新在上，留 20 条），标「agent」的是 eg-agent 自己算了发回去的。</p>
      <div v-for="(m, i) in raw" :key="i" class="raw">
        <div class="raw-h"><span class="num">{{ hms(m.at) }}</span><span class="mono t2">{{ m.topic }}</span><span v-if="m.own" class="tag info">agent</span></div>
        <pre>{{ pretty(m.payload) }}</pre>
      </div>
      <div v-if="!raw.length" class="empty">总线上还没有这台设备的消息</div>
    </el-drawer>
  </div>
</template>

<style scoped>
.live { display: flex; gap: 12px; height: 100%; }
.devs { width: 220px; flex: none; margin-top: 0; overflow: auto; }
.dev { display: flex; align-items: center; gap: 4px; width: 100%; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
.dev:hover { background: var(--surface2); }
.dev.on { background: var(--brand-bg); box-shadow: inset 3px 0 0 var(--brand); }
.dev .n { display: flex; flex-direction: column; min-width: 0; }
.dev small { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tbl { flex: 1; min-width: 0; margin-top: 0; display: flex; flex-direction: column; }
.tbl :deep(.el-table) { flex: 1; }
.raw { border: 1px solid var(--line); border-radius: var(--r); margin-bottom: 8px; }
.raw-h { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--surface2); }
.raw pre { margin: 0; padding: 8px 10px; font-size: 12px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
</style>
