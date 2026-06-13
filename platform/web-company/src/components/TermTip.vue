<template>
  <el-tooltip :content="tip || TERM_TIPS[term] || term" placement="top" :show-after="80">
    <span class="term-tip">{{ text || term }}</span>
  </el-tooltip>
</template>

<script setup>
import { TERM_TIPS } from '../utils/format'

defineProps({
  /** 术语（命中 TERM_TIPS 词条） */
  term: { type: String, required: true },
  /** 展示文案（缺省直接展示术语本身） */
  text: { type: String, default: '' },
  /** 自定义解释（覆盖词条） */
  tip: { type: String, default: '' }
})
</script>

<style scoped>
.term-tip {
  border-bottom: 1px dashed currentColor;
  cursor: help;
}
</style>
