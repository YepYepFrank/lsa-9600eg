/* 显示格式：时间一律东八区（EG 装在配电室，维护笔记本的时区不一定对） */
const TZ = 'Asia/Shanghai'

export function dt(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function hms(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false })
}

/** 多久以前：3 秒前 / 5 分钟前 / 2 小时前 */
export function ago(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

export function dur(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d ? `${d} 天 ${h} 时` : h ? `${h} 时 ${m} 分` : `${m} 分`
}

export function period(ms: number | null | undefined): string {
  if (ms == null) return '事件'
  return ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`
}

/** 测点值：数值按量级留小数；JSON 字符串给摘要 */
export function val(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, '')
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('[')) {
      try {
        const a = JSON.parse(t) as unknown[]
        return `[${a.length} 个值]`
      } catch {
        /* 不是 JSON */
      }
    }
    if (t.startsWith('{')) return t.length > 40 ? t.slice(0, 40) + '…' : t
    return t
  }
  return JSON.stringify(v)
}

export const QTEXT: Record<string, [string, string]> = {
  invalid: ['无效', 'crit'],
  stale: ['陈旧', 'minor'],
  backfill: ['补传', 'info'],
  // 阶段 A：转换程序给的传感器状态（EG 透传）
  warmup: ['预热中', 'info'],
  calibrating: ['校准中', 'info'],
}

/** 下挂设备通信状态（§13 dev.comm） */
export const COMMTEXT: Record<string, [string, string]> = {
  ONLINE: ['在线', 'good'],
  DEGRADED: ['部分量异常', 'minor'],
  OFFLINE: ['离线', 'crit'],
  UNKNOWN: ['刚启动、未判', ''],
}
