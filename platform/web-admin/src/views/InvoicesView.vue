<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">发票管理</h2>
        <p class="page-sub">平台给企业开出的全部发票,开错了可在这里
          <el-tooltip placement="top" content="「红冲」就是把开错的发票作废冲销:原发票失效,需要时再重新开一张正确的">
            <span class="term">红冲</span>
          </el-tooltip>
          作废
        </p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
    </div>

    <div class="panel">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column label="发票号" min-width="170">
          <template #default="{ row }">
            <span class="mono">{{ row.no }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="companyName" label="购买方企业" min-width="190" show-overflow-tooltip />
        <el-table-column prop="taskTitle" label="对应任务" min-width="180" show-overflow-tooltip />
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }">
            <span class="money">{{ fmtMoney(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="税率" width="80" align="center">
          <template #default="{ row }">{{ row.taxRate || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="invoiceStatusTag(row.status)" size="small">
              {{ invoiceStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="收入确认单" min-width="160">
          <template #default="{ row }">
            <el-tooltip placement="top" content="开票前生成的收入确认单编号,证明这笔发票对应真实结算业务">
              <span class="mono confirm-no">{{ row.confirmNo || '—' }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="开票日期" width="150">
          <template #default="{ row }">{{ fmtTime(row.issuedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'issued'">
              <el-button v-if="canVoid" type="danger" link size="small" @click="openVoid(row)">红 冲</el-button>
              <el-tooltip v-else content="需要「税务申报与报送」权限(tax:declare)" placement="top">
                <span>
                  <el-button type="danger" link size="small" disabled>红 冲</el-button>
                </span>
              </el-tooltip>
            </template>
            <template v-else-if="row.status === 'voided'">
              <el-button v-if="canVoid" type="primary" link size="small" @click="onReissue(row)">重 开</el-button>
              <span v-else class="voided-text">已作废</span>
            </template>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="90">
            <template #description>
              <p>暂无发票</p>
              <p class="empty-guide">企业在企业端对已结算任务申请开票后,发票会出现在这里</p>
            </template>
          </el-empty>
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

    <!-- 红冲对话框 -->
    <el-dialog v-model="dialog.visible" title="发票红冲" width="480px" destroy-on-close>
      <el-alert type="error" :closable="false" show-icon style="margin-bottom: 14px">
        <template #title>红冲后原发票立即作废,操作不可撤销</template>
        红冲结果会站内通知该企业;如企业仍需发票,请其重新申请开具。
      </el-alert>
      <el-descriptions v-if="dialog.invoice" :column="1" border size="small" style="margin-bottom: 14px">
        <el-descriptions-item label="发票号">
          <span class="mono">{{ dialog.invoice.no }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="企业">{{ dialog.invoice.companyName }}</el-descriptions-item>
        <el-descriptions-item label="金额">{{ fmtMoney(dialog.invoice.amount) }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-position="top">
        <el-form-item label="红冲原因(必填,会通知企业)" required>
          <el-input
            v-model="dialog.reason"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="例如:发票抬头有误 / 金额开具错误 / 企业申请作废重开"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取 消</el-button>
        <el-button type="danger" :loading="dialog.submitting" @click="submitVoid">确认红冲</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getInvoices, voidInvoice, reissueInvoice } from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'
import { withStepUp } from '../utils/stepup'

const auth = useAuthStore()
const canVoid = computed(() => auth.can('tax:declare'))

// 发票状态：issuing 开具中（异步开票）/ issued 已开具 / voided 已红冲
const INVOICE_STATUS = {
  issuing: { label: '开具中', tag: 'warning' },
  issued: { label: '已开具', tag: 'success' },
  voided: { label: '已红冲', tag: 'danger' }
}
function invoiceStatusText(s) {
  return INVOICE_STATUS[s]?.label || s
}
function invoiceStatusTag(s) {
  return INVOICE_STATUS[s]?.tag || 'info'
}

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const dialog = reactive({ visible: false, invoice: null, reason: '', submitting: false })

async function load() {
  loading.value = true
  try {
    const data = await getInvoices({ page: page.value, pageSize: pageSize.value })
    list.value = data.list
    total.value = data.total
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

function openVoid(invoice) {
  dialog.invoice = invoice
  dialog.reason = ''
  dialog.visible = true
}

async function submitVoid() {
  const reason = dialog.reason.trim()
  if (reason.length < 2) {
    ElMessage.warning('请填写红冲原因(至少 2 个字)')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定红冲发票 ${dialog.invoice.no}(${fmtMoney(dialog.invoice.amount)})吗?红冲后原发票作废,系统会站内通知「${dialog.invoice.companyName}」。`,
      '红冲最终确认',
      { type: 'warning', confirmButtonText: '确认红冲', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  dialog.submitting = true
  try {
    await withStepUp(totp => voidInvoice(dialog.invoice.id, reason, totp))
    dialog.visible = false
    ElMessage.success('发票已红冲,企业已收到通知')
    load()
  } catch {
    /* 错误已统一提示（含动态码校验失败） */
  } finally {
    dialog.submitting = false
  }
}

async function onReissue(row) {
  try {
    await ElMessageBox.confirm(
      `确定为已红冲的发票 ${row.no}（${fmtMoney(row.amount)}）重新开具一张正确发票吗？将关联原发票留痕。`,
      '红冲重开确认',
      { type: 'warning', confirmButtonText: '确认重开', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    const r = await withStepUp(totp => reissueInvoice(row.id, totp))
    ElMessage.success(`已重开发票 ${r.no}`)
    load()
  } catch {
    /* 错误已统一提示/用户取消 */
  }
}

onMounted(load)
</script>

<style scoped>
.term {
  color: var(--accent);
  border-bottom: 1px dashed var(--accent);
  cursor: help;
}

.confirm-no {
  font-size: 12px;
  color: var(--text-2);
}

.voided-text {
  font-size: 12px;
  color: var(--text-3);
}

.empty-dash {
  color: var(--text-3);
}

.empty-guide {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
