<template>
  <div v-loading="loading" class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">税务工作台</h2>
        <p class="page-sub">当前所属期：{{ overview?.period || '—' }} · 所属季度：{{ overview?.quarter || '—' }}</p>
      </div>
      <div class="page-actions">
        <el-button plain :icon="Download" :loading="declareFileExporting" @click="onExportDeclareFile">
          下载扣缴申报导入文件
        </el-button>
        <el-button type="primary" plain :icon="Download" :loading="exporting" @click="onExport">
          导出当期明细
        </el-button>
        <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
      </div>
    </div>

    <!-- ① 本月代扣代办 -->
    <div class="panel block">
      <div class="block-head">
        <div class="block-title">本月代扣代办</div>
        <el-tooltip :content="canDeclare ? '' : '需要「税务申报」权限'" :disabled="canDeclare" placement="top">
          <span>
            <el-button
              type="primary"
              :disabled="!canDeclare || !overview || overview.declared"
              :loading="declaring"
              @click="onDeclare"
            >
              {{ overview?.declared ? '已申报' : '批量申报缴款' }}
            </el-button>
          </span>
        </el-tooltip>
      </div>
      <el-row :gutter="16">
        <el-col :xs="24" :sm="12">
          <div class="amount-card">
            <div class="amount-label">代扣个人所得税（劳务报酬）</div>
            <div class="amount-value money">{{ fmtMoney(overview?.withheldTax ?? 0) }}</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12">
          <div class="amount-card">
            <div class="amount-label">代办增值税及附加</div>
            <div class="amount-value money">{{ fmtMoney(overview?.vat ?? 0) }}</div>
          </div>
        </el-col>
      </el-row>
      <el-alert
        v-if="declareReceipt"
        type="success"
        show-icon
        :closable="false"
        class="receipt-alert"
        :title="`申报成功，税务局回执号：${declareReceipt}`"
      />
      <el-alert
        v-else-if="overview?.declared"
        type="info"
        show-icon
        :closable="false"
        class="receipt-alert"
        title="本期已完成批量申报缴款"
      />
      <!-- 扣缴端线下申报后回填税务局回执号 -->
      <div v-if="canDeclare" class="receipt-fill-row">
        <el-button type="primary" link :icon="EditPen" @click="openReceiptFill">
          申报记录回填回执号
        </el-button>
        <span class="receipt-fill-tip">通过扣缴客户端线下申报后，把税务局回执号回填到对应申报记录留痕</span>
      </div>
    </div>

    <!-- 回填回执号对话框 -->
    <el-dialog v-model="receiptDialog.visible" title="申报记录回填回执号" width="480px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
        适用场景：使用「扣缴申报导入文件」在自然人电子税务局（扣缴端）线下申报后，把税务局返回的回执号回填到平台申报记录，回填后该记录标记为「已申报落档」。
      </el-alert>
      <el-form label-position="top">
        <el-form-item label="申报记录ID">
          <el-input-number
            v-model="receiptDialog.declarationId"
            :min="1"
            :precision="0"
            controls-position="right"
            style="width: 200px"
          />
        </el-form-item>
        <el-form-item label="税务局回执号（4-40位）">
          <el-input v-model="receiptDialog.receiptNo" maxlength="40" placeholder="例如：SB202606120001" class="mono" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="receiptDialog.visible = false">取 消</el-button>
        <el-button
          type="primary"
          :loading="receiptDialog.submitting"
          :disabled="!receiptDialog.declarationId || receiptDialog.receiptNo.trim().length < 4"
          @click="submitReceiptFill"
        >
          确认回填
        </el-button>
      </template>
    </el-dialog>

    <!-- ② 季度涉税报送 -->
    <div class="panel block">
      <div class="block-head">
        <div class="block-title">季度涉税信息报送</div>
        <el-tooltip :content="canDeclare ? '' : '需要「税务申报」权限'" :disabled="canDeclare" placement="top">
          <span>
            <el-button
              type="primary"
              :disabled="!canDeclare || !overview || overview.quarterReported"
              :loading="reporting"
              @click="onQuarterReport"
            >
              {{ overview?.quarterReported ? '已报送' : '生成并报送' }}
            </el-button>
          </span>
        </el-tooltip>
      </div>
      <div class="quarter-row">
        <div class="quarter-badge">{{ overview?.quarter || '—' }}</div>
        <div class="quarter-desc">
          按《互联网平台企业涉税信息报送规定》，向税务机关报送本季度平台内从业人员身份与收入信息。
          下表按所得类型分类汇总（连续性劳务报酬 / 其他劳务报酬 / 经营所得），即报送口径预览。
        </div>
      </div>

      <!-- 季度报送按所得类型分类汇总（16/15号公告口径预览） -->
      <div v-loading="summaryLoading" class="summary-wrap">
        <el-table :data="quarterSummary?.byType || []" size="small" border class="summary-table">
          <el-table-column prop="label" label="所得类型" min-width="180">
            <template #default="{ row }">
              <el-tag :type="INCOME_TAG[row.incomeType] || 'info'" size="small" effect="light">{{ row.label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="people" label="人数" width="90" align="center" />
          <el-table-column prop="records" label="结算笔数" width="100" align="center" />
          <el-table-column label="收入额" align="right" min-width="120">
            <template #default="{ row }"><span class="money">{{ fmtMoney(row.gross) }}</span></template>
          </el-table-column>
          <el-table-column label="代扣个税" align="right" min-width="120">
            <template #default="{ row }"><span class="money">{{ fmtMoney(row.tax) }}</span></template>
          </el-table-column>
          <el-table-column label="代办增值税" align="right" min-width="120">
            <template #default="{ row }"><span class="money">{{ fmtMoney(row.vat) }}</span></template>
          </el-table-column>
          <template #empty>
            <el-empty :description="`${quarterSummary?.quarter || '本季度'}暂无计税记录`" :image-size="50" />
          </template>
        </el-table>
        <div v-if="quarterSummary?.byType?.length" class="summary-totals">
          <span class="totals-label">合计</span>
          <span class="totals-item">收入额 <b class="money">{{ fmtMoney(quarterSummary.totals.gross) }}</b></span>
          <span class="totals-item">代扣个税 <b class="money">{{ fmtMoney(quarterSummary.totals.tax) }}</b></span>
          <span class="totals-item">代办增值税 <b class="money">{{ fmtMoney(quarterSummary.totals.vat) }}</b></span>
        </div>
      </div>

      <el-alert
        v-if="quarterResult"
        type="success"
        show-icon
        :closable="false"
        class="receipt-alert"
        :title="`报送成功，文件号：${quarterResult.fileNo}，覆盖从业人员 ${quarterResult.workers} 人`"
      />
      <el-alert
        v-else-if="overview?.quarterReported"
        type="info"
        show-icon
        :closable="false"
        class="receipt-alert"
        title="本季度涉税信息已完成报送"
      />
    </div>

    <!-- ③ 平台初始报送(一次性) -->
    <div class="panel block">
      <div class="block-head">
        <div class="block-title">平台基本信息报送(一次性)</div>
        <el-tooltip
          v-if="!platformReported"
          :content="canDeclare ? '' : '需要「税务申报」权限'"
          :disabled="canDeclare"
          placement="top"
        >
          <span>
            <el-button
              type="primary"
              :disabled="!canDeclare"
              :loading="platformReporting"
              @click="onPlatformReport"
            >
              平台基本信息报送
            </el-button>
          </span>
        </el-tooltip>
        <el-tag v-else type="success" effect="plain">已完成报送</el-tag>
      </div>
      <div class="quarter-desc">
        平台上线 30 日内需向税务机关一次性报送平台企业的基本信息(名称、业务模式等),只需报送一次,重复点击不会重复报送。
      </div>
      <el-alert
        v-if="platformFileNo"
        type="success"
        show-icon
        :closable="false"
        class="receipt-alert"
        :title="`报送成功,文件号:${platformFileNo}`"
      />
      <el-alert
        v-else-if="platformReported"
        type="info"
        show-icon
        :closable="false"
        class="receipt-alert"
        title="平台基本信息此前已完成报送,无需再次操作"
      />
    </div>

    <!-- ④ 进项优化看板 -->
    <div v-loading="inputLoading" class="panel block">
      <div class="block-head">
        <div class="block-title">
          <el-tooltip
            placement="top"
            content="「进项」=平台可以拿来抵扣增值税的发票。零工里的个体工商户能给平台开发票,平台增值税就能少交;自然人零工开不了,所以个体户占比越高,平台税负越低"
          >
            <span class="term">进项</span>
          </el-tooltip>
          优化看板
        </div>
        <el-button :icon="Refresh" circle size="small" aria-label="刷新" @click="loadInputOverview" />
      </div>
      <template v-if="inputOverview">
        <el-row :gutter="16" class="input-stats">
          <el-col :xs="12" :sm="6">
            <div class="health-card">
              <div class="health-label">个体工商户零工</div>
              <div class="health-value">{{ inputOverview.soletraderCount }} 人</div>
              <div class="health-desc">能给平台开发票,带来进项</div>
            </div>
          </el-col>
          <el-col :xs="12" :sm="6">
            <div class="health-card">
              <div class="health-label">自然人零工</div>
              <div class="health-value">{{ inputOverview.personCount }} 人</div>
              <div class="health-desc">开不了发票,无进项可抵</div>
            </div>
          </el-col>
          <el-col :xs="12" :sm="6">
            <div class="health-card">
              <div class="health-label">个体户业务占比</div>
              <div class="health-value">{{ inputOverview.soletraderGrossRatio }}</div>
              <div class="health-desc">个体户分包款占全部分包款比例</div>
            </div>
          </el-col>
          <el-col :xs="12" :sm="6">
            <div class="input-compare">
              <div class="compare-row">
                <span class="compare-label">当前可得进项</span>
                <span class="money compare-now">{{ fmtMoney(inputOverview.currentInputDeduction) }}</span>
              </div>
              <div class="compare-row">
                <span class="compare-label">潜在进项(占比提至50%)</span>
                <span class="money compare-potential">{{ fmtMoney(inputOverview.potentialInputDeduction) }}</span>
              </div>
              <div class="compare-row compare-gap">
                <span class="compare-label">还差</span>
                <span class="money">{{ fmtMoney(inputGap) }}</span>
              </div>
            </div>
          </el-col>
        </el-row>

        <el-table :data="inputOverview.monthly" size="small" border class="input-monthly">
          <el-table-column prop="period" label="月份" width="110" />
          <el-table-column label="个体户分包款" align="right" min-width="130">
            <template #default="{ row }">
              <span class="money">{{ fmtMoney(row.soletraderGross) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="全部分包款" align="right" min-width="130">
            <template #default="{ row }">
              <span class="money">{{ fmtMoney(row.totalGross) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="ratio" label="个体户占比" width="110" align="center" />
          <template #empty>
            <el-empty description="近6个月暂无计税记录" :image-size="50" />
          </template>
        </el-table>

        <el-alert
          type="warning"
          :closable="false"
          show-icon
          class="receipt-alert"
          :title="inputOverview.suggestion"
        />
      </template>
    </div>

    <!-- ⑤ 税负健康度 -->
    <div class="panel block">
      <div class="block-head">
        <div class="block-title">税负健康度</div>
      </div>
      <el-row :gutter="16">
        <el-col v-for="m in healthMetrics" :key="m.label" :xs="24" :sm="8">
          <div class="health-card">
            <div class="health-label">{{ m.label }}</div>
            <div class="health-value">{{ m.value }}</div>
            <el-progress
              :percentage="m.percent"
              :color="m.color"
              :stroke-width="8"
              :show-text="false"
            />
            <div class="health-desc">{{ m.desc }}</div>
          </div>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Download, EditPen } from '@element-plus/icons-vue'
import { withStepUp } from '../utils/stepup'
import {
  getTaxOverview,
  declareTax,
  quarterReport,
  getQuarterSummary,
  getTaxInputOverview,
  platformReport,
  fillDeclarationReceipt
} from '../api/admin'
import { fmtMoney } from '../utils/format'
import { downloadCsv } from '../utils/download'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canDeclare = computed(() => auth.can('tax:declare'))

const loading = ref(false)
const exporting = ref(false)
const overview = ref(null)
const declaring = ref(false)
const reporting = ref(false)
const declareReceipt = ref('')
const quarterResult = ref(null)

// —— 季度报送按所得类型分类汇总 ——
const INCOME_TAG = { labor_continuous: 'success', labor_other: 'warning', business: 'primary' }
const summaryLoading = ref(false)
const quarterSummary = ref(null)

async function loadQuarterSummary() {
  summaryLoading.value = true
  try {
    quarterSummary.value = await getQuarterSummary()
  } catch {
    /* 错误已统一提示 */
  } finally {
    summaryLoading.value = false
  }
}

// —— 平台初始报送(一次性,无查询接口:点击后按结果/409 呈现完成态) ——
const platformReporting = ref(false)
const platformReported = ref(false)
const platformFileNo = ref('')

// —— 进项优化看板 ——
const inputLoading = ref(false)
const inputOverview = ref(null)

const inputGap = computed(() => {
  if (!inputOverview.value) return 0
  const gap =
    Number(inputOverview.value.potentialInputDeduction) - Number(inputOverview.value.currentInputDeduction)
  return gap > 0 ? gap : 0
})

const healthMetrics = computed(() => {
  const h = overview.value?.health || {}
  return [
    {
      label: '增值税税负率',
      value: h.vatBurdenRate || '0%',
      percent: pct(h.vatBurdenRate),
      color: '#6366f1',
      desc: '平台服务费收入对应的增值税税负占结算总额比例'
    },
    {
      label: '毛利率',
      value: h.grossMarginRate || '0%',
      percent: pct(h.grossMarginRate),
      color: '#10b981',
      desc: '平台服务费（发单价与分包价差额）占结算总额比例'
    },
    {
      label: '个体工商户经营所得占比',
      value: h.soletraderRatio || '0%',
      percent: pct(h.soletraderRatio),
      color: '#f59e0b',
      desc: '按经营所得计税的收入占全部计税收入比例，过高需关注转化合规性'
    }
  ]
})

function pct(rate) {
  const n = parseFloat(rate)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0
}

async function load() {
  loading.value = true
  try {
    overview.value = await getTaxOverview()
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

async function loadInputOverview() {
  inputLoading.value = true
  try {
    inputOverview.value = await getTaxInputOverview()
  } catch {
    /* 错误已统一提示 */
  } finally {
    inputLoading.value = false
  }
}

async function onPlatformReport() {
  try {
    await ElMessageBox.confirm(
      '将向税务机关一次性报送平台企业的基本信息（名称、业务模式等）。该报送仅需一次，提交后不可撤销。请确认。',
      '确认平台基本信息报送',
      { confirmButtonText: '确认报送', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  platformReporting.value = true
  try {
    const res = await platformReport()
    platformFileNo.value = res.fileNo
    platformReported.value = true
    ElMessage.success(`平台基本信息报送成功,文件号:${res.fileNo}`)
  } catch (err) {
    if (err?.response?.status === 409) {
      // 已报送过:呈现完成态即可
      platformReported.value = true
      ElMessage.info('平台基本信息此前已完成报送')
    } else {
      ElMessage.error(err?.response?.data?.error?.message || '报送失败,请稍后重试')
    }
  } finally {
    platformReporting.value = false
  }
}

async function onDeclare() {
  if (!overview.value) return
  try {
    await ElMessageBox.confirm(
      `将向税务机关批量申报缴款本所属期（${overview.value.period}）的代扣个人所得税与增值税，提交后不可撤销。请确认无误。`,
      '确认批量申报缴款',
      { confirmButtonText: '确认申报', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  declaring.value = true
  try {
    const res = await withStepUp(totp => declareTax(overview.value.period, totp))
    declareReceipt.value = res.receiptNo
    ElMessage.success(`申报成功，回执号：${res.receiptNo}`)
    await load()
  } catch {
    /* withStepUp 已提示错误；用户取消二次验证则静默 */
  } finally {
    declaring.value = false
  }
}

async function onQuarterReport() {
  if (!overview.value) return
  try {
    await ElMessageBox.confirm(
      `将按《互联网平台企业涉税信息报送规定》向税务机关报送本季度（${overview.value.quarter}）平台内从业人员的身份与收入信息，提交后不可撤销。请确认。`,
      '确认季度涉税信息报送',
      { confirmButtonText: '确认报送', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  reporting.value = true
  try {
    const res = await withStepUp(totp => quarterReport(overview.value.quarter, totp))
    quarterResult.value = res
    ElMessage.success(`报送成功，文件号：${res.fileNo}`)
    await load()
  } catch {
    /* withStepUp 已提示错误；用户取消二次验证则静默 */
  } finally {
    reporting.value = false
  }
}

// —— 扣缴申报导入文件(给自然人电子税务局扣缴端用的 CSV) ——
const declareFileExporting = ref(false)

async function onExportDeclareFile() {
  const period = overview.value?.period
  declareFileExporting.value = true
  try {
    await downloadCsv(
      `/admin/tax/declare-file${period ? `?period=${period}` : ''}`,
      `扣缴申报导入_${period || '当期'}.csv`
    )
    ElMessage.success('扣缴申报导入文件已下载，可导入扣缴客户端申报')
  } catch {
    /* 错误已统一提示 */
  } finally {
    declareFileExporting.value = false
  }
}

// —— 申报记录回填回执号 ——
const receiptDialog = reactive({
  visible: false,
  declarationId: null,
  receiptNo: '',
  submitting: false
})

function openReceiptFill() {
  receiptDialog.declarationId = null
  receiptDialog.receiptNo = ''
  receiptDialog.visible = true
}

async function submitReceiptFill() {
  receiptDialog.submitting = true
  try {
    await withStepUp(totp =>
      fillDeclarationReceipt(receiptDialog.declarationId, receiptDialog.receiptNo.trim(), totp)
    )
    receiptDialog.visible = false
    ElMessage.success('回执号已回填，申报记录已标记为已申报')
  } catch {
    /* withStepUp 已提示错误；用户取消二次验证则静默 */
  } finally {
    receiptDialog.submitting = false
  }
}

async function onExport() {
  const period = overview.value?.period
  exporting.value = true
  try {
    await downloadCsv(
      `/admin/tax/export${period ? `?period=${period}` : ''}`,
      `税务明细_${period || '当期'}.csv`
    )
    ElMessage.success('当期明细已导出')
  } catch {
    /* 错误已统一提示 */
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  load()
  loadInputOverview()
  loadQuarterSummary()
})
</script>

<style scoped>
.block {
  margin-bottom: 16px;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.block-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.amount-card {
  background: linear-gradient(135deg, #1e1b4b, #4338ca);
  border-radius: 10px;
  padding: 20px 22px;
  color: #fff;
}

.amount-label {
  font-size: 13px;
  color: #c7d2fe;
  margin-bottom: 8px;
}

.amount-value {
  font-size: 28px;
  font-weight: 800;
}

.receipt-alert {
  margin-top: 14px;
}

.receipt-fill-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.receipt-fill-tip {
  font-size: 12px;
  color: var(--text-3);
}

.quarter-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.quarter-badge {
  flex-shrink: 0;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 20px;
  font-weight: 800;
  border-radius: 10px;
  padding: 14px 22px;
  letter-spacing: 1px;
}

.quarter-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
}

.summary-wrap {
  margin-top: 14px;
}

.summary-totals {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 22px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--bg-soft, #f7f8fa);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-2);
}

.totals-label {
  font-weight: 700;
  color: var(--text-1);
}

.totals-item b {
  margin-left: 4px;
  color: var(--text-1);
}

.health-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px;
  height: 100%;
}

.health-label {
  font-size: 13px;
  color: var(--text-3);
}

.health-value {
  font-size: 24px;
  font-weight: 800;
  color: var(--text-1);
  margin: 8px 0 10px;
}

.health-desc {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.term {
  color: var(--accent);
  border-bottom: 1px dashed var(--accent);
  cursor: help;
}

.input-stats {
  margin-bottom: 14px;
}

.input-compare {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}

.compare-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.compare-label {
  color: var(--text-3);
  font-size: 12px;
}

.compare-now {
  font-weight: 700;
  color: var(--text-1);
}

.compare-potential {
  font-weight: 700;
  color: var(--accent);
}

.compare-gap {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  color: var(--warning);
}

.input-monthly {
  margin-bottom: 4px;
}

@media (max-width: 768px) {
  .amount-card,
  .health-card,
  .input-compare {
    margin-bottom: 12px;
  }
}
</style>
