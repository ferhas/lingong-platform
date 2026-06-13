<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">资金流水</h2>
        <p class="page-sub">企业户、零工户、税款备付金户、平台收益户全量流水</p>
      </div>
      <div class="page-actions">
        <el-button type="primary" plain :icon="Download" :loading="exporting" @click="onExport">
          导出流水
        </el-button>
        <el-button :icon="Refresh" circle @click="load" />
      </div>
    </div>

    <div class="panel recon-panel" v-if="recon">
      <div class="recon-head">
        <h3 class="recon-title">自动对账（银行存管回执 ↔ 平台账务）</h3>
        <el-tag :type="recon.balanced ? 'success' : 'danger'" effect="dark">
          {{ recon.balanced ? '对账平衡' : '存在差异，请人工核查' }}
        </el-tag>
      </div>
      <el-alert
        v-if="recon.mismatchDays?.length"
        type="error"
        show-icon
        :closable="false"
        class="mismatch-alert"
      >
        <template #title>
          以下日期对账存在差异，请人工核查：{{ recon.mismatchDays.join('、') }}
        </template>
      </el-alert>

      <div class="recon-grid">
        <div class="recon-cell">
          <div class="recon-label">银行侧（存管行回执）</div>
          <div class="recon-num">{{ fmtMoney(recon.bank.total) }}</div>
          <div class="recon-sub">{{ recon.bank.txns }} 笔指令回执</div>
        </div>
        <div class="recon-cell">
          <div class="recon-label">平台侧（账务流水）</div>
          <div class="recon-num">{{ fmtMoney(recon.platform.total) }}</div>
          <div class="recon-sub">{{ recon.platform.flows }} 笔对外资金动作</div>
        </div>
        <div class="recon-cell">
          <div class="recon-label">差异金额</div>
          <div class="recon-num" :class="recon.balanced ? 'recon-ok' : 'recon-bad'">{{ fmtMoney(recon.diff) }}</div>
          <div class="recon-sub">冻结/解冻为内部操作，不参与对账</div>
        </div>
      </div>

      <!-- T+1 按日对账明细 -->
      <el-collapse v-model="dailyExpanded" class="daily-collapse">
        <el-collapse-item name="daily">
          <template #title>
            <span class="daily-title">按日对账明细（近30天）</span>
            <el-tag
              v-if="recon.mismatchDays?.length"
              type="danger"
              size="small"
              effect="dark"
              style="margin-left: 10px"
            >
              {{ recon.mismatchDays.length }} 天存在差异
            </el-tag>
          </template>
          <el-table :data="recon.daily" size="small" border :row-class-name="dailyRowClass">
            <el-table-column prop="day" label="日期" width="110" align="center">
              <template #default="{ row }"><span class="mono">{{ row.day }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.status === 'balanced' ? 'success' : 'danger'" size="small" effect="dark">
                  {{ row.status === 'balanced' ? '平衡' : '差异' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="银行侧金额" min-width="120" align="right">
              <template #default="{ row }">
                <span class="money">{{ fmtMoney(row.bankTotal) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="bankTxns" label="银行笔数" width="90" align="center" />
            <el-table-column label="平台侧金额" min-width="120" align="right">
              <template #default="{ row }">
                <span class="money">{{ fmtMoney(row.platformTotal) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="platformFlows" label="平台笔数" width="90" align="center" />
            <el-table-column label="差异" min-width="110" align="right">
              <template #default="{ row }">
                <span class="money" :class="row.status === 'mismatch' ? 'recon-bad' : 'recon-ok'">
                  {{ fmtMoney(row.diff) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="核对时间" width="150">
              <template #default="{ row }">{{ fmtTime(row.checkedAt) }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无按日对账数据（T+1 生成）" :image-size="60" />
            </template>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </div>

    <div class="panel">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="流水编号" width="90" align="center" />
        <el-table-column label="账户类型" width="150">
          <template #default="{ row }">
            <el-tag :type="ownerTagType(row.ownerType)" size="small" effect="plain">
              {{ ownerText(row.ownerType) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="120">
          <template #default="{ row }">{{ typeText(row.type) }}</template>
        </el-table-column>
        <el-table-column label="金额" min-width="130" align="right">
          <template #default="{ row }">
            <span class="money" :class="amountClass(row.type)">
              {{ fmtMoney(row.amount, { sign: false }) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="余额" min-width="130" align="right">
          <template #default="{ row }">
            <span class="money">{{ fmtMoney(row.balanceAfter) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="摘要" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.remark || '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无资金流水" :image-size="90" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="load"
          @size-change="onSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Download } from '@element-plus/icons-vue'
import { getFlows, getReconciliation } from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'
import { downloadCsv } from '../utils/download'

const loading = ref(false)
const exporting = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const recon = ref(null)
// 默认收起;有差异日时自动展开,便于第一时间核查
const dailyExpanded = ref([])

function dailyRowClass({ row }) {
  return row.status === 'mismatch' ? 'daily-row-mismatch' : ''
}

const OWNER_TEXT = {
  company: '企业户',
  worker: '零工户',
  platform_tax: '税款备付金户',
  platform_revenue: '平台收益户'
}

const TYPE_TEXT = {
  recharge: '充值入金',
  freeze: '预算冻结',
  unfreeze: '预算解冻',
  settle_out: '结算出账',
  settle_in: '分包款入账',
  tax_in: '税费归集',
  revenue_in: '服务费入账',
  withdraw: '提现出账'
}

function ownerText(type) {
  return OWNER_TEXT[type] || type
}

function ownerTagType(type) {
  return {
    company: 'primary',
    worker: 'success',
    platform_tax: 'warning',
    platform_revenue: 'danger'
  }[type] || 'info'
}

function typeText(type) {
  return TYPE_TEXT[type] || type
}

function amountClass(type) {
  if (['settle_out', 'withdraw'].includes(type)) return 'amount-out'
  if (['recharge', 'settle_in', 'tax_in', 'revenue_in'].includes(type)) return 'amount-in'
  return ''
}

async function load() {
  loading.value = true
  try {
    const data = await getFlows({ page: page.value, pageSize: pageSize.value })
    list.value = data.list
    total.value = data.total
    recon.value = await getReconciliation()
    if (recon.value?.mismatchDays?.length) {
      dailyExpanded.value = ['daily']
    }
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

function onSizeChange() {
  page.value = 1
  load()
}

async function onExport() {
  exporting.value = true
  try {
    const today = new Date().toISOString().slice(0, 10)
    await downloadCsv('/admin/flows/export', `平台资金流水_${today}.csv`)
    ElMessage.success('流水已导出')
  } catch {
    /* 错误已统一提示 */
  } finally {
    exporting.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.amount-in {
  color: var(--success);
  font-weight: 700;
}

.amount-out {
  color: var(--danger);
  font-weight: 700;
}

.recon-panel {
  margin-bottom: 16px;
}

.recon-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.recon-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.recon-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.recon-cell {
  background: var(--bg-hover);
  border-radius: 10px;
  padding: 14px 18px;
}

.recon-label {
  color: var(--text-2);
  font-size: 13px;
}

.recon-num {
  font-size: 22px;
  font-weight: 700;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}

.recon-ok {
  color: var(--success);
}

.recon-bad {
  color: var(--danger);
}

.recon-sub {
  color: var(--text-3);
  font-size: 12px;
  margin-top: 4px;
}

.mismatch-alert {
  margin-bottom: 16px;
}

.daily-collapse {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  border-bottom: none;
}

.daily-collapse :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}

.daily-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

/* 差异日整行红色高亮(浅色/深色模式均可读) */
:deep(.el-table .daily-row-mismatch) {
  --el-table-tr-bg-color: rgba(239, 68, 68, 0.08);
}

:deep(.el-table .daily-row-mismatch td) {
  color: var(--danger);
}
</style>
