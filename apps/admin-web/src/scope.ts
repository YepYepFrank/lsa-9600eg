/* 0.18.0 舱室 EG（方案 v0.5 §3.2）：一面柜按电气舱室分几台 EG。本 EG 是舱室单元时界面说「本舱室」、标题带舱室名；
 * 照旧一柜一台的（eg.yaml schema 1）unit.at 为空，界面与以前一样说「本柜」。 */
import { computed } from 'vue'
import { store } from './store'

/** 「本舱室」或「本柜」 */
export const here = computed(() => (store.status?.unit?.at ? '本舱室' : '本柜'))

/** 本 EG 的身份（视频路径等用）：单元号；agent 没报 unit 时（不会出现，兜底）用柜号 */
export const unitCode = computed(() => store.status?.unit?.code ?? store.status?.cabinet.code)
