<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">系统健康</h2>
        <p class="page-sub">应急开关、定时任务哑死检测、回调积压、结算/提现在途与对账结果总览</p>
      </div>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">刷 新</el-button>
    </div>

    <template v-if="data">
      <!-- 顶部告警卡 -->
      <el-row :gutter="14" class="stat-row">
        <el-col :xs="12" :sm="8" :md="4">
          <div class="hc-card" :class="{ 'hc-danger': data.switches.settlementPaused }">
            <div class="hc-label">结算开关</div>
            <div class="hc-value">{{ data.switches.settlementPaused ? '已暂停' : '正常' }}</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="hc-card" :class="{ 'hc-danger': data.switches.withdrawalPaused }">
            <div class="hc-label">提现开关</div>
            <div class="hc-value">{{ data.switches.withdrawalPaused ? '已暂停' : '正常' }}</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="hc-card" :class="{ 'hc-warning': data.webhookBacklog > 0 }">
            <div class="hc-label">回调积压</div>
            <div class="hc-value">{{ data.webhookBacklog }} 条</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="hc-card" :class="{ 'hc-danger': data.settlements.failed > 0 }">
            <div class="hc-label">失败结算单</div>
            <div class="hc-value">{{ data.settlements.failed }} 单</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="hc-card" :class="{ 'hc-warning': data.settlements.pending > 0 }">
            <div class="hc-label">在途结算</div>
            <div class="hc-value">{{ data.settlements.pending }} 单</div>
            <div v-if="data.settlements.pendingOldest" class="hc-sub">最早 {{ fmtTime(data.settlements.pendingOldest) }}</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="hc-card" :class="{ 'hc-danger': data.negativeAccounts > 0 }">
            <div class="hc-label">负余额账户</div>
            <div class="hc-value">{{ data.negativeAccounts }} 个</div>
          </div>
        </el-col>
      </el-row>

      <el-alert
        v-if="data.negativeAccounts > 0"
        type="error"
        show-icon
        :closable="false"
        class="warn-alert"
        title="存在负余额/冻结异常账户，资金账务可能被破坏，请立即排查资金流水"
      />
      <el-alert
        v-if="data.switches.settlementPaused || data.switches.withdrawalPaused"
        type="warning"
        show-icon
        :closable="false"
        class="warn-alert"
        title="应急开关处于暂停状态，恢复操作请前往「结算/提现单据」页的应急开关卡片"
      />

      <!-- Job 运行表 -->
      <div class="panel block">
        <div class="block-head">
          <div class="block-title">定时任务运行状态（最近成功时间超过周期 2 倍标红）</div>
        </div>
        <el-table :data="jobRows" size="small" border>
          <el-table-column label="任务" min-width="170">
            <template #default="{ row }">
              {{ row.label }}
              <span class="mono job-code">{{ row.job }}</span>
            </template>
          </el-table-column>
          <el-table-column label="执行周期" width="100" align="center">
            <template #default="{ row }">{{ row.periodText }}</template>
          </el-table-column>
          <el-table-column label="最近执行" width="160">
            <template #default="{ row }">{{ fmtTime(row.lastRunAt) }}</template>
          </el-table-column>
          <el-table-column label="最近成功" width="160">
            <template #default="{ row }">
              <span :class="{ 'job-stale': row.stale }">{{ row.lastSuccessAt ? fmtTime(row.lastSuccessAt) : '从未成功' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.stale ? 'danger' : 'success'" size="small" :effect="row.stale ? 'dark' : 'plain'">
                {{ row.stale ? '疑似哑死' : '正常' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最近结果" min-width="180" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono result-text">{{ row.lastResult || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="最近错误" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.lastError }">{{ row.lastError || '—' }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无任务运行记录(服务可能刚启动)" :image-size="60" />
          </template>
        </el-table>
      </div>

      <!-- 资金与对账 -->
      <div class="panel block">
        <div class="block-head">
          <div class="block-title">资金在途与对账</div>
        </div>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="在途提现">
            {{ data.withdrawals.inflight }} 单
            <span v-if="data.withdrawals.oldest" class="hc-sub">（最早 {{ fmtTime(data.withdrawals.oldest) }}）</span>
          </el-descriptions-item>
          <el-descriptions-item label="最近一次对账">
            <template v-if="data.lastReconciliation">
              {{ data.lastReconciliation.day }} ·
              <el-tag
                :type="data.lastReconciliation.status === 'balanced' ? 'success' : 'danger'"
                size="small"
              >
                {{ data.lastReconciliation.status === 'balanced' ? '账实相符' : `不平（差额 ${fmtMoney(data.lastReconciliation.diff)}）` }}
              </el-tag>
            </template>
            <span v-else>尚未对账</span>
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 集成健康 -->
      <div class="panel block">
        <div class="block-head">
          <div class="block-title">外部集成健康</div>
        </div>
        <el-table :data="data.integrations" size="small" border>
          <el-table-column prop="name" label="服务" min-width="130" />
          <el-table-column prop="provider" label="服务商" min-width="120">
            <template #default="{ row }">{{ row.provider || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === 'up' ? 'success' : 'danger'" size="small" :effect="row.status === 'up' ? 'plain' : 'dark'">
                {{ row.status === 'up' ? '正常' : '故障' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="时延" width="100" align="right">
            <template #default="{ row }">{{ row.latencyMs != null ? `${row.latencyMs} ms` : '—' }}</template>
          </el-table-column>
          <el-table-column label="检查时间" min-width="150">
            <template #default="{ row }">{{ fmtTime(row.checkedAt) }}</template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无集成数据" :image-size="50" />
          </template>
        </el-table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { getSystemHealth } from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'

const loading = ref(false)
const data = ref(null)

// 各 Job 的中文名与执行周期(分钟),用于哑死检测(最近成功超过 2 倍周期标红)
const JOB_META = {
  settlementRetry: { label: '结算重试', period: 5 },
  withdrawals: { label: '提现出金处理', period: 2 },
  autoAccept: { label: '超期自动验收', period: 60 },
  timeoutReminders: { label: '超时提醒', period: 1440 },
  dailyRecon: { label: 'T+1 自动对账', period: 1440 },
  housekeeping: { label: '数据治理', period: 1440 },
  disputeTimeouts: { label: '争议超时流转', period: 10 },
  ticketSla: { label: '工单 SLA 升级', period: 15 },
  webhookRetry: { label: '回调补单重放', period: 5 },
  rechargeExpire: { label: '充值/导出过期', period: 30 }
}

function periodText(minutes) {
  if (minutes >= 1440) return `每 ${minutes / 1440} 天`
  if (minutes >= 60) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

function parseTime(value) {
  if (!value) return NaN
  return new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T')).getTime()
}

const jobRows = computed(() =>
  (data.value?.jobs || []).map(j => {
    const meta = JOB_META[j.job] || { label: j.job, period: 60 }
    const successTs = parseTime(j.lastSuccessAt)
    const stale = !Number.isFinite(successTs) || Date.now() - successTs > meta.period * 2 * 60000
    return {
      ...j,
      label: meta.label,
      periodText: periodText(meta.period),
      stale
    }
  })
)

async function load() {
  loading.value = true
  try {
    data.value = await getSystemHealth()
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.stat-row {
  margin-bottom: 4px;
}

.hc-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 12px;
}

.hc-card.hc-danger {
  border-color: var(--danger);
}

.hc-card.hc-danger .hc-value {
  color: var(--danger);
}

.hc-card.hc-warning {
  border-color: var(--warning);
}

.hc-card.hc-warning .hc-value {
  color: var(--warning);
}

.hc-label {
  font-size: 12px;
  color: var(--text-3);
}

.hc-value {
  margin-top: 6px;
  font-size: 20px;
  font-weight: 800;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.hc-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}

.warn-alert {
  margin-bottom: 12px;
}

.block {
  margin-bottom: 16px;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.block-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.job-code {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 6px;
}

.job-stale {
  color: var(--danger);
  font-weight: 700;
}

.fail-reason {
  color: var(--danger);
}

.result-text {
  font-size: 12px;
  color: var(--text-3);
}
</style>
