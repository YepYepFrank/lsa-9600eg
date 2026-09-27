<script setup lang="ts">
import { computed, useId } from 'vue'
const props = defineProps<{ compact?: boolean; temperature?: number | null; humidity?: number | null; min: number; max: number; humidityColor?: string }>()
const id = useId().replace(/:/g, '')
const valid = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)
const angle = (v: number, min: number, max: number) => -135 + Math.max(0, Math.min(1, (v - min) / (max - min))) * 270
const point = (a: number, r: number) => ({ x: 140 + Math.sin(a * Math.PI / 180) * r, y: 132 - Math.cos(a * Math.PI / 180) * r })
const ticks = (min: number, max: number, n: number) => Array.from({ length: n + 1 }, (_, i) => ({ angle: -135 + i / n * 270, value: +(min + (max - min) * i / n).toFixed(0) }))
const tempTicks = computed(() => ticks(props.min, props.max, 8))
const rhTicks = ticks(0, 100, 5)
</script>
<template>
  <div class="climate-dial" :class="{ compact }" role="img" :aria-label="'环境温度 ' + (temperature ?? '--') + '℃，相对湿度 ' + (humidity ?? '--') + '%'">
    <svg viewBox="0 0 280 280">
      <defs><radialGradient :id="id + '-face'"><stop offset="0" stop-color="var(--surface2)"/><stop offset="1" stop-color="var(--surface)"/></radialGradient></defs>
      <circle cx="140" cy="132" r="123" fill="none" stroke="var(--line)" stroke-width="2"/>
      <circle cx="140" cy="132" r="117" :fill="'url(#' + id + '-face)'" stroke="var(--line2)" stroke-width="3"/>
      <circle cx="140" cy="132" r="109" fill="none" stroke="var(--s2)" stroke-opacity=".18"/>
      <circle cx="140" cy="132" r="77" fill="none" :stroke="humidityColor || 'var(--s1)'" stroke-opacity=".22"/>
      <g v-for="(tick, i) in tempTicks" :key="'t' + i" class="temperature">
        <line :x1="point(tick.angle, 102).x" :y1="point(tick.angle, 102).y" :x2="point(tick.angle, 109).x" :y2="point(tick.angle, 109).y" stroke="currentColor" stroke-width="2"/>
        <text :x="point(tick.angle, 91).x" :y="point(tick.angle, 91).y">{{ tick.value }}</text>
      </g>
      <g v-for="(tick, i) in rhTicks" :key="'h' + i" class="humidity" :style="{ color: humidityColor }">
        <line :x1="point(tick.angle, 71).x" :y1="point(tick.angle, 71).y" :x2="point(tick.angle, 77).x" :y2="point(tick.angle, 77).y" stroke="currentColor"/>
        <text :x="point(tick.angle, 60).x" :y="point(tick.angle, 60).y">{{ tick.value }}</text>
      </g>
      <text x="140" y="105" class="dial-name">温湿度</text>
      <g v-if="valid(temperature)" class="needle temperature" :style="{ transform: 'rotate(' + angle(temperature, min, max) + 'deg)' }"><path d="M136 145 L138 53 L140 39 L142 53 L144 145 Z" fill="currentColor"/></g>
      <g v-if="valid(humidity)" class="needle humidity" :style="{ transform: 'rotate(' + angle(humidity, 0, 100) + 'deg)', color: humidityColor }"><path d="M137 143 L139 78 L140 67 L141 78 L143 143 Z" fill="currentColor"/></g>
      <circle cx="140" cy="132" r="7" fill="var(--surface2)" stroke="var(--text2)" stroke-width="2"/>
      <text x="140" y="197" class="humidity scale-label" :style="{ color: humidityColor }">内圈 %RH</text><text x="140" y="232" class="temperature scale-label">外圈 ℃</text>
    </svg>
    <div class="readings"><div class="temperature"><span>环境温度</span><b>{{ valid(temperature) ? temperature.toFixed(1) : '--' }}<small>℃</small></b></div><div class="humidity" :style="{ color: humidityColor }"><span>相对湿度</span><b>{{ valid(humidity) ? humidity.toFixed(0) : '--' }}<small>%</small></b></div></div>
  </div>
</template>
<style scoped>
.climate-dial { width: 100%; max-width: 280px; justify-self: center; }
svg { display: block; width: 100%; }
text { fill: currentColor; font-size: 10px; text-anchor: middle; dominant-baseline: middle; font-variant-numeric: tabular-nums; }
.temperature { color: var(--s2); }.humidity { color: var(--s1); }
.dial-name { fill: var(--muted); font-size: 12px; letter-spacing: 2px; }.scale-label { font-size: 10px; }
.needle { transform-origin: 140px 132px; transition: transform .8s ease; filter: drop-shadow(0 0 3px currentColor); }
.readings { display: flex; justify-content: space-around; gap: 12px; margin-top: -14px; }
.readings > div { display: flex; flex-direction: column; gap: 4px; align-items: center; }
.readings span { font-size: 11px; }.readings b { font-size: 20px; font-variant-numeric: tabular-nums; }.readings small { font-size: 11px; font-weight: 400; margin-left: 3px; }
.compact { display: flex; align-items: center; max-width: none; gap: 4px; }
.compact svg { width: var(--dial-size, 120px); height: var(--dial-size, 120px); flex: none; }
.compact .readings { flex-direction: column; margin: 0; gap: 10px; }
.compact .readings b { font-size: 16px; }
.compact .readings span { font-size: 10px; }
@media (prefers-reduced-motion: reduce) { .needle { transition: none; } }
</style>
