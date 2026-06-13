<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">技能认证审核</h2>
        <p class="page-sub">核验零工上传的技能证书，通过后在任务大厅展示认证徽章</p>
      </div>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <div class="panel">
      <el-tabs v-model="status" @tab-change="load">
        <el-tab-pane label="待审核" name="pending" />
        <el-tab-pane label="已通过" name="verified" />
        <el-tab-pane label="已拒绝" name="rejected" />
        <el-tab-pane label="全部" name="all" />
      </el-tabs>

      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" align="center" />
        <el-table-column prop="workerName" label="零工" min-width="110" />
        <el-table-column prop="skill" label="技能" min-width="140" />
        <el-table-column label="等级" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="warning">{{ row.level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="证书附件" width="120" align="center">
          <template #default="{ row }">
            <el-link v-if="row.certUrl" type="primary" :href="row.certUrl" target="_blank">
              查看证书
            </el-link>
            <span v-else class="empty-dash">未上传</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="审核意见" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">{{ row.verifyNote || '—' }}</template>
        </el-table-column>
        <el-table-column label="申请时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right" align="center">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button type="primary" link size="small" @click="openReview(row, true)">通过</el-button>
              <el-button type="danger" link size="small" @click="openReview(row, false)">拒绝</el-button>
            </template>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无认证申请" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 审核对话框 -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.pass ? '认证审核·通过' : '认证审核·拒绝'"
      width="480px"
      destroy-on-close
    >
      <el-alert
        v-if="dialog.row"
        :type="dialog.pass ? 'success' : 'error'"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
      >
        <template #title>{{ dialog.row.workerName }}：{{ dialog.row.skill }}（{{ dialog.row.level }}）</template>
        {{ dialog.pass ? '通过后该技能徽章将在任务大厅与零工主页展示。' : '拒绝后零工可补充材料重新申请，请填写原因。' }}
      </el-alert>
      <el-form label-position="top">
        <el-form-item :label="dialog.pass ? '审核意见（可选）' : '拒绝原因（必填）'">
          <el-input
            v-model="dialog.note"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            :placeholder="dialog.pass ? '例如：证书核验真实有效' : '例如：证书图片模糊无法核验，请重新上传清晰版本'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取 消</el-button>
        <el-button :type="dialog.pass ? 'primary' : 'danger'" :loading="dialog.submitting" @click="submitReview">
          {{ dialog.pass ? '确认通过' : '确认拒绝' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getSkills, reviewSkill } from '../api/admin'
import { fmtTime } from '../utils/format'

const status = ref('pending')
const loading = ref(false)
const list = ref([])

function statusText(s) {
  return { pending: '待审核', verified: '已通过', rejected: '已拒绝' }[s] || s
}

function statusTagType(s) {
  return { pending: 'warning', verified: 'success', rejected: 'danger' }[s] || 'info'
}

async function load() {
  loading.value = true
  try {
    const data = await getSkills({ status: status.value })
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

const dialog = reactive({ visible: false, pass: true, note: '', row: null, submitting: false })

function openReview(row, pass) {
  dialog.row = row
  dialog.pass = pass
  dialog.note = ''
  dialog.visible = true
}

async function submitReview() {
  if (!dialog.pass && !dialog.note.trim()) {
    ElMessage.warning('拒绝时必须填写原因')
    return
  }
  dialog.submitting = true
  try {
    await reviewSkill(dialog.row.id, { pass: dialog.pass, note: dialog.note.trim() })
    dialog.visible = false
    ElMessage.success(dialog.pass ? '已通过认证，零工将收到通知' : '已拒绝该认证申请')
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
