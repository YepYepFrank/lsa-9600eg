<!-- G0 骨架：本机概况（柜、本机总线、各设备数据新鲜度）。完整页面（实时数据、设备与映射、视频、诊断、日志、系统）在 G3 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

interface Dev {
  name: string
  kind: string
  label: string
  keys: number
  msgs: number
  lastTs: number | null
  ageSec: number | null
  dead: boolean
  q: Record<string, string>
  south: { req: number; timeout: number; rate: number | null } | null
}
interface Status {
  eg: string
  cabinet: { code: string; name: string }
  station: { label: string }
  uptimeSec: number
  rssMb: number
  state: 'online' | 'degraded'
  bus: { url: string; connected: boolean; msgs: number }
  devices: Dev[]
  unknownDevices: string[]
}

const st = ref<Status | null>(null)
const err = ref('')
let timer = 0

async function load() {
  try {
    const r = await fetch('api/status')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    st.value = await r.json()
    err.value = ''
  } catch (e) {
    err.value = `取不到本机状态：${(e as Error).message}`
  }
}

/** 超过 3 个快周期（6 s）算不新鲜；分钟档设备（摄像机）给 3 分钟 */
function fresh(d: Dev): 'good' | 'minor' | 'off' {
  if (d.ageSec === null) return 'off'
  const limit = d.kind === 'camera' ? 180 : d.kind === 'pm' ? 30 : 6
  return d.ageSec <= limit ? 'good' : 'minor'
}
/** 质量码摘要：几个无效、几个陈旧 */
function qText(q: Record<string, string>): string {
  const v = Object.values(q)
  const inv = v.filter(x => x === 'invalid').length
  const sta = v.filter(x => x === 'stale').length
  return [inv && `${inv} 个无效`, sta && `${sta} 个陈旧`].filter(Boolean).join('，') || '全部有效'
}
const qDetail = (q: Record<string, string>) => Object.entries(q).map(([k, v]) => `${k} ${v === 'invalid' ? '无效' : '陈旧'}`).join('；')
const tsText = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—')

onMounted(() => {
  load()
  timer = window.setInterval(load, 2000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="page">
    <header class="top">
      <div class="brand">LSA-9600EG 边缘网关</div>
      <div v-if="st" class="who">{{ st.eg }} · {{ st.cabinet.code }} {{ st.cabinet.name }} · {{ st.station.label }}</div>
    </header>
    <el-alert v-if="err" :title="err" type="error" :closable="false" show-icon />
    <template v-if="st">
      <section class="cards">
        <div class="card">
          <div class="k">本机总线</div>
          <div class="v" :class="st.bus.connected ? 'good' : 'crit'">{{ st.bus.connected ? '已连接' : '未连接' }}</div>
          <div class="s">{{ st.bus.url }} · 已收 {{ st.bus.msgs.toLocaleString() }} 条</div>
        </div>
        <div class="card">
          <div class="k">EG 状态</div>
          <div class="v" :class="st.state === 'online' ? 'good' : 'minor'">{{ st.state === 'online' ? '正常' : '降级' }}</div>
          <div class="s">{{ st.state === 'online' ? '下挂设备都有数据' : '有下挂设备整台没有数据' }}</div>
        </div>
        <div class="card">
          <div class="k">运行时长</div>
          <div class="v">{{ Math.floor(st.uptimeSec / 3600) }} 时 {{ Math.floor((st.uptimeSec % 3600) / 60) }} 分</div>
          <div class="s">eg-agent 内存 {{ st.rssMb }} MB</div>
        </div>
      </section>
      <el-table :data="st.devices" size="small" class="tbl">
        <el-table-column prop="name" label="设备" width="170" />
        <el-table-column prop="label" label="名称" />
        <el-table-column prop="keys" label="测点" width="80" align="right" />
        <el-table-column label="最近数据（设备时间）" width="200">
          <template #default="{ row }">{{ tsText(row.lastTs) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <span class="dot" :class="row.dead ? 'crit' : fresh(row)" />{{ row.dead ? '整台失效' : fresh(row) === 'good' ? '正常' : fresh(row) === 'off' ? '无数据' : `${row.ageSec} 秒未更新` }}
          </template>
        </el-table-column>
        <el-table-column label="质量码" width="150">
          <template #default="{ row }">
            <el-tooltip v-if="Object.keys(row.q).length" :content="qDetail(row.q)" placement="top">
              <span class="minor">{{ qText(row.q) }}</span>
            </el-tooltip>
            <span v-else class="muted">全部有效</span>
          </template>
        </el-table-column>
        <el-table-column label="到达率（24 h）" width="130" align="right">
          <template #default="{ row }">{{ row.south?.rate == null ? '—' : `${row.south.rate.toFixed(2)} %` }}</template>
        </el-table-column>
      </el-table>
      <el-alert v-if="st.unknownDevices.length" type="warning" :closable="false" show-icon
        :title="`总线上有不在设备清单里的设备名：${st.unknownDevices.join('、')}（数据不会上送）`" />
    </template>
  </div>
</template>

<style>
html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); }
.page { max-width: 1200px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.top { display: flex; align-items: baseline; gap: 16px; }
.brand { font-size: 18px; font-weight: 600; color: var(--brand-ink); }
.who { color: var(--text2); }
.cards { display: flex; gap: 12px; flex-wrap: wrap; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 16px; min-width: 220px; }
.card .k { color: var(--muted); font-size: 12px; }
.card .v { font-size: 20px; margin: 4px 0; }
.card .s { color: var(--text2); font-size: 12px; }
.good { color: var(--good); }
.crit { color: var(--crit); }
.minor { color: var(--minor); }
.muted { color: var(--muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--off); }
.dot.good { background: var(--good); }
.dot.minor { background: var(--minor); }
.dot.crit { background: var(--crit); }
</style>
