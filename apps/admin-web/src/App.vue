<!-- 入口：先用票据换会话（经子站进来时），没有会话就给登录页 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Login from './Login.vue'
import Shell from './layout/Shell.vue'
import { boot, session } from './session'

const ready = ref(false)
onMounted(async () => {
  await boot()
  ready.value = true
})
</script>

<template>
  <template v-if="ready">
    <Shell v-if="session.me" />
    <Login v-else />
  </template>
</template>
