<!-- 视频：本柜双目摄像机的接入配置（ONVIF 地址、账号、四路 RTSP）与视频指标。
     预览、按需拉流、抓帧由 eg-video 在 G4 接上；视频不经 TB。 -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, session } from '../session'
import { refreshConfig, store } from '../store'
import { hms } from '../utils/fmt'

const form = reactive({ onvif: '', user: '', password: '', rtsp: { visible: '', thermal: '', visibleSub: '', thermalSub: '' } })
const saving = ref(false)
const canMaint = computed(() => session.me?.role === 'maint')
const hasPw = computed(() => store.config?.local.camera.password === '已设置')
const cam = computed(() => store.status?.devices.find(d => d.kind === 'camera') ?? null)
const camLive = ref<Record<string, { v: unknown; ts: number }>>({})

watch(
  () => store.config,
  c => {
    if (!c) return
    const k = c.local.camera
    Object.assign(form, { onvif: k.onvif, user: k.user, password: '', rtsp: { ...k.rtsp } })
  },
  { immediate: true },
)
watch(
  cam,
  async c => {
    if (!c) return
    try {
      camLive.value = (await api<{ telemetry: Record<string, { v: unknown; ts: number }> }>(`live/${c.name}`)).telemetry
    } catch {
      camLive.value = {}
    }
  },
  { immediate: true },
)

const STREAMS = [
  ['visible', '可见光 · 主码流', ''],
  ['visibleSub', '可见光 · 子码流', '-sub'],
  ['thermal', '热像 · 主码流', '-ir'],
  ['thermalSub', '热像 · 子码流', '-ir-sub'],
] as const

async function save() {
  saving.value = true
  try {
    const body = { camera: { onvif: form.onvif, user: form.user, rtsp: form.rtsp, ...(form.password ? { password: form.password } : {}) } }
    const r = await api<{ changed: string[] }>('config/local', { method: 'PUT', body })
    ElMessage.success(r.changed.length ? `已保存：${r.changed.join('、')}` : '没有改动')
    form.password = ''
    await refreshConfig()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>视频</h1>
      <span class="t2">每面柜一台双目摄像机（可见光 + 热像，ONVIF），接 EG 的 LAN1。视频不经 TB：由 eg-video 按需从摄像机拉流，子站再按需从 EG 拉，只拉有人在看的那一路。</span>
    </div>
    <div class="grid g3">
      <div class="card">
        <div class="k">摄像机在线路数</div>
        <div class="v">{{ camLive['cam.online']?.v ?? '—' }}<small>路</small></div>
        <div class="s">{{ cam?.name ?? '—' }} · {{ camLive['cam.online'] ? hms(camLive['cam.online'].ts) : '还没有指标' }}</div>
      </div>
      <div class="card">
        <div class="k">帧率</div>
        <div class="v">{{ camLive['cam.fps']?.v ?? '—' }}<small>fps</small></div>
      </div>
      <div class="card">
        <div class="k">码率</div>
        <div class="v">{{ camLive['cam.bitrate']?.v ?? '—' }}<small>kbps</small></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">摄像机接入<span class="t2">只看账号不能改；保存后 eg-video 按新地址拉流（G4）</span></div>
      <div class="panel-b">
        <el-form label-width="120px" size="small" :disabled="!canMaint" style="max-width: 760px" @submit.prevent="save">
          <el-form-item label="ONVIF 地址"><el-input v-model="form.onvif" placeholder="http://192.168.10.64/onvif/device_service" /></el-form-item>
          <el-form-item label="账号"><el-input v-model="form.user" style="width: 200px" /></el-form-item>
          <el-form-item label="口令"><el-input v-model="form.password" type="password" show-password :placeholder="hasPw ? '已设置（不回显），留空 = 不改' : '未设置'" style="width: 260px" /></el-form-item>
          <el-form-item v-for="[k, label, suffix] in STREAMS" :key="k" :label="label">
            <el-input v-model="form.rtsp[k]" placeholder="留空 = 由 ONVIF 查得" />
            <div class="note">子站上的路径：<code>{{ store.status?.cabinet.code }}{{ suffix }}</code></div>
          </el-form-item>
          <el-form-item><el-button type="primary" native-type="submit" :loading="saving">保存</el-button></el-form-item>
        </el-form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h">实况预览</div>
      <div class="panel-b empty">预览与抓帧在 G4（eg-video）接上：摄像机厂家的接口规格到了以后按 ONVIF 查流、生成 mediamtx 配置。</div>
    </div>
  </div>
</template>
