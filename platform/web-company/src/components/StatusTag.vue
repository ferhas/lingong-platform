<template>
  <el-tag :type="meta.tag" :size="size" :effect="effect">{{ meta.label }}</el-tag>
</template>

<script setup>
import { computed } from 'vue'
import { TASK_STATUS } from '../utils/format'

const props = defineProps({
  status: { type: String, required: true },
  size: { type: String, default: 'default' },
  effect: { type: String, default: 'light' }
})

const meta = computed(() => TASK_STATUS[props.status] || { label: props.status || '未知', tag: 'info' })
</script>
