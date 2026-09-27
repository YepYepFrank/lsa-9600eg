<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import DualLightPlayer, { type Palette } from './kit/DualLightPlayer.vue'
import ThermoHygroDial from './kit/ThermoHygroDial.vue'
import MultiUnitTrend from './kit/MultiUnitTrend.vue'
import SensorPreviewTrend from './kit/SensorPreviewTrend.vue'
import { arcPreview, smokeSeries, climateSeries, countSeries, currentSeries, demoEvents, pdSeries } from '../monitor-demo'
const dischargeSeries = [...pdSeries, ...countSeries]
const dischargeScales = { '次': { min: 0, max: Math.max(4, ...countSeries.flatMap(s => s.data.map(p => p[1]))), interval: 1 } }
const props = defineProps<{ demo: boolean; tab: 'overview' | 'electric' | 'events' }>()
const emit = defineEmits<{ navigate: [tab: 'overview' | 'electric' | 'events' | 'manage'] }>()
const palette = ref<Palette>('iron')
const boxes = ref(true)
const camera = ref<HTMLElement>()
const selected = ref<Record<string, boolean>>({})
const eventFilter = ref('全部')
const events = computed(() => props.demo ? demoEvents.filter(e => eventFilter.value === '全部' || e.type.includes(eventFilter.value)) : [])
const dew = (t: number, rh: number) => { const a = Math.log(rh / 100) + 17.62 * t / (243.12 + t); return (243.12 * a / (17.62 - a)).toFixed(1) }
const time = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false })
async function fullscreen() {
  try { await camera.value?.requestFullscreen() } catch { ElMessage.warning('当前浏览器无法进入全屏') }
}
const electric = [
  { label: '线电压', unit: 'V', items: [['Uab', '398.2'], ['Ubc', '399.6'], ['Uca', '398.8']] },
  { label: '三相电流', unit: 'A', items: [['Ia', '216.4'], ['Ib', '210.8'], ['Ic', '213.6']] },
  { label: '功率', unit: '', items: [['有功', '142.6 kW'], ['无功', '28.4 kvar'], ['视在', '145.4 kVA']] },
  { label: '其他测量', unit: '', items: [['功率因数', '0.981'], ['频率', '50.00 Hz'], ['正向有功电能', '125680.4 kWh']] },
]
</script>

<template>
  <div class="cab-monitor" :class="{ 'overview-page': tab === 'overview' }">
    <div v-if="demo" class="cab-warning"><span class="warning-tag">演示事件</span>温升越限 · 测温区 R2 78.6℃，温升 52.1 K <button @click="emit('navigate', 'events')">查看事件 ›</button></div>

    <div v-if="tab === 'overview'" class="monitor-grid">
      <section class="monitor-card camera-card">
        <div class="monitor-card-heading"><b>双光摄像头</b><span class="grow"/><select v-model="palette" aria-label="热像调色板" :disabled="!demo"><option value="iron">铁红</option><option value="white">白热</option><option value="rainbow">彩虹</option></select><label><input v-model="boxes" type="checkbox" :disabled="!demo" />测温标注</label><button @click="fullscreen">全屏</button></div>
        <div ref="camera" class="camera-frame"><DualLightPlayer fill big mode="side" :palette="palette" :boxes="demo && boxes ? [62.2, 78.6, 62.4] : false" :box-labels="['R1', 'R2', 'R3']" :tmax="demo ? 78.6 : null" :env-t="demo ? 26.5 : null" :offline="!demo" offline-text="尚未接入双光视频" /></div>
        <div class="camera-summary"><div>最高温 <b>{{ demo ? '78.6' : '—' }}</b><small>℃</small></div><div>温升 <b>{{ demo ? '52.1' : '—' }}</b><small>K</small></div></div>
      </section>
      <div class="sensor-stack">
      <section class="monitor-card pd-card">
        <div class="monitor-card-heading"><b>超声局放</b><span class="grow"/><span class="muted">近 24h</span></div>
        <div class="sensor-values"><div><span>局放幅值</span><b>{{ demo ? '6.2' : '—' }} <small>dBμV</small></b></div><div><span>设备次数</span><b>{{ demo ? '2' : '—' }} <small>次</small></b></div></div>
        <template v-if="demo"><MultiUnitTrend :series="dischargeSeries" :units="['dBμV', '次']" :height="125" compact hide-legend center-unit-names :scales="dischargeScales" :axis-colors="{ 'dBμV': 'var(--s1)', '次': 'var(--s2)' }" /></template>
        <div v-else class="monitor-empty">尚未接入局放监测数据</div>
      </section>
      <section class="monitor-card smoke-card">
        <div class="monitor-card-heading"><b>烟雾 / 气体监测</b><span class="grow"/><span class="pending" title="颗粒物通道用于演示，待实际传感器选型后调整">{{ demo ? '模拟 · μg/m³' : '选型待定' }}</span></div>
        <template v-if="demo">
          <div class="preview-readings smoke-readings"><div v-for="s in smokeSeries" :key="s.name"><span><i :style="{ background: s.color }"/>{{ s.name }}</span><b>{{ s.data[s.data.length - 1][1] }}</b></div></div>
          <SensorPreviewTrend :series="smokeSeries" />
        </template>
        <div v-else class="monitor-empty"><span class="empty-symbol">◌</span><strong>传感器待确认</strong><span>确定型号与接口后接入</span></div>
      </section>
      </div>
      <section class="monitor-card climate-card">
        <div class="monitor-card-heading"><b>柜内温湿度</b><div v-if="demo" class="climate-legend"><button v-for="s in climateSeries" :key="s.name" :aria-pressed="selected[s.name] !== false" :class="{ inactive: selected[s.name] === false }" @click="selected = { ...selected, [s.name]: selected[s.name] === false }"><i :style="{ background: s.color }"/>{{ s.name }}</button></div></div>
        <div class="climate-layout"><div class="dial-column"><ThermoHygroDial compact :temperature="demo ? 26.5 : null" :humidity="demo ? 56 : null" :min="0" :max="100" /><div class="dew-reading">计算露点 <b>{{ demo ? dew(26.5, 56) : '—' }}<small> ℃</small></b><el-tooltip content="计算露点由柜内空气温度和相对湿度计算得到。壳体表面温度低于此温度时，有凝露风险。" placement="bottom" :popper-style="{ maxWidth: '320px', lineHeight: '1.6' }"><button aria-label="计算露点说明">?</button></el-tooltip></div></div><MultiUnitTrend v-if="demo" :series="climateSeries" :height="215" compact hide-legend center-unit-names :selected="selected" :scales="{ '℃': { min: 0, max: 100, interval: 20 }, '%': { min: 0, max: 100, interval: 20 } }" :axis-colors="{ '℃': 'var(--s2)', '%': 'var(--s1)' }" /><div v-else class="monitor-empty">等待温湿度数据</div></div>
      </section>
      <section class="monitor-card arc-card">
        <div class="monitor-card-heading"><b>UV 弧光监测</b><span class="grow"/><span class="pending" title="相对强度使用任意单位 a.u.，待实际产品确定后调整">{{ demo ? '模拟 · 近 24h' : '接口待确认' }}</span></div>
        <template v-if="demo">
          <div class="preview-readings arc-readings"><div><span>峰值强度</span><b>{{ Math.max(...arcPreview.pulses.map(p => p.value)) }}<small> a.u.</small></b></div><div><span>脉冲次数</span><b>{{ arcPreview.pulses.length }}<small> 次</small></b></div></div>
          <SensorPreviewTrend :pulses="arcPreview.pulses" :from="arcPreview.from" :to="arcPreview.to" />
        </template>
        <div v-else class="arc-placeholder"><b>—</b><span>量值与单位待协议确认</span></div>
      </section>
    </div>

    <template v-else-if="tab === 'electric'">
      <div class="electric-grid"><section v-for="group in electric" :key="group.label" class="monitor-card"><div class="monitor-card-heading"><b>{{ group.label }}</b><span class="grow"/><span class="muted">{{ group.unit }}</span></div><div v-for="item in group.items" :key="item[0]" class="electric-row"><span>{{ item[0] }}</span><b>{{ demo ? item[1] : '—' }}</b></div></section></div>
      <section class="monitor-card electric-chart"><div class="monitor-card-heading"><b>三相电流趋势</b><span class="grow"/><span class="muted">近 24h{{ demo ? ' · 模拟数据' : '' }}</span></div><MultiUnitTrend v-if="demo" :series="currentSeries" :height="320" /><div v-else class="monitor-empty">尚未接入电表监测数据</div></section>
    </template>

    <template v-else>
      <section class="monitor-card"><div class="monitor-card-heading"><b>本地事件记录</b><span class="grow"/><select v-model="eventFilter" aria-label="事件类型"><option>全部</option><option>温升</option><option>通信</option></select></div><div class="table-scroll"><table class="event-table"><thead><tr><th>时间</th><th>级别</th><th>事件</th><th>描述</th><th>状态</th><th>关联录像</th></tr></thead><tbody><tr v-for="e in events" :key="e.id"><td>{{ time(e.time) }}</td><td :style="{ color: e.color }">{{ e.level }}</td><td>{{ e.type }}</td><td>{{ e.detail }}</td><td>{{ e.state }}</td><td class="muted">演示事件 · 无录像文件</td></tr><tr v-if="!events.length"><td colspan="6" class="monitor-empty">{{ demo ? '没有匹配的事件' : '尚未接入本地事件接口' }}</td></tr></tbody></table></div></section>
      <section class="monitor-card recording-card"><div class="monitor-card-heading"><b>双光录像</b><span class="grow"/><span class="pending">待接入</span></div><div class="monitor-empty"><span class="empty-symbol">▷</span><strong>尚未连接本地录像服务</strong><span>接入后可按时间回看，并从事件定位前后录像片段。</span></div></section>
    </template>
  </div>
</template>

<style scoped>
.smoke-card{display:flex;flex-direction:column;min-height:0}
.smoke-card>.monitor-card-heading,.arc-card>.monitor-card-heading{flex:none}
.preview-readings{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 14px 4px;flex:none}
.preview-readings>div{display:flex;align-items:baseline;gap:6px;white-space:nowrap}
.preview-readings span{font-size:10px;color:var(--muted)}
.preview-readings b{font-size:17px;font-variant-numeric:tabular-nums}
.preview-readings small{font-size:10px;font-weight:400;color:var(--text2)}
.preview-readings i{display:inline-block;width:6px;height:2px;vertical-align:middle;margin-right:4px}
.arc-readings{justify-content:flex-start;gap:20px}
.sensor-stack{display:grid;grid-template-rows:auto minmax(0,1fr);gap:12px;min-width:0}.arc-card{display:flex;flex-direction:column}.arc-card>.monitor-card-heading{flex:none}.arc-placeholder{flex:1}
.cab-monitor{font-size:13px}.pd-card{align-self:start;padding-bottom:12px}button,select{font:inherit;color:var(--text2);background:var(--surface2);border:1px solid var(--line2);border-radius:4px;padding:4px 9px;cursor:pointer}button:hover{color:var(--brand-ink);border-color:var(--brand)}button:focus-visible,select:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.cab-warning{margin-bottom:12px;display:flex;align-items:center;gap:10px;background:rgba(var(--major-rgb),.10);border:1px solid rgba(var(--major-rgb),.35);padding:7px 10px;border-radius:4px;font-size:12px}.warning-tag{background:var(--major);color:#171d20;padding:1px 5px;border-radius:3px}.cab-warning button{margin-left:auto;background:none;border:0;color:var(--brand-ink)}.monitor-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(300px,2fr);gap:12px}.monitor-card{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;overflow:hidden}.monitor-card-heading{display:flex;align-items:center;gap:10px;padding:12px;min-height:22px;font-size:12px}.monitor-card-heading label{display:flex;align-items:center;gap:4px;color:var(--s1);font-size:11px}.monitor-card-heading select,.monitor-card-heading button{font-size:11px}.grow{flex:1}.camera-frame{margin:0 12px;height:305px;min-width:0}.camera-frame:fullscreen{height:100vh;margin:0;background:#080b0d;padding:20px;box-sizing:border-box}.camera-summary{display:flex;justify-content:flex-end;align-items:center;gap:20px;padding:12px;color:var(--muted);font-size:12px}.camera-summary b{font-size:22px;color:var(--major);margin-left:8px}.camera-summary small{margin-left:4px}.sensor-values{display:flex;align-items:baseline;gap:18px;margin:2px 20px 14px}.sensor-values>div{display:flex;align-items:baseline;gap:6px;white-space:nowrap}.sensor-values span{color:var(--muted);font-size:11px}.sensor-values b{font-size:22px}.sensor-values small{font-size:11px;font-weight:400;color:var(--text2)}.climate-card>.monitor-card-heading{justify-content:flex-end}.climate-legend{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.climate-legend button{display:flex;align-items:center;gap:4px;border:0;background:none;padding:0;font-size:10px}.climate-legend .inactive{opacity:.35}.climate-legend i{width:9px;height:2px}.climate-layout{display:grid;grid-template-columns:minmax(220px,28%) minmax(0,1fr);align-items:center;padding:0 6px 10px}.dial-column{min-width:0}.dial-column :deep(.climate-dial){justify-content:center;--dial-size:155px}.dew-reading{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:4px;font-size:11px;color:var(--muted)}.dew-reading b{color:var(--text);font-size:15px}.dew-reading small{font-weight:400;font-size:11px}.dew-reading button{width:17px;height:17px;padding:0;border-radius:50%;background:none;font-size:10px}.pending{font-size:10px;color:var(--muted);border:1px solid var(--line2);border-radius:3px;padding:2px 5px}.monitor-empty{display:flex;min-height:160px;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--muted);font-size:12px;text-align:center;padding:12px}.monitor-empty strong{font-weight:400;color:var(--text2)}.empty-symbol{font-size:36px;opacity:.55}.event-list{padding:0 12px 8px}.event-row{display:flex;align-items:center;gap:10px;border-top:1px solid var(--line);padding:10px 0;font-size:11px}.event-row time{color:var(--muted);font-variant-numeric:tabular-nums}.event-level{white-space:nowrap}.event-detail{flex:1}.event-state{color:var(--muted);white-space:nowrap}.text-link{border:0;background:none;color:var(--brand-ink)}.arc-placeholder{display:flex;gap:12px;align-items:center;padding:26px 18px;color:var(--muted);font-size:12px}.arc-placeholder b{font-size:30px}.electric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.electric-row{display:flex;justify-content:space-between;gap:10px;margin:0 14px;padding:16px 0;border-top:1px solid var(--line);color:var(--text2);font-size:12px}.electric-row b{color:var(--text);font-size:17px;font-variant-numeric:tabular-nums}.electric-chart,.recording-card{margin-top:12px}.table-scroll{overflow:auto}.event-table{width:100%;border-collapse:collapse;font-size:12px;text-align:left;white-space:nowrap}.event-table th,.event-table td{padding:15px 14px;border-top:1px solid var(--line)}.event-table th{color:var(--muted);font-weight:400}.event-table td.monitor-empty{display:table-cell}.recording-card .monitor-empty{min-height:230px}
@media(min-width:1600px){.camera-frame{height:355px}.sensor-values{margin:16px 20px 28px}.pd-card :deep(.multi-unit-trend){margin-top:10px}.climate-layout{padding-bottom:16px}}
@media(max-width:1150px){.monitor-grid{grid-template-columns:minmax(0,1fr) 300px}.climate-layout{grid-template-columns:1fr}.dial-column{display:flex;align-items:center;justify-content:center}.dial-column :deep(.climate-dial){width:auto;--dial-size:120px}.dew-reading{margin-left:16px}.climate-legend{gap:5px}.electric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.camera-frame{height:270px}.camera-summary{gap:10px}}
@media(max-width:850px){.monitor-grid{grid-template-columns:1fr}.camera-frame{height:300px}.cab-warning{flex-wrap:wrap}.climate-layout{grid-template-columns:1fr}.electric-grid{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.camera-frame{height:200px}.electric-grid{grid-template-columns:1fr}.dial-column{flex-direction:column}}
/* 桌面总览使用可用高度分配两行，不通过隐藏溢出裁掉监测内容。 */
@media(min-width:1151px) and (min-height:700px){
  .overview-page{height:100%;display:flex;flex-direction:column;min-height:0}
  .overview-page>.cab-warning{flex:none}
  .overview-page>.monitor-grid{flex:1;min-height:0;grid-template-rows:minmax(0,1fr) clamp(174px,24.5vh,230px)}
  .camera-card,.climate-card,.smoke-card{display:flex;flex-direction:column;min-height:0}
  .monitor-card-heading,.camera-summary{flex:none}
  .camera-frame:not(:fullscreen){flex:1;min-height:120px;height:auto}
  .climate-card>.monitor-card-heading{padding-top:6px;padding-bottom:6px}
  .climate-layout{flex:1;min-height:0;padding-bottom:4px}
  .climate-layout>.multi-unit-trend{height:100% !important;min-height:0}
  .dial-column{margin-top:-18px}
  .dial-column :deep(.climate-dial){--dial-size:clamp(126px,18.5vh,182px);gap:10px}
  .dial-column :deep(.readings>div){align-items:flex-start}
  .dial-column .dew-reading{margin-top:0;transform:translateX(-20px)}
  .smoke-card>.monitor-empty{flex:1;min-height:0;gap:6px;padding:6px 12px}
  .smoke-card .empty-symbol{font-size:26px}
  .sensor-values{margin:2px 20px 14px}
  .pd-card :deep(.multi-unit-trend){margin-top:0}
}
</style>
