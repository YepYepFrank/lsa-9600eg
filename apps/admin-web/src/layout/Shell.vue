<!-- 外壳：左侧导航、顶栏（本机是谁、上送状态、时钟、主题、当前用户）。数据轮询在这里起停 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PAGES } from '../router'
import { logout, session } from '../session'
import { startPolling, stopPolling, store } from '../store'
import { theme, toggleTheme } from '../theme'

const route = useRoute()
const router = useRouter()
const now = ref(Date.now())
let clock = 0

onMounted(() => {
  void startPolling()
  clock = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  stopPolling()
  clearInterval(clock)
})

const current = computed(() => '/' + (route.path.split('/')[1] ?? ''))
const UP: Record<string, [string, string]> = {
  ok: ['good', '上送正常'],
  backfill: ['info', '补传中'],
  paused: ['minor', '上送暂停'],
  offline: ['crit', '连不上子站'],
  stuck: ['crit', 'Edge 可能卡住'],
  unknown: ['minor', '上送状态未知'],
}
const up = computed(() => UP[store.diag?.uplink.state ?? 'unknown']!)
/** 导航上的小红点：诊断页有问题项时 */
const diagIssues = computed(() => {
  const d = store.diag
  if (!d) return 0
  return [d.uplink.state !== 'ok', !d.bus.connected, (d.sp.lossPct ?? 0) >= 50, Math.abs(d.clock.offsetMs ?? 0) > 1000, d.devices.dead.length > 0, d.devices.unknown.length > 0].filter(Boolean).length
})
const devIssues = computed(() => store.status?.devices.filter(d => d.dead || Object.keys(d.q).length).length ?? 0)
const clockText = computed(() => new Date(now.value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))

async function bye() {
  await logout()
  router.replace('/overview')
}
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <div class="logo">EG</div>
        <div class="brand-t">LSA-9600EG<small>边缘网关 · 本地管理</small></div>
      </div>
      <nav class="nav">
        <button v-for="p in PAGES" :key="p.path" class="nav-i" :class="{ on: current === p.path.replace(/\/:.*$/, '') }" @click="router.push(p.path.replace(/\/:.*$/, ''))">
          <span class="ic">{{ p.ic }}</span><span>{{ p.name }}</span>
          <span v-if="p.name === '诊断' && diagIssues" class="bdg">{{ diagIssues }}</span>
          <span v-if="p.name === '下挂设备' && devIssues" class="bdg">{{ devIssues }}</span>
        </button>
      </nav>
      <div class="side-foot">
        <template v-if="store.status">eg-agent {{ store.status.version }}<br />{{ store.diag?.edge.edgeVersion ? 'TB Edge ' + store.diag.edge.edgeVersion.replace(/^V_/, '').replace(/_/g, '.') : '' }}</template>
      </div>
    </aside>
    <div class="main">
      <header class="top">
        <div class="ttl">
          {{ store.status?.eg ?? '…' }}<span v-if="store.status" class="muted">{{ store.status.cabinet.code }} {{ store.status.cabinet.name }} · {{ store.status.station.label }}</span>
        </div>
        <span class="chip" :title="store.diag?.uplink.text"><span class="dot" :class="up[0]" />{{ up[1] }}</span>
        <span v-if="store.error" class="chip crit" :title="store.error">取数失败</span>
        <div class="top-r">
          <span class="clock">{{ clockText }}</span>
          <button class="icon-btn" :title="theme === 'dark' ? '换浅色' : '换深色'" @click="toggleTheme">◐</button>
          <span class="chip">{{ session.me?.name }} · {{ session.me?.via === 'sp' ? '经子站' : '本地' }} · {{ session.me?.role === 'maint' ? '维护' : '只看' }}</span>
          <el-button size="small" @click="bye">退出</el-button>
        </div>
      </header>
      <main class="content">
        <router-view />
      </main>
    </div>
  </div>
</template>
