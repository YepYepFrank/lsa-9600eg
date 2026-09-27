<script setup lang="ts">
import { ref } from 'vue'
type Sample = [number, number | null]
import { theme, useChart, css } from './echarts'
export interface UnitSeries { name: string; unit: string; color?: string; data: Sample[] }
const props = withDefaults(defineProps<{ series: UnitSeries[]; units?: string[]; height?: number; compact?: boolean; hideLegend?: boolean; hideThresholdLabels?: boolean; centerUnitNames?: boolean; axisColors?: Record<string, string>; selected?: Record<string, boolean>; scales?: Record<string, { min: number; max: number; interval: number }>; thresholds?: { v: number; label: string; unit: string }[] }>(), { height: 300, thresholds: () => [] })
const el = ref<HTMLDivElement>()
useChart(el, chart => {
  const th = theme(), units = props.units ?? [...new Set(props.series.map(s => s.unit))]
  const unitColor = (unit: string) => { const color = props.axisColors?.[unit]; return color?.startsWith('var(') ? css(color.slice(4, -1)) : color }
  const nameAlignment = (unit: string, i: number) => {
    if (!props.centerUnitNames) return {}
    const context = document.createElement('canvas').getContext('2d')!
    context.font = '11px sans-serif'
    const scale = props.scales?.[unit]
    const labels = [scale?.min ?? 0, scale?.max ?? 100].map(v => v.toLocaleString('en-US'))
    const offset = 8 + Math.max(...labels.map(v => context.measureText(v).width)) / 2
    // Center the unit over the tick-label column (8px default label margin).
    return { align: 'center' as const, padding: i ? [0, 0, 0, offset * 2] : [0, offset * 2, 0, 0] }
  }
  const selected = (chart.getOption()?.legend as { selected?: Record<string, boolean> }[] | undefined)?.[0]?.selected
  chart.setOption({
    animation: false, color: th.palette,
    legend: { ...th.legend, type: 'scroll', show: !props.hideLegend, selected: props.selected ?? selected, data: props.series.map(s => s.name) },
    grid: { top: props.compact ? 22 : props.hideLegend ? 40 : 58, left: 58, right: 62, bottom: props.compact ? 24 : props.hideLegend ? 40 : 30 },
    tooltip: { ...th.tooltip, trigger: 'axis' },
    xAxis: th.xTime,
    yAxis: units.map((unit, i) => ({ ...th.yValue(unit), axisLabel: { ...th.yValue(unit).axisLabel, color: unitColor(unit) ?? th.muted }, nameTextStyle: { ...th.yValue(unit).nameTextStyle, ...nameAlignment(unit, i), color: unitColor(unit) ?? th.muted }, axisLine: { lineStyle: { color: unitColor(unit) ?? th.muted } }, axisTick: { lineStyle: { color: unitColor(unit) ?? th.muted } }, position: i ? 'right' : 'left', min: props.scales?.[unit]?.min ?? 0, max: props.scales?.[unit]?.max ?? (unit === '%' ? 100 : undefined), interval: props.scales?.[unit]?.interval, splitLine: { show: i === 0, lineStyle: { color: th.grid } } })),
    series: props.series.map((s, i) => ({
      name: s.name, type: 'line', data: s.data, yAxisIndex: units.indexOf(s.unit), showSymbol: false, connectNulls: false,
      itemStyle: { color: s.color ? (s.color.startsWith('var(') ? css(s.color.slice(4, -1)) : s.color) : th.palette[i % th.palette.length] }, lineStyle: { width: 2 },
      tooltip: { valueFormatter: (v: unknown) => (v == null ? '--' : String(v)) + ' ' + s.unit },
      markLine: props.series.findIndex(x => x.unit === s.unit) === i ? { silent: true, symbol: 'none',
        data: props.thresholds.filter(t => t.unit === s.unit).map(t => ({ yAxis: t.v, lineStyle: { color: unitColor(t.unit) ?? css('--major'), type: 'dashed' }, label: { show: !props.hideThresholdLabels, formatter: t.label, position: 'insideEndTop', color: th.muted } })) } : undefined,
    })),
  }, true)
}, () => [props.series, props.units, props.thresholds, props.scales, props.selected, props.hideLegend, props.compact, props.axisColors, props.hideThresholdLabels, props.centerUnitNames])
</script>
<template><div ref="el" class="chart multi-unit-trend" :style="{ height: height + 'px' }" /></template>
