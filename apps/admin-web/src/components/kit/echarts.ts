/* ECharts 按需注册 + 全系统图表的公共样式。所有图表组件从这里取 echarts，保证只注册一次、风格一致 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import { AxisPointerComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from 'vue'

echarts.use([BarChart, LineChart, ScatterChart, AxisPointerComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TitleComponent, TooltipComponent, CanvasRenderer])

export { echarts }
export const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

/** 图上的时间一律按北京时间（与子站一致，eg-ui-v2-1）：ECharts 时间轴缺省按浏览器时区，外地的电脑会差几个小时 */
const BJ = 'Asia/Shanghai'
const bjParts = (t: number): Record<string, string> => Object.fromEntries(
  new Intl.DateTimeFormat('zh-CN', { timeZone: BJ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map(p => [p.type, p.value]),
)
/** 刻度：北京时间零点显示日期，否则时:分（秒不为 0 时带秒） */
export function bjTick(t: number): string {
  const p = bjParts(t)
  if (p.hour === '00' && p.minute === '00' && p.second === '00') return `${p.month}-${p.day}`
  return p.second === '00' ? `${p.hour}:${p.minute}` : `${p.hour}:${p.minute}:${p.second}`
}
/** 提示框标题 / 指示线标签：月-日 时:分:秒（北京时间） */
export function bjFull(t: number): string {
  const p = bjParts(t)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

export function theme() {
  const muted = css('--muted'), axis = css('--axis'), grid = css('--grid')
  return {
    // 分类色板 8 色：趋势分析最多 8 条测点；≤4 条时只会用到前 4 个
    palette: ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(css),
    muted, axis, grid, text: css('--text'), text2: css('--text2'),
    tooltip: { confine: true, backgroundColor: css('--surface'), borderColor: css('--line2'), textStyle: { color: css('--text'), fontSize: 12 } },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, textStyle: { color: css('--text2'), fontSize: 11.5 } },
    xTime: {
      type: 'time' as const, axisLine: { lineStyle: { color: axis } }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { color: muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => bjTick(v) },
      // 轴触发的提示框标题（axisValueLabel）也按这里的格式出
      axisPointer: { label: { formatter: (p: { value: number | string }) => bjFull(Number(p.value)) } },
    },
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
