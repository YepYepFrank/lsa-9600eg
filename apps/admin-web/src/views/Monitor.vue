<!-- 本柜总览 / 电气量 / 事件与录像（CabinetMonitor，领导 80e01ad 的单柜界面） -->
<script setup lang="ts">
import { useRouter } from 'vue-router'
import CabinetMonitor from '../components/CabinetMonitor.vue'
import { demoMode } from '../session'

defineProps<{ tab: 'overview' | 'electric' | 'events' }>()
const router = useRouter()
const go = (t: string) => router.push('/' + t)
</script>

<template>
  <CabinetMonitor :demo="demoMode" :tab="tab" @navigate="go" />
</template>
