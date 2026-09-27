<!-- 日志：各组件最近的日志（容器日志 + eg-agent 自己的），可筛选、自动刷新、下载。维护角色可看 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api, session } from '../session'

const COMPS = [
  ['agent', 'eg-agent'],
  ['gateway', 'TB IoT Gateway'],
  ['edge', 'TB Edge'],
  ['mosquitto', 'Mosquitto'],
] as const
const key = ref<(typeof COMPS)[number][0]>('agent')
const tail = ref(300)
const q = ref('')
const auto = ref(true)
const lines = ref<string[]>([])
const err = ref('')
const loading = ref(false)
const canMaint = computed(() => session.me?.role === 'maint')

async function load() {
  if (!canMaint.value) return
  loading.value = true
  try {
    lines.value = (await api<{ lines: string[] }>(`logs/${key.value}?tail=${tail.value}`)).lines
    err.value = ''
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
watch([key, tail], load, { immediate: true })
const timer = window.setInterval(() => auto.value && !document.hidden && load(), 5000)
onBeforeUnmount(() => clearInterval(timer))

const shown = computed(() => {
  const f = q.value.trim().toLowerCase()
  return (f ? lines.value.filter(l => l.toLowerCase().includes(f)) : lines.value).slice().reverse()
})
const level = (l: string) => (/ERROR|错误|Exception|FATAL/i.test(l) ? 'crit' : /WARN|警告/i.test(l) ? 'minor' : '')

function download() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([lines.value.join('\n')], { type: 'text/plain;charset=utf-8' }))
  a.download = `${key.value}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`
  a.click()
}
</script>

<template>
  <div class="logs">
    <div class="page-h">
      <h1>日志</h1>
      <el-radio-group v-model="key" size="small">
        <el-radio-button v-for="[k, l] in COMPS" :key="k" :value="k">{{ l }}</el-radio-button>
      </el-radio-group>
      <el-select v-model="tail" size="small" style="width: 110px">
        <el-option v-for="n in [100, 300, 1000, 2000]" :key="n" :label="`最近 ${n} 行`" :value="n" />
      </el-select>
      <el-input v-model="q" size="small" placeholder="筛选关键字" clearable style="width: 180px" />
      <el-switch v-model="auto" size="small" active-text="每 5 秒刷新" />
      <span class="sp" />
      <el-button size="small" :disabled="!lines.length" @click="download">下载</el-button>
    </div>
    <div v-if="!canMaint" class="panel empty" style="margin-top: 0">只读账号不能看日志（要子站「网关维护」权限或本地维护账号）</div>
    <div v-else class="panel box" style="margin-top: 0">
      <div v-if="err" class="empty crit">{{ err }}</div>
      <div v-for="(l, i) in shown" :key="i" class="ln mono" :class="level(l)">{{ l }}</div>
      <div v-if="!err && !shown.length" class="empty">{{ loading ? '加载中…' : '没有日志' }}</div>
    </div>
    <p class="note">最新的在上。eg-agent 的日志只留最近 1000 行在内存里；各容器的完整日志在 EG 上用 <code>docker logs</code> 看。</p>
  </div>
</template>

<style scoped>
.logs { display: flex; flex-direction: column; height: 100%; }
.box { flex: 1; overflow: auto; padding: 8px 12px; }
.ln { white-space: pre-wrap; word-break: break-all; line-height: 1.55; padding: 1px 0; border-bottom: 1px dashed transparent; }
.ln.crit { color: var(--crit); }
.ln.minor { color: var(--minor); }
</style>
