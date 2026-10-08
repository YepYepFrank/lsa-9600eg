<script setup lang="ts">
import { ref } from 'vue'
import { bjFull, css, theme, useChart } from './echarts'
import type { UnitSeries } from './MultiUnitTrend.vue'
const props = defineProps<{
  series?: UnitSeries[]
  pulses?: { time: number; value: number; duration: number }[]
  from?: number
  to?: number
}>()
const el = ref<HTMLDivElement>()
useChart(el, chart => {
  const th = theme()
  const pulses = props.pulses
  chart.setOption({
    animation: false,
    grid: { left: 34, right: 16, top: 6, bottom: 22 },
    tooltip: pulses ? {
      ...th.tooltip, trigger: 'item',
      formatter: (item: { dataIndex: number }) => {
        const p = pulses[item.dataIndex]
        return `${bjFull(p.time)}<br>相对强度 ${p.value} a.u.<br>持续时间 ${p.duration} ms`
      },
    } : { ...th.tooltip, trigger: 'axis' },
    xAxis: { ...th.xTime, min: props.from, max: props.to, splitNumber: 3 },
    yAxis: { ...th.yValue(), min: 0, splitNumber: 2 },
    series: pulses ? [{
      type: 'bar', name: '弧光脉冲', barWidth: 3,
      data: pulses.map(p => [p.time, p.value]), itemStyle: { color: css('--s4') },
    }] : (props.series ?? []).map(s => ({
      type: 'line', name: s.name, data: s.data, showSymbol: false,
      lineStyle: { width: 1.5 }, itemStyle: { color: s.color?.startsWith('var(') ? css(s.color.slice(4, -1)) : s.color },
      tooltip: { valueFormatter: (v: unknown) => `${v} ${s.unit}` },
    })),
  }, true)
}, () => [props.series, props.pulses, props.from, props.to])
</script>
<template><div ref="el" class="chart sensor-preview-trend" /></template>
<style scoped>
.sensor-preview-trend{height:90px;min-height:48px;flex:1}
</style>
