<!-- 下挂设备：清单与属性（子站下发）、该发到哪个主题（给同事对照）、南向统计、质量码。只读 —— 设备清单在子站改 -->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { refreshConfig, store } from '../store'
import { dt, QTEXT } from '../utils/fmt'
import { KIND, type Dev } from '../types'

const router = useRouter()
onMounted(() => void refreshConfig())

const rows = computed(() => {
  const cfg = store.config?.eg
  const st = store.status
  if (!cfg || !st) return []
  const byName = new Map<string, Dev>(st.devices.map(d => [d.name, d]))
  return cfg.devices.map(c => ({ conf: c, dev: byName.get(c.name) ?? null }))
})

/** 属性里给人看的几项（其余在展开里） */
const MAIN_ATTRS = ['room', 'port', 'proto', 'rated', 'fw']
const ATTR_LABEL: Record<string, string> = { room: '隔室', port: '端口', proto: '协议', rated: '额定电流', fw: '固件', cab: '柜号', voltage: '电压等级', channels: '路数', 'ir.boxes': '分框' }
const attrText = (k: string, v: unknown) => (k === 'rated' ? `${v} A` : k === 'ir.boxes' ? boxes(v) : String(v))
function boxes(v: unknown): string {
  try {
    const a = JSON.parse(String(v)) as { id: string; label: string }[]
    return a.map(b => `${b.id} ${b.label}`).join('；')
  } catch {
    return String(v)
  }
}
function qSummary(q: Record<string, string>): string {
  const e = Object.entries(q)
  if (!e.length) return '全部有效'
  return e.map(([k, v]) => `${k} ${QTEXT[v]?.[0] ?? v}`).join('、')
}
function copy(t: string) {
  void navigator.clipboard?.writeText(t)
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>下挂设备</h1>
      <span class="t2">设备清单、设备名、额定电流由子站下发（eg.yaml，生成于 {{ dt(Date.parse(store.config?.eg.generatedAt ?? '')) }}）；要增删设备回子站改。数据怎么发见《EG 内部 MQTT 格式》。</span>
    </div>
    <div class="grid g2">
      <div v-for="r in rows" :key="r.conf.name" class="card dev">
        <div class="dev-h">
          <span class="dot" :class="r.dev?.dead ? 'crit' : r.dev && Object.keys(r.dev.q).length ? 'minor' : r.dev?.lastTs ? 'good' : ''" />
          <span class="mono name">{{ r.conf.name }}</span>
          <span class="t2">{{ r.conf.label }}</span>
          <span class="sp" />
          <span class="tag">{{ KIND[r.conf.kind] ?? r.conf.kind }}</span>
          <el-button size="small" text @click="router.push('/manage/live/' + r.conf.name)">实时数据 ›</el-button>
        </div>
        <dl class="kv">
          <template v-for="k in MAIN_ATTRS.filter(k => r.conf.attrs[k] !== undefined)" :key="k">
            <dt>{{ ATTR_LABEL[k] }}</dt>
            <dd>{{ attrText(k, r.conf.attrs[k]) }}</dd>
          </template>
          <dt>遥测主题</dt>
          <dd><code>lsa/{{ r.conf.name }}/telemetry</code> <a @click="copy(`lsa/${r.conf.name}/telemetry`)">复制</a></dd>
          <dt>属性主题</dt>
          <dd><code>lsa/{{ r.conf.name }}/attributes</code></dd>
          <dt>测点</dt>
          <dd>{{ r.dev?.keys ?? 0 }} 个已收到 · 最近 {{ r.dev?.lastTs ? dt(r.dev.lastTs) : '—' }}</dd>
          <dt>质量码</dt>
          <dd :class="r.dev && Object.keys(r.dev.q).length ? 'minor' : ''">{{ r.dev ? qSummary(r.dev.q) : '—' }}</dd>
          <dt>南向（24 h）</dt>
          <dd>
            <template v-if="r.dev?.south">应到 {{ r.dev.south.req.toLocaleString() }} · 未到 {{ r.dev.south.timeout.toLocaleString() }} · 到达率 {{ r.dev.south.rate?.toFixed(2) ?? '—' }} %</template>
            <template v-else>—</template>
            <span v-if="r.dev?.southBySource" class="t2">（同事程序自报）</span>
          </dd>
          <template v-if="r.dev?.rated">
            <dt>负荷率</dt>
            <dd>eg-agent 按 max(Ia, Ib, Ic) ÷ {{ r.dev.rated }} A 算好上送<span v-if="r.dev.epBackwards" class="crit">；累计电量倒退过 {{ r.dev.epBackwards }} 次（电表清零 / 更换？）</span></dd>
          </template>
        </dl>
      </div>
    </div>
    <div v-if="store.config" class="panel">
      <div class="panel-h">EG 本身<span class="t2">{{ store.config.eg.eg.name }} · EG 级信号（分合位、电源）也发到 <code>lsa/{{ store.config.eg.eg.name }}/telemetry</code></span></div>
      <div class="panel-b">
        <dl class="kv">
          <template v-for="(v, k) in store.config.eg.eg.attrs" :key="k">
            <dt>{{ { ip: '设备网地址', ipUp: '上行地址', fw: '固件', cfg: '运行配置', cfgWant: '目标配置', pt: '点表版本', sn: '序列号', cab: '柜号' }[k] ?? k }}</dt>
            <dd>{{ v }}</dd>
          </template>
        </dl>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dev-h { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dev-h .name { font-weight: 600; }
.dev-h .sp { flex: 1; }
</style>
