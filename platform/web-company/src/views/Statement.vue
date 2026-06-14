<template>
  <div>
    <PageHeader title="月结单" subtitle="按月汇总充值、消耗、开票与期末余额，支持打印归档对账">
      <template #actions>
        <el-date-picker
          v-model="period"
          type="month"
          value-format="YYYY-MM"
          placeholder="选择月份"
          :clearable="false"
          :disabled-date="d => d.getTime() > Date.now()"
          style="width: 150px"
          @change="fetchStatement"
        />
        <el-button type="primary" :disabled="!statement" @click="onPrint">
          <el-icon style="margin-right: 4px"><Printer /></el-icon>打印归档
        </el-button>
      </template>
    </PageHeader>

    <div v-loading="loading">
      <template v-if="statement">
        <!-- 摘要卡片 -->
        <div class="stat-grid">
          <StatCard icon="Wallet" label="本月充值" :extra="`共 ${summary.rechargeCount} 笔`">
            ¥{{ fmtMoney(summary.rechargeTotal) }}
          </StatCard>
          <StatCard icon="ShoppingCart" label="本月消耗" :extra="`结算任务 ${summary.settledTasks} 个`">
            ¥{{ fmtMoney(summary.consumedTotal) }}
          </StatCard>
          <StatCard icon="Tickets" label="本月开票">
            ¥{{ fmtMoney(summary.invoicedTotal) }}
          </StatCard>
          <StatCard icon="Coin" label="期末余额" :extra="`其中冻结 ¥${fmtMoney(summary.endFrozen)}`">
            ¥{{ fmtMoney(summary.endBalance) }}
          </StatCard>
        </div>

        <!-- 结算明细 -->
        <div class="page-card">
          <h3 class="page-title">结算明细（{{ statement.settlements?.length || 0 }}）</h3>
          <el-table :data="statement.settlements" stripe>
            <el-table-column prop="confirmNo" label="结算确认单号" width="210">
              <template #default="{ row }"><span class="mono">{{ row.confirmNo }}</span></template>
            </el-table-column>
            <el-table-column prop="taskTitle" label="任务" min-width="180" show-overflow-tooltip />
            <el-table-column label="企业支付" width="130" align="right">
              <template #default="{ row }"><span class="money">¥{{ fmtMoney(row.charged) }}</span></template>
            </el-table-column>
            <el-table-column label="零工分包款" width="130" align="right">
              <template #default="{ row }"><span class="money">¥{{ fmtMoney(row.subPay) }}</span></template>
            </el-table-column>
            <el-table-column label="平台服务费" width="120" align="right">
              <template #default="{ row }"><span class="money">¥{{ fmtMoney(row.platformFee) }}</span></template>
            </el-table-column>
            <el-table-column prop="invoiceNo" label="发票号" width="190">
              <template #default="{ row }"><span class="mono">{{ row.invoiceNo || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="结算时间" width="170">
              <template #default="{ row }">{{ fmtDateTime(row.doneAt) }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="本月暂无结算记录" :image-size="72" />
            </template>
          </el-table>
        </div>

        <!-- 发票明细 -->
        <div class="page-card">
          <h3 class="page-title">发票明细（{{ statement.invoices?.length || 0 }}）</h3>
          <el-table :data="statement.invoices" stripe>
            <el-table-column prop="no" label="发票号" width="220">
              <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
            </el-table-column>
            <el-table-column label="发票金额" width="140" align="right">
              <template #default="{ row }"><span class="money">¥{{ fmtMoney(row.amount) }}</span></template>
            </el-table-column>
            <el-table-column label="税率" width="90" align="center">
              <template #default="{ row }">
                <el-tag type="primary" effect="light" size="small">{{ row.taxRate }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100" align="center">
              <template #default="{ row }">
                <el-tag :type="invoiceMeta(row.status).tag" effect="light" size="small">
                  {{ invoiceMeta(row.status).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="开票日期" min-width="170">
              <template #default="{ row }">{{ fmtDateTime(row.issuedAt) }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="本月暂无发票" :image-size="72" />
            </template>
          </el-table>
        </div>
      </template>
      <el-empty v-else-if="!loading" description="暂无该月数据" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatCard from '../components/StatCard.vue'
import { getStatement } from '../api/company'
import { fmtMoney, fmtDateTime, INVOICE_STATUS } from '../utils/format'
import { printHtml, esc } from '../utils/print'

// 当前月份（本地时区）
const now = new Date()
const period = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
const statement = ref(null)
const loading = ref(false)

const summary = computed(() => statement.value?.summary || {})
const invoiceMeta = s => INVOICE_STATUS[s] || { label: s || '—', tag: 'info' }

async function fetchStatement() {
  loading.value = true
  try {
    statement.value = await getStatement(period.value)
  } catch {
    statement.value = null
  } finally {
    loading.value = false
  }
}

function onPrint() {
  const s = statement.value
  if (!s) return
  const settleRows = s.settlements
    .map(
      x => `<tr>
        <td class="mono">${esc(x.confirmNo)}</td><td>${esc(x.taskTitle)}</td>
        <td class="money">¥${fmtMoney(x.charged)}</td><td class="money">¥${fmtMoney(x.subPay)}</td>
        <td class="money">¥${fmtMoney(x.platformFee)}</td><td class="mono">${esc(x.invoiceNo)}</td>
        <td>${esc(fmtDateTime(x.doneAt))}</td>
      </tr>`
    )
    .join('')
  const invoiceRows = s.invoices
    .map(
      x => `<tr>
        <td class="mono">${esc(x.no)}</td><td class="money">¥${fmtMoney(x.amount)}</td>
        <td>${esc(x.taxRate)}</td><td>${esc(invoiceMeta(x.status).label)}</td>
        <td>${esc(fmtDateTime(x.issuedAt))}</td>
      </tr>`
    )
    .join('')
  printHtml(`企业月结单 ${s.period}`, `
    <h2>企业月结单（${esc(s.period)}）</h2>
    <table>
      <tr><th>企业名称</th><td>${esc(s.company?.companyName)}</td></tr>
      <tr><th>统一社会信用代码</th><td class="mono">${esc(s.company?.licenseNo)}</td></tr>
      <tr><th>本月充值</th><td class="money">¥${fmtMoney(s.summary.rechargeTotal)}（共 ${s.summary.rechargeCount} 笔）</td></tr>
      <tr><th>本月消耗</th><td class="money">¥${fmtMoney(s.summary.consumedTotal)}（结算任务 ${s.summary.settledTasks} 个）</td></tr>
      <tr><th>本月开票</th><td class="money">¥${fmtMoney(s.summary.invoicedTotal)}</td></tr>
      <tr><th>期末余额</th><td class="money">¥${fmtMoney(s.summary.endBalance)}（其中冻结 ¥${fmtMoney(s.summary.endFrozen)}）</td></tr>
    </table>
    <h2 style="margin-top:28px">结算明细（${s.settlements.length}）</h2>
    <table>
      <tr><th>结算确认单号</th><th>任务</th><th>企业支付</th><th>零工分包款</th><th>平台服务费</th><th>发票号</th><th>结算时间</th></tr>
      ${settleRows || '<tr><td colspan="7">本月暂无结算记录</td></tr>'}
    </table>
    <h2 style="margin-top:28px">发票明细（${s.invoices.length}）</h2>
    <table>
      <tr><th>发票号</th><th>金额</th><th>税率</th><th>状态</th><th>开票日期</th></tr>
      ${invoiceRows || '<tr><td colspan="5">本月暂无发票</td></tr>'}
    </table>
    <div class="footer">由灵工云平台生成 · ${esc(new Date().toLocaleString('zh-CN'))}</div>
  `)
}

onMounted(fetchStatement)
</script>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}
</style>
