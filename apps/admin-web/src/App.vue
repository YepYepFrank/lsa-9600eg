<!-- G0–G2 骨架：登录 / 子站单点登录、本机概况（柜、本机总线、各设备数据、组件与上送）。完整页面（实时数据、设备与映射、视频、诊断、日志、系统）在 G3 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import Login from './Login.vue'
import { api, boot, logout, session } from './session'

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

interface Comp {
  key: string
  label: string
  state: string
  memMb: number | null
  cpuPct: number | null
  restartable: boolean
}
interface Diag {
  uplink: { state: string; text: string }
  edge: { tsKv?: number; events?: number; edgeVersion?: string | null; error?: string }
  sp: { host: string; latMs: number | null; lossPct: number | null }
  clock: { server: string; offsetMs: number | null }
}

const st = ref<Status | null>(null)
const comps = ref<Comp[]>([])
const diag = ref<Diag | null>(null)
const err = ref('')
const ready = ref(false)
let timer = 0
let tick = 0

async function load() {
  if (!session.me) return
  try {
    st.value = await api<Status>('status')
    // 组件与诊断要调 Docker / Edge 库，没那么快，5 s 一次
    if (tick++ % 3 === 0) [comps.value, diag.value] = await Promise.all([api<Comp[]>('components'), api<Diag>('diag')])
    err.value = ''
  } catch (e) {
    err.value = `取不到本机状态：${(e as Error).message}`
  }
}

async function restart(c: Comp) {
  try {
    await ElMessageBox.confirm(`重启 ${c.label}？${c.key === 'edge' ? '约 40 s；期间数据由 IoT Gateway 排着，不丢。' : '几秒；期间数据由本机总线排着，不丢。'}`, '重启组件', { confirmButtonText: '重启', cancelButtonText: '取消' })
  } catch {
    return
  }
  try {
    await api(`components/${c.key}/restart`, { method: 'POST' })
    ElMessage.success(`已重启 ${c.label}`)
    tick = 0
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
const UPLINK: Record<string, string> = { ok: 'good', backfill: 'info', paused: 'minor', offline: 'crit', stuck: 'crit', unknown: 'minor' }

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

onMounted(async () => {
  await boot()
  ready.value = true
  load()
  timer = window.setInterval(load, 2000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <Login v-if="ready && !session.me" />
  <div v-else-if="session.me" class="page">
    <header class="top">
      <div class="brand">LSA-9600EG 边缘网关</div>
      <div v-if="st" class="who">{{ st.eg }} · {{ st.cabinet.code }} {{ st.cabinet.name }} · {{ st.station.label }}</div>
      <span class="sp" />
      <span class="me">{{ session.me.name }}（{{ session.me.via === 'sp' ? '经子站' : '本地' }} · {{ session.me.role === 'maint' ? '维护' : '只看' }}）</span>
      <el-button size="small" @click="logout">退出</el-button>
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
      <section v-if="diag" class="cards">
        <div class="card">
          <div class="k">上送子站（TB Edge）</div>
          <div class="v" :class="UPLINK[diag.uplink.state]">{{ diag.uplink.text }}</div>
          <div class="s">本地排队 遥测 {{ diag.edge.tsKv ?? '—' }} · 事件 {{ diag.edge.events ?? '—' }} · Edge {{ diag.edge.edgeVersion ?? '—' }}</div>
        </div>
        <div class="card">
          <div class="k">到子站 {{ diag.sp.host }}</div>
          <div class="v">{{ diag.sp.latMs ?? '—' }} <small>ms</small></div>
          <div class="s">失败率 {{ diag.sp.lossPct ?? '—' }} % · 对时偏差 {{ diag.clock.offsetMs ?? '—' }} ms（{{ diag.clock.server }}）</div>
        </div>
      </section>
      <el-table v-if="comps.length" :data="comps" size="small" class="tbl">
        <el-table-column prop="label" label="组件" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><span class="dot" :class="row.state === 'running' ? 'good' : row.state === '不存在' ? '' : 'crit'" />{{ row.state === 'running' ? '运行' : row.state }}</template>
        </el-table-column>
        <el-table-column label="内存" width="100" align="right">
          <template #default="{ row }">{{ row.memMb == null ? '—' : `${row.memMb} MB` }}</template>
        </el-table-column>
        <el-table-column label="CPU" width="90" align="right">
          <template #default="{ row }">{{ row.cpuPct == null ? '—' : `${row.cpuPct} %` }}</template>
        </el-table-column>
        <el-table-column width="100" align="center">
          <template #default="{ row }">
            <el-button v-if="row.restartable" size="small" :disabled="session.me?.role !== 'maint'" :title="session.me?.role !== 'maint' ? '只读账号不能重启' : ''" @click="restart(row)">重启</el-button>
          </template>
        </el-table-column>
      </el-table>
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
.top { display: flex; align-items: center; gap: 16px; }
.brand { font-size: 18px; font-weight: 600; color: var(--brand-ink); }
.who { color: var(--text2); }
.sp { flex: 1; }
.me { color: var(--text2); font-size: 13px; }
.card .v small { font-size: 12px; color: var(--muted); }
.info { color: var(--info); }
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
