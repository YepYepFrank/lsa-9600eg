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
    hint: loss >= 100 ? '上行口（LAN2）网线、交换机、子站主机是否正常；子站的 MQTT（现场 8883）与 HTTP 端口要对 EG 开放' : loss > 0 ? '偶有失败：看交换机端口是否有错包' : '',
  })
  const u = d.uplink
  out.push({
    name: '数据上送（eg-agent → 子站）',
    level: u.state === 'ok' ? 'good' : u.state === 'backfill' ? 'info' : u.state === 'none' ? '' : u.state === 'paused' || u.state === 'unknown' ? 'minor' : 'crit',
    result: u.text,
    hint:
      u.state === 'offline'
        ? '网络恢复后自动按原时间补传，不用手工处理；本地最多留 7 天'
        : u.state === 'none'
          ? '数据先进本地 TB（本地告警、本地页面照常）；子站下发的 eg.yaml 带上子站地址与令牌后自动开始上送'
          : '',
  })
  out.push({
    name: '上送队列',
    level: u.depth === null ? '' : u.depth < 100 ? 'good' : 'info',
    result:
      u.depth === null
        ? '—'
        : `待发 ${u.depth} 条；最早未发 ${u.oldestUnsent ? ago(d.now - u.oldestUnsent) : '—'}；最近子站确认 ${u.lastAckAt ? ago(d.now - u.lastAckAt) : '—'}`,
    hint: '子站看得到这几个数（eg.buf_depth 等随 EG 自身指标上报）；断网时这里看积压了多少',
  })
  const ev = d.events
  if (ev) {
    out.push({
      name: '告警事件上送',
      level: ev.state === 'ok' ? 'good' : ev.state === 'retrying' ? 'crit' : ev.state === 'none' ? 'minor' : '',
      result: `${ev.text}；最近子站回执 ${ev.lastAckAt ? ago(d.now - ev.lastAckAt) : '—'}；本地规则链推送 ${ev.hook.count} 次，最近对账 ${ev.reconcile.lastAt ? ago(d.now - ev.reconcile.lastAt) : '—'}`,
      hint:
        ev.state === 'retrying'
          ? '事件留在本机、不会丢，子站恢复后自动补送（同一条告警只送最新状态）'
          : ev.state === 'none'
            ? 'eg.yaml 里没有本地 TB 账号：读不到本地告警，重新从子站生成 eg.yaml'
            : ev.reconcile.lastError
              ? `读本地告警失败：${ev.reconcile.lastError}（看「本机组件」里本地 TB 是否在跑）`
              : '',
    })
  }
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
    hint: (disk?.usedPct ?? 0) > 85 ? '数据盘快满：本地 TB 与上送队列各留 7 天，断网太久会越积越多' : '',
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
async function restart(key: 'tb' | 'gateway', label: string) {
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
      <el-button size="small" :disabled="!canMaint" @click="restart('tb', 'EG 本地 TB')">重启本地 TB</el-button>
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
