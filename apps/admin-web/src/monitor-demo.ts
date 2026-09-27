/** 显式演示数据：只在开发预览模式中被使用，不作为生产接口失败后的回退。 */
const end = new Date().setMinutes(0, 0, 0)
function samples(base: number, swing: number, phase = 0): [number, number][] {
  const offset = Math.sin(144 / 19 + phase) * swing + Math.sin(144 * 2.3 + phase) * swing * .08
  return Array.from({ length: 145 }, (_, i) => [end - (144 - i) * 600_000,
    +(base + Math.sin(i / 19 + phase) * swing + Math.sin(i * 2.3 + phase) * swing * .08 - offset).toFixed(1)])
}
export const climateSeries = [
  { name: '测温区 R1', unit: '℃', color: 'var(--s3)', data: samples(62.2, 3) },
  { name: '测温区 R2', unit: '℃', color: 'var(--s4)', data: samples(78.6, 4, 1) },
  { name: '测温区 R3', unit: '℃', color: 'var(--s5)', data: samples(62.4, 2, 2) },
  { name: '环境温度', unit: '℃', color: 'var(--s2)', data: samples(26.5, 1) },
  { name: '相对湿度', unit: '%', color: 'var(--s1)', data: samples(56, 4, 2) },
]
export const pdSeries = [{ name: '局放幅值', unit: 'dBμV', color: 'var(--s1)', data: samples(6.2, 1) }]
// 临时展示通道，实际型号确定后再替换字段、单位和量程；不用于告警判断。
export const smokeSeries = [
  { name: 'PM1.0', unit: 'μg/m³', color: 'var(--s3)', data: samples(8, 1.2) },
  { name: 'PM2.5', unit: 'μg/m³', color: 'var(--s1)', data: samples(12, 1.8, .5) },
  { name: 'PM10', unit: 'μg/m³', color: 'var(--s4)', data: samples(18, 2.4, 1) },
]
export const arcPreview = {
  from: end - 86400_000, to: end, unit: 'a.u.',
  pulses: [
    { time: end - 19 * 3600_000, value: 18, duration: 6 },
    { time: end - 10 * 3600_000, value: 32, duration: 12 },
    { time: end - 3 * 3600_000, value: 24, duration: 8 },
  ],
}
export const countSeries = [{ name: '设备次数', unit: '次', color: 'var(--s2)', data: samples(2, 1).map(([t, v]) => [t, Math.round(v)] as [number, number]) }]
export const currentSeries = ['A', 'B', 'C'].map((p, i) => ({ name: p + '相电流', unit: 'A', color: ['var(--s4)', 'var(--s3)', 'var(--s6)'][i], data: samples(205 + i * 5, 23, i * .2) }))
export const demoEvents = [
  { id: 'demo-01', time: end - 18 * 60_000, level: '重要', type: '温升越限', detail: '测温区 R2 · 温升 52.1 K（演示事件）', state: '发生', color: 'var(--major)' },
  { id: 'demo-02', time: end - 93 * 60_000, level: '记录', type: '通信恢复', detail: '电力仪表通信恢复，采集继续', state: '恢复', color: 'var(--good)' },
  { id: 'demo-03', time: end - 96 * 60_000, level: '提示', type: '通信中断', detail: '电力仪表连续采集超时', state: '已恢复', color: 'var(--info)' },
]
