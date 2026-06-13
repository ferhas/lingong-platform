<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">外部服务状态</h2>
        <p class="page-sub">公安实名、银行存管、数电票、电子签、税务申报、保险六类服务健康状态</p>
      </div>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">刷 新</el-button>
    </div>

    <div v-loading="loading" class="grid-wrap">
      <el-empty v-if="!loading && list.length === 0" description="暂无外部服务数据" :image-size="90" class="panel" />
      <el-row :gutter="16">
        <el-col v-for="svc in list" :key="svc.key" :xs="24" :sm="12" :md="8">
          <div class="panel svc-card">
            <div class="svc-head">
              <div class="svc-name">{{ svc.name }}</div>
              <div class="svc-status" :class="`st-${svc.status}`">
                <span class="dot"></span>
                {{ statusText(svc.status) }}
              </div>
            </div>
            <div class="svc-provider">服务商：{{ svc.provider || '—' }}</div>
            <div class="svc-metrics">
              <div class="metric">
                <div class="metric-label">响应延迟</div>
                <div class="metric-value">
                  {{ svc.latencyMs != null ? `${svc.latencyMs} ms` : '—' }}
                </div>
              </div>
              <div class="metric">
                <div class="metric-label">检查时间</div>
                <div class="metric-value">{{ fmtTime(svc.checkedAt) }}</div>
              </div>
            </div>
          </div>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { getIntegrations } from '../api/admin'
import { fmtTime } from '../utils/format'

const loading = ref(false)
const list = ref([])

function statusText(status) {
  return { up: '正常', down: '故障' }[status] || '未知'
}

async function load() {
  loading.value = true
  try {
    list.value = await getIntegrations()
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.grid-wrap {
  min-height: 160px;
}

.svc-card {
  margin-bottom: 16px;
}

.svc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.svc-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
}

.svc-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.svc-status .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.svc-status.st-up {
  color: var(--success);
}

.svc-status.st-up .dot {
  background: var(--success);
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.7);
}

.svc-status.st-down {
  color: var(--danger);
}

.svc-status.st-down .dot {
  background: var(--danger);
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.7);
}

.svc-status.st-unknown {
  color: var(--text-3);
}

.svc-status.st-unknown .dot {
  background: var(--text-3);
}

.svc-provider {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-3);
}

.svc-metrics {
  margin-top: 14px;
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
}

.metric {
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 10px 12px;
}

.metric-label {
  font-size: 12px;
  color: var(--text-3);
}

.metric-value {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
</style>
