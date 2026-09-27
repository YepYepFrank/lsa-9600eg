<script lang="ts">
export type StreamState = 'connecting' | 'playing' | 'nosignal'
/** 本页 WebRTC 是否不通（ICE 失败 / 超时）：模块级，所有窗口共用 —— 一旦不通，后面的窗口直接走 HLS */
const rtcBroken = { v: false }
</script>

<script setup lang="ts">
/* 一路实时视频（契约 §5，F3）：WebRTC（WHEP）为主，延迟 < 500 ms；连不通（站内防火墙挡了 UDP 8189 之类）退到 HLS。
 *   · WebRTC 首帧 8 s 内出不来就换 HLS（HLS 起播要攒几个分片，给 20 s）；都不行显示「无视频信号」，按 5 → 10 → 20 → 30 s 退避重连
 *   · 本页已经有一路 WebRTC 因 ICE 不通失败过，后续窗口直接走 HLS，免得 16 分屏每格都白等 8 s
 *   · 滚出视野 / 页面切到后台 5 s 后断流，回来再连 —— 列表页、监视墙翻页不白占带宽和解码
 * 地址是同源相对路径（/stream/<路径>/whep、/hls/<路径>/index.m3u8），开发机 vite、子站 Nginx 转给 mediamtx。 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ whep: string; hls?: string }>()
const emit = defineEmits<{ state: [s: StreamState, via: 'webrtc' | 'hls' | null] }>()

const video = ref<HTMLVideoElement>()
const box = ref<HTMLDivElement>()
const state = ref<StreamState>('connecting')
const via = ref<'webrtc' | 'hls' | null>(null)
defineExpose({ video, state })

const FIRST_FRAME_MS = 8000
/** 低延迟 HLS 按需起流：mediamtx 要先攒够分片才出播放列表，实测 10 s 上下 */
const FIRST_FRAME_HLS_MS = 20000
const BACKOFF = [5000, 10000, 20000, 30000]

let pc: RTCPeerConnection | null = null
let session: string | null = null
let hls: { destroy(): void } | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let tries = 0
let gen = 0
let want = false

function setState(s: StreamState, v: 'webrtc' | 'hls' | null = via.value) {
  state.value = s
  via.value = v
  emit('state', s, v)
}

function teardown() {
  clearTimeout(timer)
  gen++
  if (pc) {
    pc.ontrack = null
    pc.onconnectionstatechange = null
    pc.close()
    pc = null
  }
  // WHEP 会话显式结束，mediamtx 那边立刻释放（按需生成的测试流也就能及时停）
  if (session) void fetch(session, { method: 'DELETE' }).catch(() => {})
  session = null
  hls?.destroy()
  hls = null
  const v = video.value
  if (v) {
    v.srcObject = null
    v.removeAttribute('src')
    v.load()
  }
}

async function start() {
  teardown()
  if (!want) return
  const my = gen
  setState('connecting', null)
  const ok = !rtcBroken.v && (await tryWebrtc(my))
  if (my !== gen) return
  if (ok) return void (tries = 0)
  if (props.hls && (await tryHls(my))) return void (tries = 0)
  if (my !== gen) return
  setState('nosignal', null)
  timer = setTimeout(start, BACKOFF[Math.min(tries++, BACKOFF.length - 1)])
}

/** 等首帧：解码出第一帧（loadeddata）或开始播放（playing）才算连上。
 *  只等 playing 不够：浏览器在页面不可见时不自动播 muted 的 MSE 视频，数据到了也不发 playing */
function firstFrame(my: number, ms = FIRST_FRAME_MS): Promise<boolean> {
  const v = video.value!
  return new Promise(res => {
    if (v.readyState >= 2) return res(my === gen)
    const done = (ok: boolean) => {
      clearTimeout(t)
      v.removeEventListener('playing', on)
      v.removeEventListener('loadeddata', on)
      res(ok && my === gen)
    }
    const on = () => done(true)
    const t = setTimeout(() => done(false), ms)
    v.addEventListener('playing', on)
    v.addEventListener('loadeddata', on)
  })
}

async function tryWebrtc(my: number): Promise<boolean> {
  try {
    const c = new RTCPeerConnection({ iceServers: [] })
    pc = c
    c.addTransceiver('video', { direction: 'recvonly' })
    c.ontrack = ev => {
      if (video.value && my === gen) {
        video.value.srcObject = ev.streams[0] ?? new MediaStream([ev.track])
        void video.value.play().catch(() => {})
      }
    }
    await c.setLocalDescription(await c.createOffer())
    // 站内网络不用 trickle：等候选收集完（最多 2 s）一次发出去
    await new Promise<void>(res => {
      if (c.iceGatheringState === 'complete') return res()
      const t = setTimeout(res, 2000)
      c.onicegatheringstatechange = () => c.iceGatheringState === 'complete' && (clearTimeout(t), res())
    })
    const r = await fetch(props.whep, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: c.localDescription!.sdp })
    // 路径没有推流（SAM 没接、测试流没起来）：mediamtx 回 404，这不是 WebRTC 不通，不改走 HLS 的判断
    if (!r.ok) return false
    const loc = r.headers.get('Location')
    session = loc ? new URL(loc, new URL(props.whep, location.href)).href : null
    await c.setRemoteDescription({ type: 'answer', sdp: await r.text() })
    if (my !== gen) return false
    const ok = await firstFrame(my)
    if (!ok) {
      // 信令通了、媒体没到：多半是 UDP 被挡，以后直接走 HLS
      if (c.iceConnectionState !== 'connected' && c.iceConnectionState !== 'completed') rtcBroken.v = true
      return false
    }
    setState('playing', 'webrtc')
    c.onconnectionstatechange = () => {
      if (my === gen && (c.connectionState === 'failed' || c.connectionState === 'disconnected')) void start()
    }
    return true
  } catch {
    return false
  }
}

async function tryHls(my: number): Promise<boolean> {
  const v = video.value!
  try {
    const { default: Hls } = await import('hls.js')
    if (my !== gen) return false
    if (Hls.isSupported()) {
      const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 })
      hls = h
      h.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal && my === gen) void start()
      })
      h.loadSource(props.hls!)
      h.attachMedia(v)
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = props.hls!
    } else return false
    void v.play().catch(() => {})
    const ok = await firstFrame(my, FIRST_FRAME_HLS_MS)
    if (ok) setState('playing', 'hls')
    return ok
  } catch {
    return false
  }
}

/* 看得见才拉流：滚出视野或页面到后台 5 s 后断开 */
let visible = true
let io: IntersectionObserver | null = null
let idle: ReturnType<typeof setTimeout> | undefined
function update() {
  const should = visible && !document.hidden
  clearTimeout(idle)
  if (should && !want) {
    want = true
    void start()
  } else if (!should && want) {
    idle = setTimeout(() => {
      want = false
      teardown()
      setState('connecting', null)
    }, 5000)
  }
}
const onVis = () => update()
onMounted(() => {
  io = new IntersectionObserver(es => {
    visible = es.some(e => e.isIntersecting)
    update()
  })
  if (box.value) io.observe(box.value)
  document.addEventListener('visibilitychange', onVis)
  update()
})
onBeforeUnmount(() => {
  want = false
  clearTimeout(idle)
  io?.disconnect()
  document.removeEventListener('visibilitychange', onVis)
  teardown()
})
watch(() => [props.whep, props.hls], () => {
  tries = 0
  if (want) void start()
})
</script>

<template>
  <div ref="box" class="sv">
    <video ref="video" muted playsinline autoplay disablepictureinpicture />
    <div v-if="state !== 'playing'" class="st">{{ state === 'connecting' ? '连接视频…' : '无视频信号 · 自动重连中' }}</div>
    <span v-else-if="via === 'hls'" class="via" title="WebRTC 连不通（站内 UDP 8189 可能被挡），已改走 HLS，延迟约 2–3 s">HLS</span>
  </div>
</template>

<style scoped>
.sv { position: absolute; inset: 0; background: #0b0d0e; }
.sv video { width: 100%; height: 100%; object-fit: contain; display: block; }
.st { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255, 255, 255, .7); font-size: 12px; }
.via { position: absolute; right: 6px; bottom: 5px; font-size: 10px; color: #fff; background: rgba(0, 0, 0, .55); padding: 0 4px; border-radius: 2px; }
</style>
