<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">导出审批</h2>
        <p class="page-sub">含个人信息的批量导出须双人审批（PIPL），批准后 48 小时内限申请人下载</p>
      </div>
      <div class="page-actions">
        <el-button type="primary" :icon="Plus" @click="openApply">发起导出申请</el-button>
        <el-button :icon="Refresh" circle @click="load" />
      </div>
    </div>

    <div class="panel">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="申请号" width="80" align="center" />
        <el-table-column prop="applicantName" label="申请人" width="110" />
        <el-table-column prop="scope" label="导出范围" min-width="160" show-overflow-tooltip />
        <el-table-column prop="reason" label="事由" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small" :effect="row.status === 'pending' ? 'dark' : 'plain'">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="审批人/意见" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.approverName">{{ row.approverName }}{{ row.approveNote ? `：${row.approveNote}` : '' }}</span>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <el-table-column label="下载有效期至" width="160">
          <template #default="{ row }">{{ row.expiresAt ? fmtTime(row.expiresAt) : '—' }}</template>
        </el-table-column>
        <el-table-column label="申请时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right" align="center">
          <template #default="{ row }">
            <!-- 审批(不能审批自己的申请) -->
            <template v-if="row.status === 'pending' && canApprove && !isMine(row)">
              <el-button type="primary" link size="small" @click="openApprove(row, true)">批准</el-button>
              <el-button type="danger" link size="small" @click="openApprove(row, false)">拒绝</el-button>
            </template>
            <el-tooltip v-else-if="row.status === 'pending' && isMine(row)" content="不能审批自己的申请，请等待其他管理员审批" placement="top">
              <span class="pending-hint">待他人审批</span>
            </el-tooltip>
            <!-- 已批准:仅申请人可下载 -->
            <el-button
              v-else-if="['approved', 'downloaded'].includes(row.status) && isMine(row)"
              type="success"
              link
              size="small"
              :icon="Download"
              :loading="row.id === downloadingId"
              @click="onDownload(row)"
            >
              下 载
            </el-button>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无导出申请" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 发起申请 -->
    <el-dialog v-model="applyDialog.visible" title="发起导出申请" width="500px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 14px">
        导出文件含完整个人信息（如手机号），须经另一名有审批权限的管理员批准后方可下载，全程留痕审计。
      </el-alert>
      <el-form label-position="top">
        <el-form-item label="导出范围（必填）">
          <el-input v-model="applyDialog.scope" maxlength="200" placeholder="例如：全量零工名册（含完整手机号）" />
        </el-form-item>
        <el-form-item label="导出事由（必填，不少于5个字）">
          <el-input
            v-model="applyDialog.reason"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如：配合税务局专项核查，需提供从业人员名册"
          />
        </el-form-item>
        <el-form-item label="预计行数（可选）">
          <el-input-number v-model="applyDialog.rowEstimate" :min="1" :precision="0" controls-position="right" style="width: 180px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="applyDialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="applyDialog.submitting" @click="submitApply">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- 审批 -->
    <el-dialog
      v-model="approveDialog.visible"
      :title="approveDialog.pass ? '批准导出申请' : '拒绝导出申请'"
      width="480px"
      destroy-on-close
    >
      <el-alert
        v-if="approveDialog.row"
        :type="approveDialog.pass ? 'warning' : 'error'"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
      >
        <template #title>{{ approveDialog.row.applicantName }}：{{ approveDialog.row.scope }}</template>
        {{ approveDialog.row.reason }}
      </el-alert>
      <el-form label-position="top">
        <el-form-item :label="approveDialog.pass ? '审批意见（可选）' : '拒绝原因'">
          <el-input
            v-model="approveDialog.note"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            :placeholder="approveDialog.pass ? '例如：事由充分，同意导出' : '例如：事由不充分，请补充核查依据后重新申请'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveDialog.visible = false">取 消</el-button>
        <el-button
          :type="approveDialog.pass ? 'primary' : 'danger'"
          :loading="approveDialog.submitting"
          @click="submitApprove"
        >
          {{ approveDialog.pass ? '确认批准' : '确认拒绝' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Plus, Download } from '@element-plus/icons-vue'
import { applyExport, getExports, approveExport } from '../api/admin'
import { withStepUp } from '../utils/stepup'
import { fmtTime } from '../utils/format'
import { downloadCsv } from '../utils/download'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canApprove = computed(() => auth.can('export:approve'))

const loading = ref(false)
const list = ref([])
const downloadingId = ref(0)

const STATUS_TEXT = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  downloaded: '已下载',
  expired: '已失效'
}

function statusText(s) {
  return STATUS_TEXT[s] || s
}

function statusTagType(s) {
  return {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    downloaded: 'primary',
    expired: 'info'
  }[s] || 'info'
}

/** 是否本人的申请(服务端禁止自审,下载也仅限申请人) */
function isMine(row) {
  return row.applicantName === auth.user?.name
}

async function load() {
  loading.value = true
  try {
    const data = await getExports()
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// —— 发起申请 ——
const applyDialog = reactive({
  visible: false,
  scope: '',
  reason: '',
  rowEstimate: null,
  submitting: false
})

function openApply() {
  applyDialog.scope = '全量零工名册（含完整手机号）'
  applyDialog.reason = ''
  applyDialog.rowEstimate = null
  applyDialog.visible = true
}

async function submitApply() {
  if (applyDialog.scope.trim().length < 2) {
    ElMessage.warning('请填写导出范围')
    return
  }
  if (applyDialog.reason.trim().length < 5) {
    ElMessage.warning('导出事由不少于 5 个字')
    return
  }
  applyDialog.submitting = true
  try {
    const payload = { scope: applyDialog.scope.trim(), reason: applyDialog.reason.trim() }
    if (applyDialog.rowEstimate) payload.rowEstimate = applyDialog.rowEstimate
    await applyExport(payload)
    applyDialog.visible = false
    ElMessage.success('申请已提交，等待其他管理员审批')
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    applyDialog.submitting = false
  }
}

// —— 审批(step-up 二次验证) ——
const approveDialog = reactive({ visible: false, pass: true, note: '', row: null, submitting: false })

function openApprove(row, pass) {
  approveDialog.row = row
  approveDialog.pass = pass
  approveDialog.note = ''
  approveDialog.visible = true
}

async function submitApprove() {
  approveDialog.submitting = true
  try {
    await withStepUp(totp =>
      approveExport(
        approveDialog.row.id,
        { pass: approveDialog.pass, note: approveDialog.note.trim() },
        totp
      )
    )
    approveDialog.visible = false
    ElMessage.success(approveDialog.pass ? '已批准，申请人可在 48 小时内下载' : '已拒绝该申请')
    load()
  } catch {
    /* 错误已统一提示/用户取消 */
  } finally {
    approveDialog.submitting = false
  }
}

async function onDownload(row) {
  downloadingId.value = row.id
  try {
    await downloadCsv(`/admin/exports/${row.id}/download`, `导出_${row.id}_${row.scope.slice(0, 10)}.csv`)
    ElMessage.success('已下载（文件含审计水印）')
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    downloadingId.value = 0
  }
}

onMounted(load)
</script>

<style scoped>
.empty-dash {
  color: var(--text-3);
}

.pending-hint {
  font-size: 12px;
  color: var(--text-3);
}
</style>
