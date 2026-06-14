<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">进项发票台账</h2>
        <p class="page-sub">个体工商户零工开给平台的发票认证与抵扣管理（影响平台增值税进项）</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
    </div>

    <div class="panel">
      <el-tabs v-model="status" @tab-change="load">
        <el-tab-pane label="待认证" name="uploaded" />
        <el-tab-pane label="已认证" name="verified" />
        <el-tab-pane label="已退回" name="rejected" />
        <el-tab-pane label="已抵扣" name="deducted" />
        <el-tab-pane label="全部" name="all" />
      </el-tabs>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="workerName" label="零工" min-width="100" />
        <el-table-column prop="taskTitle" label="任务" min-width="160" show-overflow-tooltip />
        <el-table-column label="发票号" min-width="160">
          <template #default="{ row }"><span class="mono">{{ row.invoiceNo }}</span></template>
        </el-table-column>
        <el-table-column label="类型" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.invoiceType === '专票' ? 'warning' : 'info'" size="small" effect="plain">
              {{ row.invoiceType }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="110" align="right">
          <template #default="{ row }"><span class="money">{{ fmtMoney(row.amount) }}</span></template>
        </el-table-column>
        <el-table-column label="税额" width="100" align="right">
          <template #default="{ row }"><span class="money">{{ fmtMoney(row.taxAmount) }}</span></template>
        </el-table-column>
        <el-table-column label="影像" width="90" align="center">
          <template #default="{ row }">
            <el-link v-if="row.fileUrl" type="primary" :href="row.fileUrl" target="_blank">查看</el-link>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="认证备注" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.verifyNote || '—' }}</template>
        </el-table-column>
        <el-table-column label="上传时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column v-if="canVerify" label="操作" width="190" fixed="right" align="center">
          <template #default="{ row }">
            <template v-if="row.status === 'uploaded'">
              <el-button type="primary" link size="small" @click="openVerify(row, 'verified')">认证通过</el-button>
              <el-button type="danger" link size="small" @click="openVerify(row, 'rejected')">退 回</el-button>
            </template>
            <el-button
              v-else-if="row.status === 'verified'"
              type="success"
              link
              size="small"
              @click="openVerify(row, 'deducted')"
            >
              已勾选抵扣
            </el-button>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无进项发票" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 认证操作对话框 -->
    <el-dialog v-model="dialog.visible" :title="actionTitle" width="480px" destroy-on-close>
      <el-alert
        v-if="dialog.row"
        :type="dialog.status === 'rejected' ? 'error' : 'success'"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
      >
        <template #title>
          {{ dialog.row.workerName }} · {{ dialog.row.invoiceType }} {{ dialog.row.invoiceNo }}
        </template>
        金额 {{ fmtMoney(dialog.row.amount) }}，税额 {{ fmtMoney(dialog.row.taxAmount) }}
      </el-alert>
      <el-form label-position="top">
        <el-form-item :label="dialog.status === 'rejected' ? '退回原因（必填，将通知零工重新开具）' : '备注（可选）'">
          <el-input
            v-model="dialog.note"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            :placeholder="notePlaceholder"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取 消</el-button>
        <el-button
          :type="dialog.status === 'rejected' ? 'danger' : 'primary'"
          :loading="dialog.submitting"
          @click="submit"
        >
          确 认
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getInputInvoices, verifyInputInvoice } from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canVerify = computed(() => auth.can('tax:declare'))

const status = ref('uploaded')
const loading = ref(false)
const list = ref([])

const STATUS_TEXT = { uploaded: '待认证', verified: '已认证', rejected: '已退回', deducted: '已抵扣' }

function statusText(s) {
  return STATUS_TEXT[s] || s
}

function statusTagType(s) {
  return { uploaded: 'warning', verified: 'primary', rejected: 'danger', deducted: 'success' }[s] || 'info'
}

async function load() {
  loading.value = true
  try {
    const data = await getInputInvoices({ status: status.value })
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

const dialog = reactive({ visible: false, row: null, status: 'verified', note: '', submitting: false })

const actionTitle = computed(
  () => ({ verified: '发票认证通过', rejected: '退回发票', deducted: '标记已勾选抵扣' })[dialog.status]
)

const notePlaceholder = computed(
  () =>
    ({
      verified: '例如：票面信息与结算单一致，认证相符',
      rejected: '例如：发票抬头与平台主体不符，请重新开具',
      deducted: '例如：已在增值税综合服务平台完成勾选确认'
    })[dialog.status]
)

function openVerify(row, status) {
  dialog.row = row
  dialog.status = status
  dialog.note = ''
  dialog.visible = true
}

async function submit() {
  if (dialog.status === 'rejected' && !dialog.note.trim()) {
    ElMessage.warning('退回时必须填写原因')
    return
  }
  dialog.submitting = true
  try {
    await verifyInputInvoice(dialog.row.id, { status: dialog.status, note: dialog.note.trim() })
    dialog.visible = false
    ElMessage.success(
      { verified: '已认证通过', rejected: '已退回，零工将收到重新开具通知', deducted: '已标记为勾选抵扣' }[dialog.status]
    )
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    dialog.submitting = false
  }
}

onMounted(load)
</script>

<style scoped>
.empty-dash {
  color: var(--text-3);
}
</style>
