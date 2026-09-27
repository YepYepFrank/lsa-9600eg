/* ECharts 按需注册 + 全系统图表的公共样式。所有图表组件从这里取 echarts，保证只注册一次、风格一致 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import { AxisPointerComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from 'vue'

echarts.use([BarChart, LineChart, ScatterChart, AxisPointerComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TitleComponent, TooltipComponent, CanvasRenderer])

export { echarts }
export const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

export function theme() {
  const muted = css('--muted'), axis = css('--axis'), grid = css('--grid')
  return {
    // 分类色板 8 色：趋势分析最多 8 条测点；≤4 条时只会用到前 4 个
    palette: ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(css),
    muted, axis, grid, text: css('--text'), text2: css('--text2'),
    tooltip: { confine: true, backgroundColor: css('--surface'), borderColor: css('--line2'), textStyle: { color: css('--text'), fontSize: 12 } },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, textStyle: { color: css('--text2'), fontSize: 11.5 } },
    xTime: { type: 'time' as const, axisLine: { lineStyle: { color: axis } }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 11, hideOverlap: true }, splitLine: { show: false } },
    yValue: (name?: string) => ({
      type: 'value' as const, name, nameGap: 8, nameTextStyle: { color: muted, fontSize: 11, align: 'right' as const }, scale: true,
      axisLabel: { color: muted, fontSize: 11 }, splitLine: { lineStyle: { color: grid } },
    }),
  }
}

/** 统一的生命周期：挂载初始化、随容器缩放、主题切换重绘、卸载释放 */
export function useChart(el: Ref<HTMLElement | undefined>, render: (c: echarts.ECharts) => void, deps: () => unknown[]) {
  const chart = shallowRef<echarts.ECharts>()
  let ro: ResizeObserver | undefined
  const draw = () => chart.value && render(chart.value)
  onMounted(() => {
    chart.value = echarts.init(el.value!)
    draw()
    ro = new ResizeObserver(() => chart.value?.resize())
    ro.observe(el.value!)
  })
  onBeforeUnmount(() => { ro?.disconnect(); chart.value?.dispose() })
  watch(deps, draw)
  return chart
}
