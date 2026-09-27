<!-- 证据（G5）：循环录像是否在录、证据索引与文件的上送状态、证据清单（告警 / 子站锁定触发的双光视频、抓图、录波）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, session } from '../session'
import { dt } from '../utils/fmt'

interface Item {
  evidenceId: string
  revision: number
  eventId: string | null
  requestId: string | null
  channelId: 'visible' | 'ir' | 'data'
  kind: 'video' | 'image' | 'wave'
  requestedStart: number
  requestedEnd: number
  actualStart: number | null
  actualEnd: number | null
  status: string
  location: string
  sizeBytes: number | null
  important: boolean
  pairOffsetMs: number | null
  createdAt: number
  expiresAt: number | null
  missingReason: string | null
  hasFile: boolean
  uploadError: string | null
}
interface Resp {
  status: { target: string | null; full: boolean; recOk: boolean | null; indexPending: number; indexError: string | null; uploadPending: number; config: { ringHours: number; preS: number; postS: number } }
  items: Item[]
}

interface Ring { channel: 'visible' | 'ir'; oldest: number | null; newest: number | null; recording: boolean; gaps?: { from: number; to: number }[] }
const data = ref<Resp | null>(null)
/** 循环录像覆盖与断档（mediamtx 重启、摄像机断流会留缺口；落在缺口里的证据会标 gap / 缺证） */
const ring = ref<Ring[]>([])
async function load() {
  void api<{ paths: Ring[] }>('video/recording').then(r => (ring.value = r.paths)).catch(() => (ring.value = []))
  try {
    data.value = await api<Resp>('evidence?limit=300')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
let timer: number | undefined
onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 5000)
})
onUnmounted(() => window.clearInterval(timer))

const KIND: Record<string, string> = { video: '视频', image: '抓图', wave: '录波' }
const CH: Record<string, string> = { visible: '可见光', ir: '热像', data: '传感器' }
const STATUS: Record<string, [string, 'success' | 'info' | 'warning' | 'danger' | 'primary']> = {
  RECORDING: ['录制中', 'primary'],
  READY: ['在 EG 上', 'success'],
  UPLOADED: ['已上传子站', 'success'],
  EXPIRED: ['已过期', 'info'],
  MISSING: ['缺证', 'danger'],
  DELETED: ['已清理', 'info'],
}
const REASON: Record<string, string> = { stream_down: '录像断流', gap: '部分缺口', no_data: '没有数据', camera_unreachable: '摄像机不通', disk_full: '数据盘满', expired: '晚于循环覆盖' }
const size = (b: number | null) => (b === null ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)
const secs = (a: number | null, b: number | null) => (a === null || b === null ? '—' : `${Math.round((b - a) / 1000)} s`)

const view = ref<{ url: string; kind: string; title: string } | null>(null)
async function open(it: Item) {
  try {
    const r = await fetch(`api/evidence/${encodeURIComponent(it.evidenceId)}/file`, { headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} })
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? `取文件失败（${r.status}）`)
    if (view.value) URL.revokeObjectURL(view.value.url)
    view.value = { url: URL.createObjectURL(await r.blob()), kind: it.kind, title: `${KIND[it.kind]} · ${CH[it.channelId]} · ${dt(it.actualStart ?? it.requestedStart)}` }
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
const canMaint = computed(() => session.me?.role === 'maint')
async function upload(it: Item) {
  try {
    await api(`evidence/${encodeURIComponent(it.evidenceId)}/upload`, { method: 'POST' })
    ElMessage.success('已排队上传子站')
    void load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>证据</h1>
      <span class="t2">两路子码流常录做循环录像（留 {{ data?.status.config.ringHours ?? '—' }} h）；告警发生或子站请求时锁定前 {{ data?.status.config.preS ?? '—' }} s、后 {{ data?.status.config.postS ?? '—' }} s，连同双光抓图与录波形成证据清单。重要的自动上传子站，其余子站按需调取。</span>
    </div>
    <div class="grid g4">
      <div class="card">
        <div class="k">循环录像</div>
        <div class="v" style="font-size: 18px">{{ data?.status.recOk === null ? '—' : data?.status.recOk ? '在录' : '没在录' }}</div>
        <div class="s">两路子码流</div>
      </div>
      <div class="card">
        <div class="k">待送索引</div>
        <div class="v">{{ data?.status.indexPending ?? '—' }}<small>条</small></div>
        <div class="s">{{ data?.status.indexError ?? (data?.status.target ? '送子站' : '不送子站（上送没开）') }}</div>
      </div>
      <div class="card">
        <div class="k">待上传文件</div>
        <div class="v">{{ data?.status.uploadPending ?? '—' }}<small>条</small></div>
        <div class="s">重要证据自动上传</div>
      </div>
      <div class="card">
        <div class="k">证据存储</div>
        <div class="v" style="font-size: 18px">{{ data?.status.full ? '已满' : '正常' }}</div>
        <div class="s">{{ data?.status.full ? '新的锁定会标缺证，要尽快处理' : '' }}</div>
      </div>
    </div>

    <div v-if="ring.length" class="panel">
      <div class="panel-h">循环录像覆盖与断档<span class="t2">相邻两段之间空出 > 1.5 s 记为断档；证据的视频窗口落在断档里会标「部分缺口」</span></div>
      <div class="panel-b">
        <el-table :data="ring" size="small">
          <el-table-column label="通道" width="110"><template #default="{ row }">{{ CH[row.channel] }}子码流</template></el-table-column>
          <el-table-column label="覆盖" width="320"><template #default="{ row }">{{ row.oldest ? dt(row.oldest) : '—' }} — {{ row.newest ? dt(row.newest) : '—' }}{{ row.recording ? '（在录）' : '（没在录）' }}</template></el-table-column>
          <el-table-column label="断档（最近的在后）">
            <template #default="{ row }">
              <span v-if="!row.gaps?.length" class="muted">无</span>
              <span v-for="g in row.gaps" :key="g.from" class="gap">{{ dt(g.from) }} 起 {{ ((g.to - g.from) / 1000).toFixed(1) }} s</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">证据清单</div>
      <div class="panel-b">
        <el-table :data="data?.items ?? []" size="small" empty-text="还没有证据（本地告警发生或子站请求锁定时生成）">
          <el-table-column label="登记" width="150"><template #default="{ row }">{{ dt(row.createdAt) }}</template></el-table-column>
          <el-table-column label="种类" width="110"><template #default="{ row }">{{ KIND[row.kind] }} · {{ CH[row.channelId] }}</template></el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="STATUS[row.status]?.[1] ?? 'info'" size="small">{{ STATUS[row.status]?.[0] ?? row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="实际起止" min-width="200">
            <template #default="{ row }">{{ row.actualStart ? `${dt(row.actualStart)}（${secs(row.actualStart, row.actualEnd)}）` : `请求 ${dt(row.requestedStart)}` }}</template>
          </el-table-column>
          <el-table-column label="双光差" width="80"><template #default="{ row }">{{ row.pairOffsetMs === null ? '—' : `${row.pairOffsetMs} ms` }}</template></el-table-column>
          <el-table-column label="大小" width="80"><template #default="{ row }">{{ size(row.sizeBytes) }}</template></el-table-column>
          <el-table-column label="位置" width="80"><template #default="{ row }">{{ { edge: 'EG', station: '子站', both: '两处', none: '—' }[row.location as string] }}</template></el-table-column>
          <el-table-column label="说明" min-width="180">
            <template #default="{ row }">
              <span v-if="row.missingReason" class="t2">{{ REASON[row.missingReason] ?? row.missingReason }}</span>
              <span v-if="row.important"> · 重要</span>
              <span v-if="row.uploadError" class="t2"> · 上传：{{ row.uploadError }}</span>
              <span v-if="row.eventId" class="t2"> · 告警 {{ row.eventId.slice(0, 8) }}</span>
              <span v-if="row.requestId" class="t2"> · 子站请求 {{ row.requestId.slice(0, 8) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="" width="130">
            <template #default="{ row }">
              <el-button v-if="row.hasFile" link size="small" @click="open(row)">查看</el-button>
              <el-button v-if="row.hasFile && canMaint && row.status === 'READY'" link size="small" @click="upload(row)">传子站</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <el-dialog :model-value="!!view" :title="view?.title" width="760px" @close="view = null">
      <video v-if="view?.kind === 'video'" :src="view.url" controls autoplay style="width: 100%" />
      <img v-else-if="view?.kind === 'image'" :src="view.url" style="max-width: 100%" alt="抓图" />
      <a v-else-if="view" :href="view.url" download="wave.json">下载录波 JSON</a>
    </el-dialog>
  </div>
</template>

<style scoped>
.gap { display: inline-block; margin: 0 10px 2px 0; padding: 0 6px; border-radius: 3px; background: rgba(var(--minor-rgb), .14); color: var(--text); font-variant-numeric: tabular-nums; }
</style>
