/* 哈希路由：挂在子站反代的 /eg/<柜号>/ 下也不用改。
 * 界面基线（eg-ui-v2，领导 80e01ad）：侧栏 本柜总览 / 电气量 / 事件与录像 / 设备与通信；
 * 原有的管理页（服务状态、实时数据、下挂设备、视频与测温、证据、诊断、日志、系统）都在「设备与通信」下面（/manage/…）。
 * 旧地址（#/live、#/devices …）重定向到新位置，子站网关页与收藏的链接照样能用。 */
import { createRouter, createWebHashHistory } from 'vue-router'

export type NavKey = 'overview' | 'electric' | 'events' | 'manage'
export const NAV: { key: NavKey; icon: string; label: string }[] = [
  { key: 'overview', icon: '▥', label: '本柜总览' },
  { key: 'electric', icon: 'ϟ', label: '电气量' },
  { key: 'events', icon: '≡', label: '事件与录像' },
  { key: 'manage', icon: '⚙', label: '设备与通信' },
]

/** 「设备与通信」下的子页 */
export const MANAGE = [
  { path: 'status', name: '服务状态', component: () => import('./views/Overview.vue') },
  { path: 'live/:device?', name: '实时数据', component: () => import('./views/Live.vue'), props: true },
  { path: 'devices', name: '下挂设备', component: () => import('./views/Devices.vue') },
  { path: 'video', name: '视频与测温', component: () => import('./views/Video.vue') },
  { path: 'evidence', name: '证据', component: () => import('./views/Evidence.vue') },
  { path: 'diag', name: '诊断', component: () => import('./views/Diag.vue') },
  { path: 'logs', name: '日志', component: () => import('./views/Logs.vue') },
  { path: 'system', name: '系统', component: () => import('./views/System.vue') },
]

const Monitor = () => import('./views/Monitor.vue')
const LEGACY = ['devices', 'video', 'evidence', 'diag', 'logs', 'system']

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', component: Monitor, props: { tab: 'overview' }, meta: { nav: 'overview' } },
    { path: '/electric', component: Monitor, props: { tab: 'electric' }, meta: { nav: 'electric' } },
    { path: '/events', component: Monitor, props: { tab: 'events' }, meta: { nav: 'events' } },
    {
      path: '/manage',
      component: () => import('./views/Manage.vue'),
      meta: { nav: 'manage' },
      children: [{ path: '', redirect: '/manage/status' }, ...MANAGE.map(p => ({ path: p.path, component: p.component, props: p.props, meta: { nav: 'manage', title: p.name } }))],
    },
    { path: '/live/:device?', redirect: to => `/manage/live/${(to.params['device'] as string | undefined) ?? ''}` },
    ...LEGACY.map(p => ({ path: `/${p}`, redirect: `/manage/${p}` })),
    { path: '/:pathMatch(.*)*', redirect: '/overview' },
  ],
})
