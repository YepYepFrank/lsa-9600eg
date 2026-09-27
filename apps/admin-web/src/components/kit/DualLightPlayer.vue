<script setup lang="ts">
/* 双光播放器：可见光 + 红外热成像。模式：并排 / 可见光 / 热像 / 融合；框温（各相最高温）。
   画面三种来源（F3）：
     · streams：实时流（WebRTC，连不通退 HLS），见 StreamVideo。热像的伪彩由 SAM 出，调色板只对示意画面生效
     · image：一张抓拍图（告警抓拍、手动抓拍），整幅显示
     · 都没有：示意画面（Mock、SAM 未接入），演示状态由页面统一标识
   画面上的数字一律来自调用方传入的实测值：框温只认 boxes（VideoChannel.boxes），最高温只认 tmax，色标下限只认 envT。
   实时流上各框在画面里的位置要 SAM 的分框定义（属性 ir.boxes，硬件接入时给），现在框温以标签条列出，不在画面上画框。
   点温要 SAM 的热像温度矩阵，接口未接入前不提供取点。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DualStreams } from '@/utils/video'
import StreamVideo from './StreamVideo.vue'

export type DualMode = 'side' | 'visible' | 'thermal' | 'fusion'
export type Palette = 'iron' | 'white' | 'rainbow'
const props = withDefaults(defineProps<{
  hot?: number; tmax?: number | null; big?: boolean; offline?: boolean; thermalCap?: string
  mode?: DualMode; palette?: Palette; phases?: number; spotTool?: boolean
  /** 各相分框最高温（A、B、C[、N]，取不到为 null）→ 画分框并标温度；只传 true = 只画分框不标温度（没有框温来源时） */
  boxes?: boolean | (number | null)[]
  /** 可选区域编号，与调用方的测温部位表对应 */
  boxLabels?: string[]
  /** 环境温度（色标下限）；取不到为 null，显示「—」 */
  envT?: number | null
  /** 铺满父容器（监视墙窗口），不再按 4:3 自己定高 */
  fill?: boolean; offlineText?: string
  /** 实时流（utils/video 的 streamsOf）；null = 没有流，画示意 */
  streams?: DualStreams | null
  /** 抓拍图（已取成 object URL，见 useAuthImage）；给了就整幅显示这张图 */
  image?: string | null
  /** EG：按摄像机坐标画的测温区（热像画面上的 0–1 比例坐标），温度取不到为 null；hot = 最热的（标黄） */
  rois?: { label: string; temp: number | null; hot: boolean; x: number; y: number; w: number; h: number; point?: boolean }[]
  /** 测温区坐标所在画面的宽高比（如 640 / 512） */
  frameAspect?: number
}>(), { hot: 1, thermalCap: '红外热成像', mode: 'side', palette: 'iron', phases: 3, envT: null, streams: null, image: null, frameAspect: 1.25 })

/* 热像实况按 object-fit: contain 显示：测温区图层要贴着实际画面区域（去掉上下 / 左右黑边） */
const thmPane = ref<HTMLDivElement>()
const paneSize = ref({ w: 0, h: 0 })
let paneRo: ResizeObserver | undefined
watch(thmPane, el => {
  paneRo?.disconnect()
  if (!el) return
  paneRo = new ResizeObserver(() => (paneSize.value = { w: el.clientWidth, h: el.clientHeight }))
  paneRo.observe(el)
})
onBeforeUnmount(() => paneRo?.disconnect())
const roiRect = computed(() => {
  const { w, h } = paneSize.value
  if (!w || !h) return { inset: '0' }
  const a = props.frameAspect
  const cw = w / h > a ? h * a : w
  const ch = w / h > a ? h : w / a
  return { left: `${(w - cw) / 2}px`, top: `${(h - ch) / 2}px`, width: `${cw}px`, height: `${ch}px` }
})

const live = computed(() => !props.offline && !props.image && !!props.streams)

const cv = ref<HTMLCanvasElement>()
const W = 160, Hh = 120
const geo = computed(() => (props.phases === 4 ? [0.2, 0.4, 0.6, 0.8] : [0.27, 0.5, 0.73]))
const labels = computed(() => (props.phases === 4 ? ['A', 'B', 'C', 'N'] : ['A', 'B', 'C']))
const PHASE = ['#d8b21c', '#2f9b4a', '#c23a34', '#4a6f8a']
const RAMPS: Record<Palette, number[][]> = {
  iron: [[8, 4, 40], [88, 16, 120], [190, 40, 90], [245, 130, 30], [255, 225, 90], [255, 255, 240]],
  white: [[10, 10, 12], [90, 90, 94], [170, 170, 172], [255, 255, 255]],
  rainbow: [[20, 20, 110], [20, 140, 200], [40, 180, 90], [240, 220, 50], [235, 90, 40], [255, 245, 240]],
}
/** 示意热场 0..1（只用于着色，不换算成温度） */
function field(x: number, y: number): number {
  let v = 0.12 + 0.05 * Math.sin(x / 17) * Math.cos(y / 13)
  geo.value.forEach((g, i) => {
    const cx = g * W, dx = Math.abs(x - cx), isHot = i === props.hot % geo.value.length
    if (dx < 7 && y > 18) v = Math.max(v, (isHot ? 0.5 : 0.36) - dx * 0.015)
    v += (isHot ? 0.62 : 0.2) * Math.exp(-((x - cx) ** 2 + (y - 66) ** 2) / (isHot ? 260 : 160))
  })
  return Math.min(1, v)
}

function color(t: number): number[] {
  const s = RAMPS[props.palette], f = Math.max(0, Math.min(1, t)) * (s.length - 1), i = Math.min(s.length - 2, Math.floor(f)), k = f - i
  return s[i].map((c, j) => c + (s[i + 1][j] - c) * k)
}
const showBoxes = computed(() => !!props.boxes)
/** 分框标签：有框温数组时标实测值（取不到为 --），只开了分框时只标相别 */
const boxLabel = (i: number) => props.boxLabels?.[i] ?? labels.value[i]
const boxText = (i: number) => (Array.isArray(props.boxes) ? `${boxLabel(i)} ${props.boxes[i] ?? '--'}${props.boxLabels ? '℃' : ''}` : boxLabel(i))
function draw() {
  const c = cv.value
  if (!c) return
  c.width = W; c.height = Hh
  const ctx = c.getContext('2d')!, img = ctx.createImageData(W, Hh)
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const rgb = color(field(x, y)), o = (y * W + x) * 4
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}
onMounted(draw)
// 从实况 / 抓拍切回示意时 canvas 是新挂上的，要重画
watch(() => [props.hot, props.palette, props.phases, live.value, props.image], () => requestAnimationFrame(draw))
const showVis = computed(() => props.mode !== 'thermal'), showThm = computed(() => props.mode !== 'visible')
const scale = computed(() => `linear-gradient(to top, ${RAMPS[props.palette].map(c => `rgb(${c.join(',')})`).join(',')})`)

/* 手动抓拍（F3）：把正在播放的可见光、热像两路当前帧并排截成一张 JPEG；没有实况画面返回 null（后端落占位图） */
const visV = ref<InstanceType<typeof StreamVideo>>()
const irV = ref<InstanceType<typeof StreamVideo>>()
async function capture(): Promise<Blob | null> {
  const vids = [visV.value, irV.value]
    .filter(s => s?.state === 'playing')
    .map(s => s!.video)
    .filter((v): v is HTMLVideoElement => !!v && v.videoWidth > 0)
  if (!vids.length) return null
  const h = Math.max(...vids.map(v => v.videoHeight))
  const ws = vids.map(v => Math.round((v.videoWidth * h) / v.videoHeight))
  const c = document.createElement('canvas')
  c.width = ws.reduce((a, b) => a + b, 0)
  c.height = h
  const ctx = c.getContext('2d')!
  let x = 0
  vids.forEach((v, i) => {
    ctx.drawImage(v, x, 0, ws[i]!, h)
    x += ws[i]!
  })
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.85))
}
defineExpose({ capture })
</script>

<template>
  <div class="dual" :class="[{ big, fill, snap: !!image }, 'm-' + mode]" style="position:relative">
    <!-- 抓拍图：整幅一张 -->
    <div v-if="image" class="pane img"><img :src="image" alt="抓拍" /><span class="cap">{{ thermalCap }}</span></div>
    <template v-else>
      <div v-if="showVis" class="pane vis">
        <template v-if="live">
          <StreamVideo v-if="streams!.vis" ref="visV" :whep="streams!.vis.whep" :hls="streams!.vis.hls" />
          <div v-else class="nost">可见光流未接入</div>
        </template>
        <svg v-else viewBox="0 0 320 240" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="dl-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4346" /><stop offset="1" stop-color="#1c2224" /></linearGradient>
            <linearGradient id="dl-cu" x1="0" x2="1"><stop offset="0" stop-color="#8a4f2a" /><stop offset=".5" stop-color="#d08a55" /><stop offset="1" stop-color="#7a4424" /></linearGradient>
          </defs>
          <rect width="320" height="240" fill="url(#dl-bg)" /><rect y="28" width="320" height="10" fill="#555f63" />
          <g v-for="(g, i) in geo" :key="i">
            <rect :x="g * 320 - 9" y="38" width="18" height="84" fill="url(#dl-cu)" />
            <circle :cx="g * 320" cy="112" r="5" fill="#9aa3a6" /><circle :cx="g * 320" cy="92" r="5" fill="#9aa3a6" />
            <rect :x="g * 320 - 13" y="122" width="26" height="26" rx="4" fill="#b5702f" /><rect :x="g * 320 - 12" y="148" width="24" height="92" fill="#15181a" />
            <rect :x="g * 320 - 12" y="156" width="24" height="7" :fill="PHASE[i]" />
          </g>
        </svg>
        <template v-if="boxLabels && showBoxes && !live && !offline && mode !== 'fusion'">
          <div v-for="(g, i) in geo" :key="i" class="vis-region" :style="{ left: g * 100 + '%' }">{{ boxLabel(i) }}</div>
        </template>
        <span v-if="mode !== 'fusion'" class="cap">可见光</span>
      </div>
      <div v-if="showThm" ref="thmPane" class="pane thm">
        <template v-if="live">
          <StreamVideo v-if="streams!.ir" ref="irV" :whep="streams!.ir.whep" :hls="streams!.ir.hls" />
          <div v-else class="nost">热像流未接入</div>
          <!-- EG：测温区按摄像机坐标画在热像画面上（画面按 contain 缩放，框跟着实际画面区域走），最热的标黄 -->
          <div v-if="showBoxes && rois?.length" class="roi-layer" :style="roiRect">
            <div v-for="r in rois" :key="r.label" class="roi" :class="{ hot: r.hot, point: r.point }" :style="{ left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' }">
              <span>{{ r.label }} {{ r.temp ?? '--' }}℃</span>
            </div>
          </div>
          <!-- 没有区域定义时，框温列成标签条 -->
          <div v-else-if="showBoxes" class="strip">
            <span v-for="(l, i) in labels" :key="l" :class="{ hot: i === hot % labels.length }">{{ boxText(i) }}</span>
          </div>
        </template>
        <template v-else>
          <canvas ref="cv" />
          <template v-if="showBoxes && !offline">
            <div v-for="(g, i) in geo" :key="i" class="box" :class="{ hot: i === hot % geo.length }" :style="{ left: g * 100 - 5.6 + '%' }"><span>{{ boxText(i) }}</span></div>
          </template>
        </template>
        <span v-if="spotTool && !offline" class="sp-hint">点温需 SAM 温度矩阵，待接入</span>
        <div v-if="big && !live" class="scale"><i :style="{ background: scale }" /><b>{{ tmax ?? '--' }}</b><b>{{ envT ?? '—' }}</b></div>
        <span class="tmax">MAX {{ tmax ?? '--' }}℃</span><span class="cap">{{ mode === 'fusion' ? '融合 · ' : '' }}{{ thermalCap }}</span>
      </div>
    </template>
    <div v-if="offline" class="nosig" style="inset:0">{{ offlineText ?? '网关离线 · 无实时画面' }}</div>
  </div>
</template>

<style scoped>
.dual { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.pane { position: relative; min-width: 0; aspect-ratio: 4/3; border-radius: 4px; overflow: hidden; background: #0a0f11; }
.pane canvas, .pane svg { width: 100%; height: 100%; display: block; }
.pane .cap { position: absolute; left: 6px; bottom: 5px; font-size: 11px; color: #fff; background: rgba(0,0,0,.5); padding: 0 6px; border-radius: 3px; }
.pane .tmax { position: absolute; right: 6px; top: 5px; font-size: 12px; font-weight: 600; color: #fff; background: rgba(0,0,0,.5); padding: 0 6px; border-radius: 3px; }
.nosig { position: absolute; display: grid; place-items: center; background: #0a0f11; color: var(--muted); z-index: 2; }
.vis-region { position: absolute; top: 58%; transform: translateX(-50%); padding: 2px 5px; border: 1px solid #fff; border-radius: 3px; color: #fff; background: rgba(0, 0, 0, .65); font-size: 12px; }
.m-visible, .m-thermal, .m-fusion, .snap { grid-template-columns: 1fr; }
.m-fusion { display: block; }
.fill { height: 100%; } .fill .pane { aspect-ratio: auto; height: 100%; min-height: 0; }
.fill.m-fusion .pane.vis { height: 100%; }
.m-fusion .pane.thm { position: absolute; inset: 0; background: none; aspect-ratio: auto; }
.m-fusion .pane.thm canvas, .m-fusion .pane.thm :deep(.sv) { opacity: 0.6; mix-blend-mode: screen; }
.m-fusion .pane.thm :deep(.sv) { background: none; }
.pane.img img { width: 100%; height: 100%; object-fit: contain; display: block; background: #0b0d0e; }
.box { position: absolute; top: 47.5%; width: 11.2%; height: 15.8%; border: 1.5px solid #fff; border-radius: 2px; }
.box.hot { border-color: #ffe08a; box-shadow: 0 0 0 1px rgba(0, 0, 0, .5); }
.box span { position: absolute; left: 50%; top: -17px; transform: translateX(-50%); font-size: 10.5px; color: #fff; background: rgba(0, 0, 0, .55); padding: 0 4px; border-radius: 2px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.roi-layer { position: absolute; pointer-events: none; }
.roi { position: absolute; border: 1.5px solid #fff; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0, 0, 0, .45); }
.roi.point { border-radius: 50%; }
.roi.hot { border-color: #ffe08a; }
.roi span { position: absolute; left: 0; top: -17px; font-size: 10.5px; color: #fff; background: rgba(0, 0, 0, .6); padding: 0 4px; border-radius: 2px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.roi.hot span { color: #ffe08a; }
.strip { position: absolute; left: 6px; top: 5px; display: flex; gap: 4px; flex-wrap: wrap; max-width: calc(100% - 90px); }
.strip span { font-size: 10.5px; color: #fff; background: rgba(0, 0, 0, .55); padding: 0 4px; border-radius: 2px; white-space: nowrap; font-variant-numeric: tabular-nums; border: 1px solid transparent; }
.strip span.hot { border-color: #ffe08a; color: #ffe08a; }
.nost { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255, 255, 255, .6); font-size: 12px; }
.sp-hint { position: absolute; left: 6px; bottom: 24px; font-size: 11px; color: #fff; background: rgba(0, 0, 0, .6); padding: 1px 6px; border-radius: 2px; white-space: nowrap; }
.scale { position: absolute; right: 6px; top: 30px; bottom: 26px; width: 34px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; font-size: 10px; color: #fff; }
.scale i { position: absolute; right: 0; top: 14px; bottom: 14px; width: 7px; border-radius: 2px; border: 1px solid rgba(255, 255, 255, .5); }
.scale b { font-weight: 500; background: rgba(0, 0, 0, .5); padding: 0 3px; border-radius: 2px; margin-right: 10px; }
</style>
