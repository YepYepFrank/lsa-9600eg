<!-- 本地维护账号登录（交换机直连 EG 时用；经子站进来的不用登录） -->
<script setup lang="ts">
import { ref } from 'vue'
import { login, session } from './session'

const user = ref('maint')
const password = ref('')
const busy = ref(false)
const err = ref('')

async function submit() {
  if (!password.value) return
  busy.value = true
  err.value = ''
  try {
    await login(user.value.trim(), password.value)
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = false
    password.value = ''
  }
}
</script>

<template>
  <div class="login">
    <form class="box" @submit.prevent="submit">
      <div class="lg-brand">LSA-9600EG 边缘网关</div>
      <div class="lg-sub">本地维护登录</div>
      <el-alert v-if="session.error" :title="session.error" type="warning" :closable="false" show-icon />
      <label>账号</label>
      <el-input v-model="user" autocomplete="username" />
      <label>口令</label>
      <el-input v-model="password" type="password" show-password autocomplete="current-password" />
      <el-alert v-if="err" :title="err" type="error" :closable="false" show-icon />
      <el-button type="primary" native-type="submit" :loading="busy" :disabled="!password">登录</el-button>
      <p class="hint">从子站「边缘网关 → 该网关 → EG 管理页」进来不用登录。连续 5 次口令错误锁定 15 分钟；操作都记本地审计。</p>
    </form>
  </div>
</template>

<style scoped>
.login { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.box { width: 360px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 24px; display: flex; flex-direction: column; gap: 10px; }
.lg-brand { font-size: 18px; font-weight: 600; color: var(--brand-ink); }
.lg-sub { color: var(--text2); margin-bottom: 6px; }
label { color: var(--muted); font-size: 12px; }
.hint { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 4px 0 0; }
</style>
