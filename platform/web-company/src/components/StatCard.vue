<template>
  <div
    class="stat-card"
    :class="{ clickable }"
    :tabindex="clickable ? 0 : undefined"
    :role="clickable ? 'button' : undefined"
    @click="onClick"
    @keydown.enter="onClick"
    @keydown.space.prevent="onClick"
  >
    <div v-if="icon" class="stat-icon">
      <el-icon :size="22"><component :is="icon" /></el-icon>
    </div>
    <div class="stat-body">
      <div class="stat-label">{{ label }}</div>
      <div class="stat-value money">
        <slot>{{ value }}</slot>
      </div>
      <div v-if="extra" class="stat-extra">{{ extra }}</div>
    </div>
    <el-icon v-if="clickable" class="stat-arrow"><ArrowRight /></el-icon>
  </div>
</template>

<script setup>
const props = defineProps({
  icon: { type: String, default: '' },
  label: { type: String, required: true },
  value: { type: [String, Number], default: '' },
  extra: { type: String, default: '' },
  clickable: { type: Boolean, default: false }
})

const emit = defineEmits(['click'])

function onClick() {
  if (props.clickable) emit('click')
}
</script>

<style scoped>
.stat-card {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  padding: 20px 24px;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  position: relative;
  transition: background-color 0.25s, transform 0.15s, box-shadow 0.15s;
}

.stat-card.clickable {
  cursor: pointer;
}

.stat-card.clickable:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-pop);
}

.stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--brand-weak);
  color: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-body {
  min-width: 0;
}

.stat-label {
  color: var(--text-3);
  font-size: 13px;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 32px;
}

.stat-extra {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 12px;
}

.stat-arrow {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
}
</style>
