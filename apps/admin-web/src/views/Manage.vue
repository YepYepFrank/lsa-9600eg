<!-- 设备与通信：原有的本地管理页（服务状态、实时数据、下挂设备、视频与测温、证据、诊断、日志、系统）做子页 -->
<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MANAGE } from '../router'
import { store } from '../store'

const route = useRoute()
const router = useRouter()
const current = computed(() => route.path.split('/')[2] ?? 'status')
const link = (p: string) => '/manage/' + p.replace(/\/:.*$/, '')
const diagIssues = computed(() => {
  const d = store.diag
  if (!d) return 0
  return [!['ok', 'none'].includes(d.uplink.state), !d.bus.connected, (d.sp.lossPct ?? 0) >= 50, Math.abs(d.clock.offsetMs ?? 0) > 1000, d.devices.dead.length > 0, d.devices.unknown.length > 0].filter(Boolean).length
})
const devIssues = computed(() => store.status?.devices.filter(d => d.dead || Object.keys(d.q).length).length ?? 0)
</script>

<template>
  <div class="page">
    <div class="management-title"><h1>设备与通信</h1><span>{{ store.status?.eg ?? '本机' }} · 本地服务与采集链路</span></div>
    <nav class="manage-tabs" aria-label="设备与通信">
      <button v-for="p in MANAGE" :key="p.path" :class="{ selected: current === p.path.replace(/\/:.*$/, '') }" @click="router.push(link(p.path))">
        {{ p.name }}
        <span v-if="p.name === '诊断' && diagIssues" class="bdg">{{ diagIssues }}</span>
        <span v-if="p.name === '下挂设备' && devIssues" class="bdg">{{ devIssues }}</span>
      </button>
    </nav>
    <router-view />
  </div>
</template>

<style scoped>
.manage-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.manage-tabs button { position: relative; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text2); padding: 8px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.manage-tabs button:hover { color: var(--brand-ink); }
.manage-tabs button.selected { color: var(--brand-ink); border-bottom-color: var(--brand); }
.manage-tabs button:focus-visible { outline: 2px solid var(--brand-ink); outline-offset: 2px; }
.bdg { margin-left: 4px; font-size: 10px; background: var(--crit); color: #fff; border-radius: 8px; padding: 0 5px; }
</style>
