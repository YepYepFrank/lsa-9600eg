<!-- 外壳（界面基线：领导 80e01ad）：左侧栏（本柜总览 / 电气量 / 事件与录像 / 设备与通信，可折叠）、
     顶栏（柜号柜名、访问方式、时钟、主题、用户）、页脚（数据来源、下挂设备数、上送状态、版权）。数据轮询在这里起停 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import brandLogo from '../components/brand-logo.png'
import { NAV, type NavKey } from '../router'
import { demoMode, logout, session } from '../session'
import { startPolling, stopPolling, store } from '../store'
import { theme, toggleTheme } from '../theme'

const route = useRoute()
const router = useRouter()
const collapsed = ref(false)
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

const view = computed(() => (route.meta['nav'] as NavKey | undefined) ?? 'overview')
const navigate = (k: NavKey) => router.push('/' + k)
const clockText = computed(() => new Date(now.value).toLocaleString('zh-CN', { hour12: false }))
const title = computed(() => (store.status ? `${store.status.cabinet.code} ${store.status.cabinet.name}` : demoMode ? 'AH03 1#出线柜' : '本柜监测'))
const mode = computed(() => (demoMode ? '本地演示' : session.me?.via === 'sp' ? '经子站访问' : '本地访问'))
/** 「设备与通信」上的小红点：诊断有问题项、下挂设备有质量码 */
const issues = computed(() => {
  const d = store.diag
  const diag = d ? [!['ok', 'none'].includes(d.uplink.state), !d.bus.connected, d.devices.dead.length > 0].filter(Boolean).length : 0
  return diag + (store.status?.devices.filter(x => x.dead).length ?? 0)
})
const tbVer = computed(() => store.comps.find(c => c.key === 'tb')?.image?.split(':')[1] ?? '')

async function bye() {
  await logout()
  router.replace('/overview')
}
</script>

<template>
  <div class="eg-shell" :class="{ collapsed }">
    <aside class="eg-side">
      <div class="eg-brand"><span class="eg-logo"><img :src="brandLogo" alt="" /></span><div><strong>LSA-9600EG</strong><small>态势感知边缘网关</small></div></div>
      <nav aria-label="主导航">
        <button v-for="item in NAV" :key="item.key" :class="{ selected: view === item.key }" :aria-current="view === item.key ? 'page' : undefined" :title="item.label" @click="navigate(item.key)">
          <span class="nav-icon">{{ item.icon }}</span><span class="nav-label">{{ item.label }}</span>
          <span v-if="item.key === 'manage' && issues" class="nav-bdg">{{ issues }}</span>
        </button>
      </nav>
      <div class="eg-side-foot" :title="tbVer ? '本地 TB ' + tbVer : ''">{{ demoMode ? 'v0.1 · 演示预览' : `eg-agent ${store.status?.version ?? ''}` }}</div>
    </aside>
    <div class="eg-main">
      <header class="eg-top">
        <button class="eg-collapse" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" @click="collapsed = !collapsed">☰</button>
        <h1 class="eg-cabinet-title">{{ title }}</h1>
        <span v-if="store.status && !demoMode" class="eg-station">{{ store.status.eg }} · {{ store.status.station.label }}</span>
        <span class="sp" />
        <span v-if="store.error" class="eg-mode crit" :title="store.error">取数失败</span>
        <span class="eg-mode">{{ mode }}</span>
        <time>{{ clockText }}</time>
        <button class="eg-collapse" :title="theme === 'dark' ? '换浅色' : '换深色'" @click="toggleTheme">◐</button>
        <span class="eg-user">{{ session.me?.name }}{{ session.me?.role === 'maint' ? '' : '（只看）' }}</span>
        <el-button size="small" @click="bye">退出</el-button>
      </header>
      <div class="eg-content"><router-view /></div>
      <footer class="eg-footer">
        <span>{{ demoMode ? '● 演示数据' : store.status?.bus.connected ? '● 本地服务' : '○ 本机总线未连' }}</span>
        <span>{{ store.status?.devices.length ?? '—' }} 台下挂设备{{ demoMode ? '（模拟）' : '' }}</span>
        <span>子站 {{ store.diag?.uplink.text ?? '状态未知' }}</span>
        <span class="sp" />
        <span>© 南京国网电瑞电力科技有限责任公司 版权所有</span>
      </footer>
    </div>
  </div>
</template>

<style>
*{box-sizing:border-box}html,body,#app{height:100%}body{font-size:13px}button,input,select{font-family:inherit}.eg-shell{display:flex;height:100%;overflow:hidden}.eg-side{width:184px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column}.eg-brand{height:46px;flex:none;display:flex;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--line)}.eg-logo{position:relative;display:block;width:28px;height:28px;flex:none;overflow:hidden;border-radius:5px;background:#03445b}.eg-logo img{position:absolute;display:block;width:30px;height:30px;max-width:none;left:-2.7px;top:-3px}.eg-brand strong{font-size:14px;color:var(--text)}.eg-brand small{display:block;color:var(--text2);font-size:10px;margin-top:3px}.eg-side nav{padding:12px 6px;display:flex;flex-direction:column;gap:5px}.eg-side nav button{position:relative;display:flex;align-items:center;gap:12px;border:0;border-radius:4px;background:none;color:var(--text2);padding:11px 12px;font:inherit;text-align:left;cursor:pointer;white-space:nowrap}.eg-side nav button:hover{background:var(--surface2)}.eg-side nav button.selected{background:var(--brand);color:white}.nav-icon{width:18px;text-align:center;font-size:16px}.eg-side-foot{height:28px;flex:none;display:flex;align-items:center;margin-top:auto;border-top:1px solid var(--line);padding:0 10px;color:var(--muted);font-size:10px}.eg-main{flex:1;min-width:0;display:flex;flex-direction:column}.eg-top{height:46px;flex:none;display:flex;align-items:center;gap:16px;padding:0 14px;background:var(--surface);border-bottom:1px solid var(--line)}.eg-collapse{border:0;background:none;color:var(--text2);cursor:pointer;padding:4px}.eg-cabinet-title{margin:0;color:var(--text);font-size:17px;font-weight:600;white-space:nowrap}.eg-top time,.eg-user{font-size:11px;color:var(--text2)}.eg-mode{font-size:10px;border:1px solid var(--line2);border-radius:12px;padding:2px 8px;color:var(--brand-ink)}.eg-content{padding:14px;overflow:auto;flex:1;min-height:0}.eg-footer{height:28px;flex:none;display:flex;align-items:center;gap:16px;border-top:1px solid var(--line);padding:0 12px;font-size:10px;color:var(--muted);background:var(--surface)}.management-title{display:flex;align-items:baseline;gap:16px;margin-bottom:8px}.management-title h1{font-size:20px;margin:0}.management-title>span{font-size:12px;color:var(--muted)}.eg-shell.collapsed .eg-side{width:54px}.eg-shell.collapsed .eg-brand>div,.eg-shell.collapsed .nav-label,.eg-shell.collapsed .eg-side-foot{display:none}.eg-shell.collapsed .eg-side nav button{padding:11px}.eg-shell button:focus-visible{outline:2px solid var(--brand-ink);outline-offset:2px}.chart{min-width:0;width:100%}
.eg-top .sp,.eg-footer .sp{flex:1}.page{display:flex;flex-direction:column;gap:12px}
/* EG 补：站名、取数失败、导航角标 */
.eg-station{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eg-mode.crit{color:var(--crit);border-color:rgba(var(--crit-rgb),.5)}.nav-bdg{margin-left:auto;font-size:10px;background:var(--crit);color:#fff;border-radius:8px;padding:0 5px}.eg-shell.collapsed .nav-bdg{position:absolute;right:4px;top:4px}
@media(max-width:1000px){.eg-side{width:54px}.eg-brand>div,.nav-label,.eg-side-foot{display:none}.eg-side nav button{padding:11px}.nav-bdg{position:absolute;right:4px;top:4px}.eg-user,.eg-station{display:none}.eg-content{padding:10px}}
@media(max-width:600px){.eg-top time,.eg-footer>span:last-child{display:none}.eg-top{gap:8px}.eg-footer{gap:8px;font-size:9px}}
</style>
