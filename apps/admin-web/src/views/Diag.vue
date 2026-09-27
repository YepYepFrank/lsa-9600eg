<!-- 诊断：逐项检查这台 EG 的链路，每项给结论和该怎么办 -->
<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, session } from '../session'
import { refreshSlow, store } from '../store'
import { ago, dt, dur } from '../utils/fmt'

interface Item {
  name: string
  level: 'good' | 'minor' | 'crit' | 'info' | ''
  result: string
  hint: string
}

const items = computed<Item[]>(() => {
  const d = store.diag
  const st = store.status
  if (!d || !st) return []
  const out: Item[] = []
  out.push({
    name: '本机总线（Mosquitto）',
    level: d.bus.connected ? 'good' : 'crit',
    result: d.bus.connected ? `已连接 ${d.bus.url}，已收 ${st.bus.msgs.toLocaleString()} 条` : `连不上 ${d.bus.url}`,
    hint: d.bus.connected ? '' : '看「本机组件」里 Mosquitto 是否在跑；同事的程序与 IoT Gateway 都连它',
  })
  const loss = d.sp.lossPct ?? 0
  out.push({
    name: `到子站 ${d.sp.host}:${d.sp.port}`,
    level: loss >= 100 ? 'crit' : loss > 0 ? 'minor' : 'good',
    result: `时延 ${d.sp.latMs ?? '—'} ms，近 1 分钟失败率 ${d.sp.lossPct ?? '—'} %`,
    hint: loss >= 100 ? '上行口（LAN2）网线、交换机、子站主机是否正常；子站的 7070 端口要对 EG 开放' : loss > 0 ? '偶有失败：看交换机端口是否有错包' : '',
  })
  const u = d.uplink
  const backlog = (d.edge.tsKv ?? 0) + (d.edge.events ?? 0)
  out.push({
    name: '数据上送（TB Edge → 子站）',
    level: u.state === 'ok' ? 'good' : u.state === 'backfill' ? 'info' : u.state === 'paused' || u.state === 'unknown' ? 'minor' : 'crit',
    result: u.text,
    hint:
      u.state === 'stuck'
        ? '在「本机组件」里重启 TB Edge；排着的数据不丢，重启后自动补传'
        : u.state === 'offline'
          ? '网络恢复后 Edge 自动按原时间补传，不用手工处理；本地最多留 7 天'
          : u.state === 'unknown'
            ? `读不了 Edge 本地库：${d.edge.error ?? ''}`
            : '',
  })
  out.push({
    name: 'Edge 本地排队',
    level: backlog < 100 ? 'good' : 'info',
    result: d.edge.error ? '读不到' : `遥测 ${d.edge.tsKv} 条、其他事件 ${d.edge.events} 条；上送速度 ${d.edge.ratePerSec ?? '—'} 条/秒；最近推进 ${d.edge.lastAdvanceAt ? ago(d.now - d.edge.lastAdvanceAt) : '—'}`,
    hint: '子站看不到这个数（排着的数据送不上去），只有 EG 本机能看',
  })
  const off = d.clock.offsetMs
  out.push({
    name: '对时',
    level: off === null ? 'minor' : Math.abs(off) > 1000 ? 'minor' : 'good',
    result: off === null ? `测不到（${d.clock.server}）` : `本机比 ${d.clock.server} ${off >= 0 ? '快' : '慢'} ${Math.abs(off)} ms（${dt(d.clock.measuredAt)} 测）`,
    hint: off !== null && Math.abs(off) > 1000 ? '超过 1 s：检查 EG 的 chrony 配置是否指向站内时钟源 / 子站主机，子站会把这台的数据标「时间戳可疑」' : '',
  })
  out.push({
    name: '下挂设备',
    level: d.devices.dead.length ? 'crit' : st.devices.some(x => Object.keys(x.q).length) ? 'minor' : 'good',
    result: d.devices.dead.length
      ? `整台无数据：${d.devices.dead.join('、')}`
      : `${st.devices.length} 台都有数据${st.devices.some(x => Object.keys(x.q).length) ? '，个别量异常（看「实时数据」）' : ''}`,
    hint: d.devices.dead.length ? '先看同事的转换程序是否在跑、这台设备的接线；「实时数据 → 原始消息」看总线上有没有它' : '',
  })
  out.push({
    name: '设备名核对',
    level: d.devices.unknown.length ? 'crit' : 'good',
    result: d.devices.unknown.length ? `总线上有清单外的名字：${d.devices.unknown.join('、')}` : '总线上的设备名都在清单里',
    hint: d.devices.unknown.length ? '这些数据不会上送。核对同事程序里的设备名（「下挂设备」页有正确的名字与主题）' : '',
  })
  const disk = d.host.disk
  out.push({
    name: '主机资源',
    level: (disk?.usedPct ?? 0) > 85 || d.host.memUsedPct > 90 ? 'minor' : 'good',
    result: `运行 ${dur(d.host.uptimeSec)} · 内存 ${d.host.memUsedPct} % · 数据盘 ${disk ? `${disk.usedPct} %（剩 ${disk.freeGb} GB）` : '—'}`,
    hint: (disk?.usedPct ?? 0) > 85 ? '数据盘快满：Edge 本地留 7 天，断网太久会越积越多' : '',
  })
  for (const c of store.comps) {
    if (c.key === 'agent') continue
    out.push({
      name: `组件 · ${c.label}`,
      level: c.state === 'running' ? 'good' : c.state === '不存在' ? '' : 'crit',
      result: c.state === 'running' ? `运行 ${c.startedAt ? dur((Date.now() - c.startedAt) / 1000) : ''}，内存 ${c.memMb ?? '—'} MB${c.restarts ? `，自动重启过 ${c.restarts} 次` : ''}` : c.state,
      hint: c.state === '不存在' ? (c.key === 'mediamtx' ? '视频转发在 G4 装上' : '') : c.state !== 'running' ? '看「日志」里这个组件的最后几行' : '',
    })
  }
  return out
})

const canMaint = computed(() => session.me?.role === 'maint')
async function restart(key: 'edge' | 'gateway', label: string) {
  try {
    await ElMessageBox.confirm(`重启 ${label}？`, '重启组件', { confirmButtonText: '重启', cancelButtonText: '取消', type: 'warning' })
  } catch {
    return
  }
  try {
    await api(`components/${key}/restart`, { method: 'POST' })
    ElMessage.success(`已重启 ${label}`)
    void refreshSlow()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>诊断</h1>
      <span class="t2">每 5 秒刷新</span>
      <span class="sp" />
      <el-button size="small" :disabled="!canMaint" @click="restart('gateway', 'TB IoT Gateway')">重启 IoT Gateway</el-button>
      <el-button size="small" :disabled="!canMaint" @click="restart('edge', 'TB Edge')">重启 TB Edge</el-button>
    </div>
    <div class="panel" style="margin-top: 0">
      <div v-for="it in items" :key="it.name" class="row">
        <span class="dot" :class="it.level" />
        <span class="name">{{ it.name }}</span>
        <span class="res">{{ it.result }}<small v-if="it.hint" class="hint">{{ it.hint }}</small></span>
      </div>
      <div v-if="!items.length" class="empty">加载中…</div>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: flex-start; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.row .dot { margin-top: 6px; }
.name { width: 230px; flex: none; font-weight: 600; }
.res { flex: 1; display: flex; flex-direction: column; }
.hint { color: var(--muted); font-size: 12px; margin-top: 2px; }
</style>
