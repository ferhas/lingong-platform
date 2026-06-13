<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">财务报表中心</h2>
        <p class="page-sub">资金日报、经营月报（三方勾稽）、结算明细与企业月结单</p>
      </div>
      <el-button :icon="Refresh" circle @click="reload" />
    </div>

    <div class="panel">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="资金日报" name="daily" />
        <el-tab-pane label="经营月报" name="monthly" />
        <el-tab-pane label="结算明细" name="detail" />
      </el-tabs>

      <!-- ① 资金日报 -->
      <div v-if="activeTab === 'daily'" v-loading="dailyLoading">
        <div class="filter-bar">
          <el-date-picker
            v-model="day"
            type="date"
            value-format="YYYY-MM-DD"
            :clearable="false"
            placeholder="选择日期"
            @change="loadDaily"
          />
          <el-tag v-if="daily?.reconciliation" :type="daily.reconciliation.status === 'balanced' ? 'success' : 'danger'" effect="plain">
            对账：{{ daily.reconciliation.status === 'balanced' ? '平' : `不平（差额 ${fmtMoney(daily.reconciliation.diff)}）` }}
            · {{ fmtTime(daily.reconciliation.checkedAt) }}
          </el-tag>
          <el-tag v-else type="info" effect="plain">当日尚未对账</el-tag>
          <el-tag v-if="daily" :type="daily.openDiffItems > 0 ? 'warning' : 'info'" effect="plain">
            未处置差异 {{ daily.openDiffItems }} 笔
          </el-tag>
        </div>

        <template v-if="daily">
          <div class="block-title">账户余额（期末）</div>
          <el-table :data="daily.balances" size="small" border class="block-table">
            <el-table-column prop="ownerLabel" label="账户类型" min-width="140" />
            <el-table-column prop="accounts" label="账户数" width="100" align="center" />
            <el-table-column label="余额合计" align="right" min-width="140">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.balance) }}</span></template>
            </el-table-column>
            <el-table-column label="冻结合计" align="right" min-width="140">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.frozen) }}</span></template>
            </el-table-column>
            <template #empty><el-empty description="暂无账户" :image-size="50" /></template>
          </el-table>

          <div class="block-title">当日发生额</div>
          <el-table :data="daily.movements" size="small" border>
            <el-table-column prop="ownerLabel" label="账户类型" min-width="130" />
            <el-table-column label="流水类型" min-width="130">
              <template #default="{ row }">{{ flowTypeText(row.flowType) }}</template>
            </el-table-column>
            <el-table-column prop="count" label="笔数" width="90" align="center" />
            <el-table-column label="发生额" align="right" min-width="140">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.amount) }}</span></template>
            </el-table-column>
            <template #empty><el-empty description="当日无资金发生额" :image-size="50" /></template>
          </el-table>
        </template>
      </div>

      <!-- ② 经营月报 -->
      <div v-else-if="activeTab === 'monthly'" v-loading="monthlyLoading">
        <div class="filter-bar">
          <el-date-picker
            v-model="monthlyPeriod"
            type="month"
            value-format="YYYY-MM"
            :clearable="false"
            placeholder="选择月份"
            @change="loadMonthly"
          />
        </div>

        <template v-if="monthly">
          <!-- 经营指标 -->
          <el-row :gutter="14" class="kpi-row">
            <el-col v-for="k in operatingKpis" :key="k.label" :xs="12" :sm="8" :md="6">
              <div class="kpi-card">
                <div class="kpi-label">{{ k.label }}</div>
                <div class="kpi-value money">{{ k.value }}</div>
              </div>
            </el-col>
          </el-row>

          <!-- 勾稽校验 -->
          <div class="block-title">月结勾稽校验</div>
          <div class="check-list">
            <div class="check-item" :class="monthly.operating.checks.revenueInvoiceMatch ? 'check-ok' : 'check-fail'">
              <el-icon v-if="monthly.operating.checks.revenueInvoiceMatch"><CircleCheckFilled /></el-icon>
              <el-icon v-else><CircleCloseFilled /></el-icon>
              <span>收入 = 有效开票金额（确认收入与全额开票口径一致）</span>
            </div>
            <div class="check-item" :class="monthly.operating.checks.settlementTaxRecordMatch ? 'check-ok' : 'check-fail'">
              <el-icon v-if="monthly.operating.checks.settlementTaxRecordMatch"><CircleCheckFilled /></el-icon>
              <el-icon v-else><CircleCloseFilled /></el-icon>
              <span>结算分包款 = 计税记录收入额（结算与税务底稿勾稽）</span>
            </div>
          </div>

          <!-- 税款备付金 -->
          <div class="block-title">税款备付金</div>
          <el-row :gutter="14" class="kpi-row">
            <el-col :xs="12" :sm="6">
              <div class="kpi-card">
                <div class="kpi-label">应缴个税</div>
                <div class="kpi-value money">{{ fmtMoney(monthly.taxReserve.due.tax) }}</div>
              </div>
            </el-col>
            <el-col :xs="12" :sm="6">
              <div class="kpi-card">
                <div class="kpi-label">应缴增值税</div>
                <div class="kpi-value money">{{ fmtMoney(monthly.taxReserve.due.vat) }}</div>
              </div>
            </el-col>
            <el-col :xs="12" :sm="6">
              <div class="kpi-card">
                <div class="kpi-label">应缴合计（{{ monthly.taxReserve.due.records }} 条计税记录）</div>
                <div class="kpi-value money">{{ fmtMoney(monthly.taxReserve.due.total) }}</div>
              </div>
            </el-col>
            <el-col :xs="12" :sm="6">
              <div class="kpi-card">
                <div class="kpi-label">备付金户余额</div>
                <div class="kpi-value money" :class="{ 'kpi-danger': reserveShort }">
                  {{ fmtMoney(monthly.taxReserve.reserveBalance) }}
                </div>
              </div>
            </el-col>
          </el-row>
          <el-alert
            v-if="monthly.taxReserve.declaration"
            type="success"
            :closable="false"
            show-icon
            class="block-alert"
            :title="`本期已申报：回执号 ${monthly.taxReserve.declaration.receiptNo || '—'}（${monthly.taxReserve.declaration.status === 'filed' ? '已回填' : monthly.taxReserve.declaration.status}）`"
          />
          <el-alert v-else type="info" :closable="false" show-icon class="block-alert" title="本期尚未申报" />

          <!-- 科目余额表 -->
          <div class="block-title">科目余额表（业务事件 → 会计科目）</div>
          <el-table :data="monthly.subjects" size="small" border>
            <el-table-column label="业务事件" width="130">
              <template #default="{ row }">{{ flowTypeText(row.flowType) }}</template>
            </el-table-column>
            <el-table-column prop="subject" label="对应会计科目" min-width="260" show-overflow-tooltip />
            <el-table-column prop="count" label="笔数" width="90" align="center" />
            <el-table-column label="发生额" align="right" min-width="140">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.amount) }}</span></template>
            </el-table-column>
          </el-table>
        </template>
      </div>

      <!-- ③ 结算明细 + 企业月结单 -->
      <div v-else v-loading="detailLoading">
        <div class="filter-bar">
          <el-date-picker
            v-model="detailPeriod"
            type="month"
            value-format="YYYY-MM"
            :clearable="false"
            placeholder="选择月份"
            @change="loadDetail"
          />
          <el-button type="primary" plain :icon="Download" :loading="exporting" @click="onExportDetail">
            下载结算明细 CSV
          </el-button>
        </div>

        <el-table :data="detailList" size="small" border>
          <el-table-column label="确认单号" min-width="160">
            <template #default="{ row }"><span class="mono">{{ row.confirmNo }}</span></template>
          </el-table-column>
          <el-table-column prop="taskTitle" label="任务" min-width="150" show-overflow-tooltip />
          <el-table-column prop="companyName" label="企业" min-width="140" show-overflow-tooltip />
          <el-table-column prop="workerName" label="零工" width="100" />
          <el-table-column label="企业承担" align="right" width="110">
            <template #default="{ row }"><span class="money">{{ fmtMoney(row.charged) }}</span></template>
          </el-table-column>
          <el-table-column label="个税" align="right" width="100">
            <template #default="{ row }"><span class="money">{{ fmtMoney(row.tax) }}</span></template>
          </el-table-column>
          <el-table-column label="实发" align="right" width="110">
            <template #default="{ row }"><span class="money net-amount">{{ fmtMoney(row.net) }}</span></template>
          </el-table-column>
          <el-table-column label="服务费" align="right" width="100">
            <template #default="{ row }"><span class="money">{{ fmtMoney(row.margin) }}</span></template>
          </el-table-column>
          <el-table-column prop="method" label="计税方式" width="100" align="center" />
          <el-table-column label="完成时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.doneAt) }}</template>
          </el-table-column>
          <template #empty><el-empty description="该月暂无已完成结算" :image-size="60" /></template>
        </el-table>

        <!-- 企业月结单 -->
        <div class="block-title">企业月结单查询</div>
        <div class="filter-bar">
          <el-input-number
            v-model="stmtCompanyId"
            :min="1"
            :precision="0"
            controls-position="right"
            placeholder="企业ID"
            style="width: 150px"
          />
          <el-date-picker
            v-model="stmtPeriod"
            type="month"
            value-format="YYYY-MM"
            :clearable="false"
            placeholder="选择月份"
            style="width: 150px"
          />
          <el-button type="primary" :loading="stmtLoading" :disabled="!stmtCompanyId" @click="loadStatement">
            查 询
          </el-button>
        </div>

        <template v-if="statement">
          <el-descriptions :column="3" border size="small" class="block-table">
            <el-descriptions-item label="企业">
              {{ statement.company.companyName }}（#{{ statement.company.id }}）
            </el-descriptions-item>
            <el-descriptions-item label="所属期">{{ statement.period }}</el-descriptions-item>
            <el-descriptions-item label="结算任务数">{{ statement.summary.settledTasks }}</el-descriptions-item>
            <el-descriptions-item label="充值合计">
              <span class="money">{{ fmtMoney(statement.summary.rechargeTotal) }}</span>（{{ statement.summary.rechargeCount }} 笔）
            </el-descriptions-item>
            <el-descriptions-item label="消耗合计">
              <span class="money">{{ fmtMoney(statement.summary.consumedTotal) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="开票合计">
              <span class="money">{{ fmtMoney(statement.summary.invoicedTotal) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="期末余额">
              <span class="money">{{ fmtMoney(statement.summary.endBalance) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="期末冻结" :span="2">
              <span class="money">{{ fmtMoney(statement.summary.endFrozen) }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-table :data="statement.settlements" size="small" border class="block-table">
            <el-table-column label="确认单号" min-width="160">
              <template #default="{ row }"><span class="mono">{{ row.confirmNo }}</span></template>
            </el-table-column>
            <el-table-column prop="taskTitle" label="任务" min-width="150" show-overflow-tooltip />
            <el-table-column label="企业承担" align="right" width="110">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.charged) }}</span></template>
            </el-table-column>
            <el-table-column label="分包款" align="right" width="110">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.subPay) }}</span></template>
            </el-table-column>
            <el-table-column label="平台服务费" align="right" width="110">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.platformFee) }}</span></template>
            </el-table-column>
            <el-table-column label="发票号" min-width="140">
              <template #default="{ row }"><span class="mono">{{ row.invoiceNo || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="完成时间" width="160">
              <template #default="{ row }">{{ fmtTime(row.doneAt) }}</template>
            </el-table-column>
            <template #empty><el-empty description="该月该企业无结算记录" :image-size="50" /></template>
          </el-table>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Download, CircleCheckFilled, CircleCloseFilled } from '@element-plus/icons-vue'
import {
  getFinanceDaily,
  getFinanceMonthly,
  getSettlementDetail,
  getCompanyStatement
} from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'
import { downloadCsv } from '../utils/download'

const activeTab = ref('daily')

const FLOW_TYPE_TEXT = {
  recharge: '充值入金',
  freeze: '预算冻结',
  unfreeze: '预算解冻',
  settle_out: '结算出账',
  settle_in: '分包款入账',
  tax_in: '税费归集',
  revenue_in: '服务费入账',
  withdraw: '提现出账'
}

function flowTypeText(type) {
  return FLOW_TYPE_TEXT[type] || type
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function thisMonth() {
  return new Date().toISOString().slice(0, 7)
}

// —— ① 资金日报 ——
const day = ref(today())
const daily = ref(null)
const dailyLoading = ref(false)

async function loadDaily() {
  dailyLoading.value = true
  try {
    daily.value = await getFinanceDaily(day.value)
  } catch {
    /* 错误已统一提示 */
  } finally {
    dailyLoading.value = false
  }
}

// —— ② 经营月报 ——
const monthlyPeriod = ref(thisMonth())
const monthly = ref(null)
const monthlyLoading = ref(false)

const operatingKpis = computed(() => {
  const o = monthly.value?.operating
  if (!o) return []
  return [
    { label: `结算任务数（${o.period}）`, value: `${o.settledTasks} 单` },
    { label: '确认收入', value: fmtMoney(o.revenue) },
    { label: '分包成本', value: fmtMoney(o.subContractCost) },
    { label: `毛利（${o.grossMarginRate}）`, value: fmtMoney(o.grossMargin) },
    { label: '代扣个税', value: fmtMoney(o.withheldTax) },
    { label: '代征增值税', value: fmtMoney(o.vat) },
    { label: '有效开票', value: fmtMoney(o.invoiced) },
    { label: '红冲发票', value: fmtMoney(o.invoiceVoided) }
  ]
})

const reserveShort = computed(() => {
  const t = monthly.value?.taxReserve
  return t && Number(t.reserveBalance) < Number(t.due.total)
})

async function loadMonthly() {
  monthlyLoading.value = true
  try {
    monthly.value = await getFinanceMonthly(monthlyPeriod.value)
  } catch {
    /* 错误已统一提示 */
  } finally {
    monthlyLoading.value = false
  }
}

// —— ③ 结算明细 + 企业月结单 ——
const detailPeriod = ref(thisMonth())
const detailList = ref([])
const detailLoading = ref(false)
const detailLoaded = ref(false)
const exporting = ref(false)

const stmtCompanyId = ref(null)
const stmtPeriod = ref(thisMonth())
const statement = ref(null)
const stmtLoading = ref(false)

async function loadDetail() {
  detailLoading.value = true
  try {
    const data = await getSettlementDetail(detailPeriod.value)
    detailList.value = data.list
    detailLoaded.value = true
  } catch {
    /* 错误已统一提示 */
  } finally {
    detailLoading.value = false
  }
}

async function onExportDetail() {
  exporting.value = true
  try {
    await downloadCsv(
      `/admin/finance/settlement-detail?period=${detailPeriod.value}&format=csv`,
      `结算明细_${detailPeriod.value}.csv`
    )
    ElMessage.success('结算明细已下载')
  } catch {
    /* 错误已统一提示 */
  } finally {
    exporting.value = false
  }
}

async function loadStatement() {
  stmtLoading.value = true
  try {
    statement.value = await getCompanyStatement(stmtCompanyId.value, stmtPeriod.value)
  } catch {
    /* 错误已统一提示 */
  } finally {
    stmtLoading.value = false
  }
}

const monthlyLoaded = ref(false)

function onTabChange() {
  if (activeTab.value === 'monthly' && !monthlyLoaded.value) {
    monthlyLoaded.value = true
    loadMonthly()
  } else if (activeTab.value === 'detail' && !detailLoaded.value) {
    loadDetail()
  }
}

function reload() {
  if (activeTab.value === 'daily') loadDaily()
  else if (activeTab.value === 'monthly') loadMonthly()
  else loadDetail()
}

onMounted(loadDaily)
</script>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.block-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  margin: 18px 0 10px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
}

.block-table {
  margin-bottom: 6px;
}

.block-alert {
  margin: 10px 0 4px;
}

.kpi-row {
  margin-bottom: 4px;
}

.kpi-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 12px;
}

.kpi-label {
  font-size: 12px;
  color: var(--text-3);
}

.kpi-value {
  margin-top: 6px;
  font-size: 20px;
  font-weight: 800;
  color: var(--text-1);
}

.kpi-danger {
  color: var(--danger);
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}

.check-item.check-ok {
  color: var(--success);
}

.check-item.check-fail {
  color: var(--danger);
  border-color: var(--danger);
}

.net-amount {
  color: var(--success);
  font-weight: 700;
}
</style>
