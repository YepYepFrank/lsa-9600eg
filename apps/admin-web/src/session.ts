/* 本地页的会话（开发计划 §5）。两条路进来：
 *   直连 http://<EG>/        —— 本地维护账号登录
 *   经子站 /eg/<柜号>/?sso=…  —— 子站签的票据换会话，不用再登录
 * 会话令牌按页面路径分开存：经子站反代时同一个站点下有多台 EG（/eg/AH03/、/eg/AH05/），不能串。
 * 接口一律相对路径（api/...），挂在哪个路径下都对。 */
import { reactive } from 'vue'

// 仅开发服务器允许显式预览（领导 80e01ad）；生产构建始终使用真实登录和接口。
export const demoMode = import.meta.env.DEV && new URLSearchParams(location.search).get('demo') === '1'

export interface Me {
  user: string
  name: string
  role: 'maint' | 'view'
  via: 'local' | 'sp'
  /** 本地登录才有：本地维护账号概况（initialPasswordFile = 初始口令文件还在） */
  account?: { initialPasswordFile: boolean } | null
}

const KEY = `lsa-eg-session:${location.pathname}`

export const session = reactive<{ token: string | null; me: Me | null; error: string }>({ token: read(), me: null, error: '' })

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}
function write(t: string | null): void {
  session.token = t
  try {
    if (t) localStorage.setItem(KEY, t)
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式等存不了：只在内存里 */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (demoMode) {
    const { demoApi } = await import('./demo')
    return demoApi(path, init.method ?? 'GET') as T
  }
  const r = await fetch(`api/${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (r.status === 401) {
    write(null)
    session.me = null
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = (await r.json()) as { message?: string | string[] }
      if (j.message) msg = Array.isArray(j.message) ? j.message.join('；') : j.message
    } catch {
      /* 不是 JSON */
    }
    throw new ApiError(r.status, msg)
  }
  return (await r.json()) as T
}

/** 启动：带 ?sso= 的先换会话（换完从地址栏去掉票据），再取当前用户 */
export async function boot(): Promise<void> {
  if (demoMode) {
    session.me = { user: 'demo', name: '演示访客', role: 'view', via: 'local' }
    return
  }
  const url = new URL(location.href)
  const ticket = url.searchParams.get('sso')
  if (ticket) {
    url.searchParams.delete('sso')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    try {
      const r = await api<Me & { token: string }>('auth/sso', { method: 'POST', body: { ticket } })
      write(r.token)
    } catch (e) {
      session.error = `子站单点登录失败：${(e as Error).message}`
    }
  }
  if (session.token) {
    try {
      session.me = await api<Me>('auth/me')
    } catch {
      session.me = null
    }
  }
}

export async function login(user: string, password: string): Promise<void> {
  const r = await api<Me & { token: string }>('auth/login', { method: 'POST', body: { user, password } })
  write(r.token)
  session.me = { user: r.user, name: r.name, role: r.role, via: r.via }
  session.error = ''
}

export async function logout(): Promise<void> {
  if (demoMode) {
    location.assign(location.pathname)
    return
  }
  try {
    await api('auth/logout', { method: 'POST' })
  } catch {
    /* 会话已经失效也算退出 */
  }
  write(null)
  session.me = null
}
