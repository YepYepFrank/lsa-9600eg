<!-- 概览：这台 EG 好不好、数据上没上去、下挂设备有没有数、各组件活着没有 -->
<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, session } from '../session'
import { refreshSlow, selfVal, store } from '../store'
import { ago, dt, dur } from '../utils/fmt'
import { KIND, type Comp, type Dev } from '../types'

const router = useRouter()
const st = computed(() => store.status)
const d = computed(() => store.diag)

const UPCLS: Record<string, string> = { ok: 'good', backfill: 'info', paused: 'minor', offline: 'crit', stuck: 'crit', none: '', unknown: 'minor' }
const UPTXT: Record<string, string> = { ok: '正常', backfill: '补传中', paused: '暂停', offline: '离线', stuck: '卡住', none: '未接上', unknown: '未知' }
const clk = computed(() => d.value?.clock.offsetMs ?? null)
const clkBad = computed(() => clk.value !== null && Math.abs(clk.value) > 1000)

/** 资源条：CPU、内存、存储、机内温度（EG 自身指标，取不到的显示「—」） */
const res = computed(() => [
  { k: 'CPU', v: selfVal('eg.cpu'), unit: '%', warn: 80, max: 100 },
  { k: '内存', v: selfVal('eg.mem'), unit: '%', warn: 85, max: 100 },
  { k: '存储', v: selfVal('eg.ssd'), unit: '%', warn: 80, max: 100 },
  { k: '机内温度', v: selfVal('eg.temp'), unit: '℃', warn: 70, max: 90 },
])

function devState(x: Dev): [string, string] {
  if (x.dead) return ['crit', '整台无数据']
  if (x.ageSec === null) return ['', '还没收到']
  const n = Object.keys(x.q).length
  if (n) return ['minor', `${n} 个量异常`]
  return ['good', '正常']
}

async function restart(c: Comp) {
  try {
    await ElMessageBox.confirm(
      `重启 ${c.label}？${c.key === 'tb' ? '约 1 分钟；期间数据由 IoT Gateway 排着，不丢。' : '几秒；期间数据由本机总线排着，不丢。'}`,
      '重启组件',
      { confirmButtonText: '重启', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await api(`components/${c.key}/restart`, { method: 'POST' })
    ElMessage.success(`已重启 ${c.label}`)
    void refreshSlow()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
const canMaint = computed(() => session.me?.role === 'maint')
</script>

<template>
  <div v-if="st">
    <section class="grid g4">
      <div class="card">
        <div class="k">EG 状态</div>
        <div class="v" :class="st.state === 'online' ? 'good' : 'minor'">{{ st.state === 'online' ? '正常' : '降级' }}</div>
        <div class="s">{{ st.state === 'online' ? `下挂 ${st.devices.length} 台设备都有数据` : `整台无数据：${d?.devices.dead.join('、') || '—'}` }}</div>
      </div>
      <div class="card">
        <div class="k">上送子站</div>
        <div class="v" :class="UPCLS[d?.uplink.state ?? 'unknown']">{{ d ? UPTXT[d.uplink.state] : '…' }}</div>
        <div class="s">{{ d?.uplink.text ?? '…' }}<br />待发 {{ d?.uplink.depth ?? '—' }} 条</div>
      </div>
      <div class="card">
        <div class="k">到子站 {{ d?.sp.host }}</div>
        <div class="v" :class="(d?.sp.lossPct ?? 0) >= 50 ? 'crit' : ''">{{ d?.sp.latMs ?? '—' }}<small>ms</small></div>
        <div class="s">近 1 分钟失败率 {{ d?.sp.lossPct ?? '—' }} %（TCP {{ d?.sp.port }}）</div>
      </div>
      <div class="card">
        <div class="k">对时偏差</div>
        <div class="v" :class="clkBad ? 'minor' : ''">{{ clk === null ? '—' : (clk > 0 ? '+' : '') + (Math.abs(clk) >= 1000 ? (clk / 1000).toFixed(1) + ' s' : clk + ' ms') }}</div>
        <div class="s">{{ clkBad ? '超过 1 s，子站会标「时间戳可疑」' : '±1 s 以内正常' }} · {{ d?.clock.server }}</div>
      </div>
    </section>

    <section class="grid g4" style="margin-top: 12px">
      <div v-for="r in res" :key="r.k" class="card">
        <div class="k">{{ r.k }}</div>
        <div class="v">{{ r.v ?? '—' }}<small v-if="r.v !== null">{{ r.unit }}</small></div>
        <div class="bar"><i :class="r.v !== null && r.v >= r.warn ? 'crit' : ''" :style="{ width: r.v === null ? '0' : Math.min(100, (r.v / r.max) * 100) + '%' }" /></div>
      </div>
    </section>

    <div class="panel">
      <div class="panel-h">下挂设备<span class="t2">设备清单由子站下发；数据由同事的转换程序经本机总线送来</span><span class="sp" /><el-button size="small" text @click="router.push('/manage/devices')">详情 ›</el-button></div>
      <el-table :data="st.devices" size="small" @row-click="(r: Dev) => router.push('/manage/live/' + r.name)" style="cursor: pointer">
        <el-table-column label="设备" width="170"><template #default="{ row }"><span class="mono">{{ row.name }}</span></template></el-table-column>
        <el-table-column prop="label" label="名称" min-width="150" />
        <el-table-column label="类型" width="110"><template #default="{ row }">{{ KIND[row.kind] }}</template></el-table-column>
        <el-table-column prop="keys" label="测点" width="70" align="right" />
        <el-table-column label="最近数据" width="150"><template #default="{ row }">{{ row.lastTs ? ago(row.ageSec * 1000) : '—' }}</template></el-table-column>
        <el-table-column label="状态" width="140">
          <template #default="{ row }"><span class="dot" :class="devState(row)[0]" />{{ devState(row)[1] }}</template>
        </el-table-column>
        <el-table-column label="到达率（24 h）" width="120" align="right">
          <template #default="{ row }">{{ row.south?.rate == null ? '—' : row.south.rate.toFixed(2) + ' %' }}</template>
        </el-table-column>
      </el-table>
      <div v-if="st.unknownDevices.length" class="panel-b note crit">总线上有不在设备清单里的设备名：{{ st.unknownDevices.join('、') }}（这些数据不会上送，请核对同事程序里的设备名）</div>
    </div>

    <div class="panel">
      <div class="panel-h">本机组件<span class="t2">重启只开放本地 TB 与 IoT Gateway</span></div>
      <el-table :data="store.comps" size="small">
        <el-table-column prop="label" label="组件" min-width="170" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><span class="dot" :class="row.state === 'running' ? 'good' : row.state === '不存在' ? '' : 'crit'" />{{ row.state === 'running' ? '运行' : row.state }}</template>
        </el-table-column>
        <el-table-column label="已运行" width="120"><template #default="{ row }">{{ row.startedAt ? dur((Date.now() - row.startedAt) / 1000) : '—' }}</template></el-table-column>
        <el-table-column label="内存" width="90" align="right"><template #default="{ row }">{{ row.memMb == null ? '—' : row.memMb + ' MB' }}</template></el-table-column>
        <el-table-column label="CPU" width="80" align="right"><template #default="{ row }">{{ row.cpuPct == null ? '—' : row.cpuPct + ' %' }}</template></el-table-column>
        <el-table-column label="镜像" min-width="200"><template #default="{ row }"><span class="mono muted">{{ row.image ?? '—' }}</span></template></el-table-column>
        <el-table-column width="90" align="center">
          <template #default="{ row }">
            <el-button v-if="row.restartable" size="small" :disabled="!canMaint || row.state !== 'running'" :title="canMaint ? '' : '只读账号不能重启'" @click="restart(row)">重启</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <p class="note">本机总线已收 {{ st.bus.msgs.toLocaleString() }} 条 · eg-agent 运行 {{ dur(st.uptimeSec) }}、内存 {{ st.rssMb }} MB · 更新于 {{ dt(store.updatedAt) }}</p>
  </div>
  <div v-else class="empty">加载中…</div>
</template>
