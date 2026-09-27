<!-- 系统：本机信息与版本、本地设置（对时服务器、上行网口）、本地维护账号与口令、审计 -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, session } from '../session'
import { refreshConfig, store } from '../store'
import { dt } from '../utils/fmt'
import type { AuditEntry } from '../types'

const canMaint = computed(() => session.me?.role === 'maint')
const cfg = computed(() => store.config)
const comp = (k: string) => store.comps.find(c => c.key === k)

/* 本地设置 */
const local = reactive({ ntpServer: '', uplinkIface: '' })
watch(
  cfg,
  c => {
    if (c) Object.assign(local, { ntpServer: c.local.ntp.server, uplinkIface: c.local.net.uplink })
  },
  { immediate: true },
)
async function saveLocal() {
  try {
    const r = await api<{ changed: string[] }>('config/local', { method: 'PUT', body: { ...local } })
    ElMessage.success(r.changed.length ? `已保存：${r.changed.join('、')}` : '没有改动')
    await refreshConfig()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/* 本地账号 */
interface MeInfo {
  account: { user: string; changedAt: number; lockedUntil: number; initialPasswordFile: boolean } | null
}
const me = ref<MeInfo | null>(null)
const pw = reactive({ old: '', next: '', again: '' })
async function changePw() {
  if (pw.next !== pw.again) return ElMessage.error('两次输入的新口令不一样')
  try {
    await api('auth/password', { method: 'POST', body: { oldPassword: pw.old, newPassword: pw.next } })
    ElMessage.success('口令已改；其他本地登录的会话已作废')
    Object.assign(pw, { old: '', next: '', again: '' })
    me.value = await api<MeInfo>('auth/me')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/* 审计 */
const audit = ref<AuditEntry[]>([])
const auditQ = ref('')
async function loadAudit() {
  if (!canMaint.value) return
  try {
    audit.value = await api<AuditEntry[]>('audit?limit=500')
  } catch {
    audit.value = []
  }
}
const auditShown = computed(() => {
  const f = auditQ.value.trim()
  return f ? audit.value.filter(a => [a.user, a.name, a.action, a.target, a.detail ?? '', a.ip].some(x => x.includes(f))) : audit.value
})

onMounted(async () => {
  void refreshConfig()
  me.value = await api<MeInfo>('auth/me').catch(() => null)
  void loadAudit()
})
</script>

<template>
  <div>
    <div class="page-h"><h1>系统</h1></div>
    <div class="grid g2">
      <div class="panel" style="margin-top: 0">
        <div class="panel-h">本机</div>
        <div v-if="cfg" class="panel-b">
          <dl class="kv">
            <dt>网关</dt><dd>{{ cfg.eg.eg.name }} · SN {{ cfg.eg.eg.attrs['sn'] ?? '—' }}</dd>
            <dt>所在柜</dt><dd>{{ cfg.eg.cabinet.code }} {{ cfg.eg.cabinet.name }}（{{ cfg.eg.cabinet.kind }}，额定 {{ cfg.eg.cabinet.rated }} A）</dd>
            <dt>配电室</dt><dd>{{ cfg.eg.station.label }}</dd>
            <dt>子站主机</dt><dd>{{ cfg.eg.sp.host }}</dd>
            <dt>设备网 / 上行网</dt><dd>{{ cfg.eg.eg.attrs['ip'] ?? '—' }} / {{ cfg.eg.eg.attrs['ipUp'] ?? '—' }}</dd>
            <dt>访问令牌</dt><dd>{{ cfg.eg.eg.token }}</dd>
            <dt>子站配置生成于</dt><dd>{{ dt(Date.parse(cfg.eg.generatedAt)) }}</dd>
            <dt>eg-agent</dt><dd>{{ store.status?.version }}</dd>
            <dt>EG 本地 TB</dt><dd class="mono">{{ comp('tb')?.image ?? '—' }}</dd>
            <dt>本地 TB 账号</dt><dd>{{ cfg.eg.tb?.user ?? '—（provision:eg 还没建）' }}</dd>
            <dt>上送子站</dt><dd class="mono">{{ cfg.eg.stationUplink.mqtt ?? '—' }}（令牌{{ cfg.eg.stationUplink.token || '未设置' }}）</dd>
            <dt>TB IoT Gateway</dt><dd class="mono">{{ comp('gateway')?.image ?? '—' }}</dd>
            <dt>本机总线</dt><dd class="mono">{{ comp('mosquitto')?.image ?? '—' }}</dd>
          </dl>
        </div>
      </div>

      <div class="panel" style="margin-top: 0">
        <div class="panel-h">本地设置<span class="t2">设备清单、额定电流在子站改；总线与本地 TB 地址、容器名要到 EG 上改 local.yaml</span></div>
        <div class="panel-b">
          <el-form label-width="110px" size="small" :disabled="!canMaint" @submit.prevent="saveLocal">
            <el-form-item label="对时服务器"><el-input v-model="local.ntpServer" :placeholder="`留空 = 子站主机 ${cfg?.eg.sp.host ?? ''}`" /><div class="note">只用来测对时偏差；EG 自己的对时由系统 chrony 做</div></el-form-item>
            <el-form-item label="上行网口"><el-input v-model="local.uplinkIface" placeholder="留空 = 按默认路由自动找（如 enp2s0）" /><div class="note">用来算上行流量</div></el-form-item>
            <el-form-item><el-button type="primary" native-type="submit">保存</el-button></el-form-item>
          </el-form>
        </div>
      </div>

      <div class="panel" style="margin-top: 0">
        <div class="panel-h">本地维护账号</div>
        <div class="panel-b">
          <dl class="kv" style="margin-bottom: 12px">
            <dt>账号</dt><dd>maint（交换机直连 EG 时用；从子站进来不用）</dd>
            <dt>当前会话</dt><dd>{{ session.me?.name }}（{{ session.me?.via === 'sp' ? '经子站单点登录' : '本地登录' }}，{{ session.me?.role === 'maint' ? '维护' : '只看' }}）</dd>
            <template v-if="me?.account">
              <dt>口令修改于</dt><dd>{{ dt(me.account.changedAt) }}</dd>
            </template>
          </dl>
          <el-alert v-if="me?.account?.initialPasswordFile" type="warning" :closable="false" show-icon title="初始口令文件还在：改掉口令后请在 EG 上删除 initial-password.txt" style="margin-bottom: 10px" />
          <el-form label-width="110px" size="small" :disabled="!canMaint" @submit.prevent="changePw">
            <el-form-item label="原口令"><el-input v-model="pw.old" type="password" show-password autocomplete="current-password" /></el-form-item>
            <el-form-item label="新口令"><el-input v-model="pw.next" type="password" show-password autocomplete="new-password" placeholder="≥ 8 位，含字母和数字" /></el-form-item>
            <el-form-item label="再输一次"><el-input v-model="pw.again" type="password" show-password autocomplete="new-password" /></el-form-item>
            <el-form-item><el-button type="primary" native-type="submit" :disabled="!pw.old || !pw.next">改口令</el-button></el-form-item>
          </el-form>
        </div>
      </div>

      <div class="panel" style="margin-top: 0">
        <div class="panel-h">安全策略</div>
        <div class="panel-b note">
          口令至少 8 位且同时含字母和数字；连续 5 次口令错误锁定 15 分钟；30 分钟无操作自动退出。<br />
          经子站进来的：子站签 60 秒、只能用一次的票据，按子站角色放权（有「网关维护」权限的可重启组件、改本地配置，其余只看）；子站审计记谁何时打开了哪台 EG，操作记在下面的本地审计里。
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">本地审计<span class="t2">最近 500 条</span><span class="sp" /><el-input v-model="auditQ" size="small" placeholder="筛选" clearable style="width: 160px" /><el-button size="small" :disabled="!canMaint" @click="loadAudit">刷新</el-button></div>
      <div v-if="!canMaint" class="empty">只读账号看不了审计</div>
      <el-table v-else :data="auditShown" size="small" max-height="420">
        <el-table-column label="时间" width="150"><template #default="{ row }">{{ dt(row.ts) }}</template></el-table-column>
        <el-table-column label="用户" width="170"><template #default="{ row }">{{ row.name }}<span class="muted">（{{ row.user }}）</span></template></el-table-column>
        <el-table-column label="途径" width="80"><template #default="{ row }">{{ { local: '本地', sp: '经子站', system: '系统' }[row.via as string] }}</template></el-table-column>
        <el-table-column prop="ip" label="地址" width="120" />
        <el-table-column prop="action" label="操作" width="120" />
        <el-table-column prop="target" label="对象" width="140" />
        <el-table-column label="结果" width="70"><template #default="{ row }"><span :class="row.ok ? 'good' : 'crit'">{{ row.ok ? '成功' : '失败' }}</span></template></el-table-column>
        <el-table-column prop="detail" label="说明" min-width="200" />
      </el-table>
    </div>
  </div>
</template>
