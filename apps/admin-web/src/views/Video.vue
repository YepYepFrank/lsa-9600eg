<!-- 视频与测温：本柜双目摄像机（G4）—— 四路流的来源与探测、EG mediamtx 状态、区域测温（R1–R3）、抓帧、接入配置。
     视频不经 TB：eg-video 按需从摄像机拉，子站再按需从 EG 拉，只拉有人在看的那一路。数据经 agent 的 /api/video/* 转自 eg-video。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, session } from '../session'
import { refreshConfig, store } from '../store'
import { hms } from '../utils/fmt'

interface Probe { ok: boolean; status?: number; error?: string; fps?: number; codec?: string; ms?: number }
interface Channel {
  key: string
  label: string
  path: string
  from: 'manual' | 'driver' | null
  uri: string | null
  snapshot: string | null
  probe: Probe | null
  mtx: { ready: boolean; readers: number; bytesReceived: number } | null
}
interface Region { id: string; name: string; label: string; type: string; coords: Record<string, unknown>; frame: { w: number; h: number } }
interface VideoStatus {
  available: boolean
  error?: string
  camera?: string | null
  driver?: { driver: string; ok: boolean; error: string | null; note: string | null; at: number | null } | null
  mediamtx?: { rtspPort: number; readFrom: string[]; error: string | null; updatedAt: number | null }
  channels?: Channel[]
  metrics?: Record<string, number>
  measure?: { supported: boolean; ok: boolean; error: string | null; code?: string | null; partial?: { what: string; error: string }[]; rest?: 'OK' | 'DEGRADED' | 'FAIL' | null; pollMs?: number; at: number | null; temps: Record<string, number>; regions: Region[]; regionsVer: string; alarm: string | null }
  /** 驱动细节（restv1：地址、令牌剩余、登录次数、固件版本、区域数、最近的错误；不含口令） */
  driverDetail?: { base?: string; token?: { validS: number } | null; logins?: number; firmware?: string | null; regions?: number | null; lastError?: string | null } | null
}

const vs = ref<VideoStatus | null>(null)
const camLive = ref<Record<string, { v: unknown; ts: number }>>({})
const cam = computed(() => store.status?.devices.find(d => d.kind === 'camera') ?? null)
const canMaint = computed(() => session.me?.role === 'maint')

async function load() {
  try {
    vs.value = await api<VideoStatus>('video/status')
  } catch (e) {
    vs.value = { available: false, error: (e as Error).message }
  }
  if (cam.value) {
    try {
      camLive.value = (await api<{ telemetry: Record<string, { v: unknown; ts: number }> }>(`live/${cam.value.name}`)).telemetry
    } catch {
      camLive.value = {}
    }
  }
}
let timer: number | undefined
onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 4000)
})
onUnmounted(() => window.clearInterval(timer))

const num = (k: string) => {
  const v = camLive.value[k]?.v
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : null
}
const t1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1))
const regionRows = computed(() =>
  (vs.value?.measure?.regions ?? []).map(r => ({
    ...r,
    max: num(`ir.${r.id}.max`) ?? num(`ir.${r.id}.pt`),
    min: num(`ir.${r.id}.min`),
    rise: num(`ir.${r.id}.rise`),
    at: r.type === 'point' ? null : [num(`ir.${r.id}.max_x`), num(`ir.${r.id}.max_y`)],
  })),
)
const q = computed(() => {
  const v = camLive.value['q']?.v
  try {
    return typeof v === 'string' ? (JSON.parse(v) as Record<string, string>) : {}
  } catch {
    return {}
  }
})
const fromText = (c: Channel) => (c.from === 'manual' ? '手填' : c.from === 'driver' ? (vs.value?.driver?.driver === 'onvif' ? 'ONVIF' : `驱动（${vs.value?.driver?.driver}）`) : '—')

// 抓帧
const snap = reactive<{ url: string; via: string; at: number; ch: string; busy: boolean }>({ url: '', via: '', at: 0, ch: '', busy: false })
async function grab(ch: 'visible' | 'ir') {
  snap.busy = true
  try {
    const r = await fetch(`api/video/snapshot?ch=${ch}`, { method: 'POST', headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} })
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? `抓帧失败（${r.status}）`)
    if (snap.url) URL.revokeObjectURL(snap.url)
    snap.url = URL.createObjectURL(await r.blob())
    snap.via = r.headers.get('x-snapshot-via') === 'camera' ? '摄像机抓图' : '从视频流解一帧'
    snap.at = Number(r.headers.get('x-snapshot-ts')) || Date.now()
    snap.ch = ch === 'ir' ? '热像' : '可见光'
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    snap.busy = false
  }
}

// 接入配置
const form = reactive({ driver: 'rtsp', restv1: '', onvif: '', user: '', password: '', rtsp: { visible: '', thermal: '', visibleSub: '', thermalSub: '' } })
const DRIVERS = [
  ['restv1', 'restv1（真机：测温、报警、抓拍、流地址）'],
  ['onvif', 'onvif（只有视频，ONVIF 查流地址）'],
  ['rtsp', 'rtsp（只有视频，只用手填地址）'],
  ['sim', 'sim（仿真摄像机，只在样机 / 实验台用）'],
] as const
const REST_TEXT: Record<string, string> = { OK: '正常', DEGRADED: '部分出错（温度照常）', FAIL: '失败' }
const saving = ref(false)
const hasPw = computed(() => store.config?.local.camera.password === '已设置')
watch(
  () => store.config,
  c => {
    if (!c) return
    const k = c.local.camera
    Object.assign(form, { driver: k.driver, restv1: k.restv1 ?? '', onvif: k.onvif, user: k.user, password: '', rtsp: { ...k.rtsp } })
  },
  { immediate: true },
)
async function save() {
  saving.value = true
  try {
    const body = { camera: { driver: form.driver, restv1: form.restv1, onvif: form.onvif, user: form.user, rtsp: form.rtsp, ...(form.password ? { password: form.password } : {}) } }
    const r = await api<{ changed: string[] }>('config/local', { method: 'PUT', body })
    ElMessage.success(r.changed.length ? `已保存：${r.changed.join('、')}（eg-video 已按新地址刷新）` : '没有改动')
    form.password = ''
    await refreshConfig()
    setTimeout(() => void load(), 1500)
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
const STREAMS = [
  ['visible', '可见光 · 主码流'],
  ['visibleSub', '可见光 · 子码流'],
  ['thermal', '热像 · 主码流'],
  ['thermalSub', '热像 · 子码流'],
] as const
</script>

<template>
  <div>
    <div class="page-h">
      <h1>视频与测温</h1>
      <span class="t2">每面柜一台双目摄像机（可见光 + 热像），接 EG 的 LAN1。视频不经 TB：eg-video 按需从摄像机拉，子站再按需从 EG 拉；区域测温 R1–R3 每 2 s 上报，温升由 EG 算。</span>
    </div>

    <div v-if="vs && !vs.available" class="panel">
      <div class="panel-b"><el-alert type="error" :closable="false" show-icon :title="`eg-video 没在跑：${vs.error ?? ''}`" description="视频与测温都靠它。看「本机组件」与日志；开发机上是 pnpm dev:video。" /></div>
    </div>

    <div class="grid g4">
      <div class="card">
        <div class="k">摄像机可用路数</div>
        <div class="v">{{ vs?.metrics?.['cam.online'] ?? '—' }}<small>/ 4 路</small></div>
        <div class="s">{{ cam?.name ?? '—' }} · 驱动 {{ vs?.driver?.driver ?? '—' }}</div>
      </div>
      <div class="card">
        <div class="k">全画面最高温</div>
        <div class="v">{{ t1(num('ir.max')) }}<small>℃</small></div>
        <div class="s">最低 {{ t1(num('ir.min')) }} ℃ · 最高点 ({{ num('ir.max_x') ?? '—' }}, {{ num('ir.max_y') ?? '—' }})</div>
      </div>
      <div class="card">
        <div class="k">帧率 / 码率</div>
        <div class="v">{{ vs?.metrics?.['cam.fps'] ?? '—' }}<small>fps</small></div>
        <div class="s">入站 {{ vs?.metrics?.['cam.bitrate'] ?? '—' }} kbps（没人看时为 0）</div>
      </div>
      <div class="card">
        <div class="k">摄像机原生报警</div>
        <div class="v" style="font-size: 16px">{{ vs?.measure?.alarm && vs.measure.alarm !== '{}' ? vs.measure.alarm : '无' }}</div>
        <div class="s">只记录，不建告警（与本地过温规则不重复计）</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">四路视频<span class="t2">EG mediamtx RTSP 端口 {{ vs?.mediamtx?.rtspPort ?? '—' }}，只许 {{ vs?.mediamtx?.readFrom?.join('、') || '子站主机与本机' }} 读</span></div>
      <div class="panel-b">
        <el-alert v-if="vs?.driver && !vs.driver.ok" type="warning" :closable="false" show-icon :title="`取流地址失败：${vs.driver.error}`" description="摄像机的地址、账号口令对不对；也可以在下面手填各路 RTSP。" style="margin-bottom: 10px" />
        <el-alert v-if="vs?.mediamtx?.error" type="warning" :closable="false" show-icon :title="vs.mediamtx.error" style="margin-bottom: 10px" />
        <el-table :data="vs?.channels ?? []" size="small" empty-text="—">
          <el-table-column label="路" min-width="120"><template #default="{ row }">{{ row.label }}</template></el-table-column>
          <el-table-column label="子站路径" min-width="110"><template #default="{ row }"><code>{{ row.path }}</code></template></el-table-column>
          <el-table-column label="来源" width="100"><template #default="{ row }">{{ fromText(row) }}</template></el-table-column>
          <el-table-column label="摄像机地址" min-width="260"><template #default="{ row }"><span class="mono t2">{{ row.uri ?? '没有地址' }}</span></template></el-table-column>
          <el-table-column label="探测" min-width="170">
            <template #default="{ row }">
              <span v-if="!row.probe" class="t2">—</span>
              <el-tag v-else-if="row.probe.ok" type="success" size="small">可用 {{ row.probe.codec ?? '' }}{{ row.probe.fps ? ` · ${row.probe.fps} fps` : '' }}</el-tag>
              <el-tag v-else type="danger" size="small">{{ row.probe.error }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="EG 转发" width="130">
            <template #default="{ row }">
              <span v-if="row.mtx?.ready">拉流中 · {{ row.mtx.readers }} 个读者</span>
              <span v-else class="t2">空闲（没人看）</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">区域测温<span class="t2">R1–R3 与部位的对应只来自配置，不等同 A / B / C 相；温升 = 区域最高温 − 本柜柜内空气温度</span></div>
      <div class="panel-b">
        <div v-if="vs?.measure && !vs.measure.supported" class="t2">当前驱动（{{ vs.driver?.driver }}）只有视频、不测温。</div>
        <template v-else>
          <el-alert v-if="vs?.measure && !vs.measure.ok && vs.measure.error" type="error" :closable="false" show-icon :title="`测温失败（${vs.measure.code ?? '—'}）：${vs.measure.error}`" description="cam.rest = FAIL；温度量与 cam.alarm 已标质量码「无效」并上送子站。" style="margin-bottom: 10px" />
          <el-alert v-else-if="vs?.measure?.partial?.length" type="warning" :closable="false" show-icon :title="`测温接口部分出错：${vs.measure.partial.map(p => p.error).join('；')}`" description="cam.rest = DEGRADED；温度照常，区域配置 / 报警状态用的是上一次读到的。" style="margin-bottom: 10px" />
          <div v-if="vs?.measure?.rest || vs?.driverDetail" class="note" style="margin: 0 0 8px">
            测温接口 cam.rest：<b>{{ vs?.measure?.rest ? REST_TEXT[vs.measure.rest] : '—' }}</b>；每 {{ ((vs?.measure?.pollMs ?? 2000) / 1000).toFixed(0) }} s 取一次、每 2 s 上报
            <template v-if="vs?.driverDetail">
              ；摄像机 {{ vs.driverDetail.base }}，固件 {{ vs.driverDetail.firmware || '—' }}，令牌{{ vs.driverDetail.token ? ` 还有 ${vs.driverDetail.token.validS} s` : '没有' }}（登录 {{ vs.driverDetail.logins ?? 0 }} 次），区域 {{ vs.driverDetail.regions ?? '—' }} 个
            </template>
          </div>
          <el-table :data="regionRows" size="small" empty-text="摄像机没有配置测温区域">
            <el-table-column label="区域" width="70"><template #default="{ row }"><b>{{ row.id }}</b></template></el-table-column>
            <el-table-column prop="label" label="部位" min-width="120" />
            <el-table-column label="摄像机上的名字 / 类型" min-width="150"><template #default="{ row }">{{ row.name }} · {{ row.type }}</template></el-table-column>
            <el-table-column label="最高 ℃" width="90"><template #default="{ row }">{{ t1(row.max) }}</template></el-table-column>
            <el-table-column label="最低 ℃" width="90"><template #default="{ row }">{{ t1(row.min) }}</template></el-table-column>
            <el-table-column label="温升 K" width="110">
              <template #default="{ row }">
                <span v-if="row.rise !== null">{{ t1(row.rise) }}</span>
                <el-tag v-else-if="q[`ir.${row.id}.rise`]" type="warning" size="small">{{ q[`ir.${row.id}.rise`] === 'stale' ? '暂不可算' : '无效' }}</el-tag>
                <span v-else class="t2">—</span>
              </template>
            </el-table-column>
            <el-table-column label="最高点（像素）" width="130"><template #default="{ row }">{{ row.at ? `(${row.at[0] ?? '—'}, ${row.at[1] ?? '—'})` : '—' }}</template></el-table-column>
          </el-table>
          <div class="note">区域温差 ir.dmax = {{ t1(num('ir.dmax')) }} K；区域配置版本 {{ vs?.measure?.regionsVer || '—' }}（画面 {{ vs?.measure?.regions?.[0]?.frame.w ?? '—' }}×{{ vs?.measure?.regions?.[0]?.frame.h ?? '—' }}）；{{ vs?.measure?.at ? `最近一次 ${hms(vs.measure.at)}` : '' }}</div>
        </template>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">抓帧<span class="t2">驱动能抓（restv1）或摄像机有抓图地址就用它，否则经本机 mediamtx 拉主码流解一帧（会顺带拉起、10 s 后自动断）</span></div>
      <div class="panel-b">
        <el-button size="small" :loading="snap.busy" @click="grab('visible')">可见光</el-button>
        <el-button size="small" :loading="snap.busy" @click="grab('ir')">热像</el-button>
        <div v-if="snap.url" style="margin-top: 10px">
          <img :src="snap.url" alt="抓帧" style="max-width: 100%; max-height: 420px; border: 1px solid var(--line); border-radius: 4px" />
          <div class="note">{{ snap.ch }} · {{ snap.via }} · {{ hms(snap.at) }}</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">摄像机接入<span class="t2">只看账号不能改；保存后 eg-video 马上按新地址刷新</span></div>
      <div class="panel-b">
        <el-form label-width="120px" size="small" :disabled="!canMaint" style="max-width: 760px" @submit.prevent="save">
          <el-form-item label="驱动">
            <el-select v-model="form.driver" style="width: 330px">
              <el-option v-for="[v, t] in DRIVERS" :key="v" :value="v" :label="t" />
            </el-select>
            <span class="note" style="margin-left: 8px">现场真机选 restv1（部署手册 §5a）</span>
          </el-form-item>
          <el-form-item v-if="form.driver === 'restv1'" label="摄像机地址"><el-input v-model="form.restv1" placeholder="http://192.168.10.64（只到主机[:端口]）" style="width: 330px" /></el-form-item>
          <el-form-item v-if="form.driver === 'onvif' || form.onvif" label="ONVIF 地址"><el-input v-model="form.onvif" placeholder="http://192.168.10.64/onvif/device_service" /></el-form-item>
          <el-form-item label="账号"><el-input v-model="form.user" style="width: 200px" /></el-form-item>
          <el-form-item label="口令"><el-input v-model="form.password" type="password" show-password :placeholder="hasPw ? '已设置（不回显），留空 = 不改' : '未设置'" style="width: 260px" /></el-form-item>
          <el-form-item v-for="[k, label] in STREAMS" :key="k" :label="label">
            <el-input v-model="form.rtsp[k]" placeholder="留空 = 由驱动给（restv1 / ONVIF / 仿真）；手填的优先" />
          </el-form-item>
          <el-form-item><el-button type="primary" native-type="submit" :loading="saving">保存</el-button></el-form-item>
        </el-form>
      </div>
    </div>
  </div>
</template>
