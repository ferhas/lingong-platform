<template>
  <div class="page-header">
    <div class="page-header-text">
      <h2 class="page-header-title">{{ title }}</h2>
      <p v-if="subtitle" class="page-header-subtitle">{{ subtitle }}</p>
    </div>
    <div class="page-header-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
})
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.page-header-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 28px;
}

.page-header-subtitle {
  margin: 5px 0 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
}

.page-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
</style>
