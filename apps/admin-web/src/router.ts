/* 哈希路由：挂在子站反代的 /eg/<柜号>/ 下也不用改 */
import { createRouter, createWebHashHistory } from 'vue-router'

export const PAGES = [
  { path: '/overview', name: '概览', ic: '▦', component: () => import('./views/Overview.vue') },
  { path: '/live/:device?', name: '实时数据', ic: '◉', component: () => import('./views/Live.vue'), props: true },
  { path: '/devices', name: '下挂设备', ic: '⌬', component: () => import('./views/Devices.vue') },
  { path: '/video', name: '视频与测温', ic: '▶', component: () => import('./views/Video.vue') },
  { path: '/diag', name: '诊断', ic: '✚', component: () => import('./views/Diag.vue') },
  { path: '/logs', name: '日志', ic: '☰', component: () => import('./views/Logs.vue') },
  { path: '/system', name: '系统', ic: '⚙', component: () => import('./views/System.vue') },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', redirect: '/overview' }, ...PAGES.map(p => ({ path: p.path, component: p.component, props: p.props, meta: { title: p.name } }))],
})
