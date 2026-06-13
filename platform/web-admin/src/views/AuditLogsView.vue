<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">审计日志</h2>
        <p class="page-sub">全平台关键操作留痕,可按动作类型筛选追溯</p>
      </div>
      <div class="page-actions">
        <el-select
          v-model="action"
          placeholder="按动作筛选(可手输)"
          clearable
          filterable
          allow-create
          default-first-option
          style="width: 220px"
          @change="onFilter"
        >
          <el-option
            v-for="a in ACTIONS"
            :key="a.value"
            :label="`${a.label}(${a.value})`"
            :value="a.value"
          />
        </el-select>
        <el-button :icon="Refresh" circle @click="load" />
      </div>
    </div>

    <div class="panel">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" align="center" />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作人" min-width="150">
          <template #default="{ row }">
            <span>{{ row.userName || `用户#${row.userId}` }}</span>
            <el-tag size="small" effect="plain" :type="roleTagType(row.userRole)" style="margin-left: 6px">
              {{ roleText(row.userRole) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="180">
          <template #default="{ row }">
            <el-tag size="small" :type="actionTagType(row.action)" effect="plain">
              {{ actionText(row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="320" show-overflow-tooltip>
          <template #default="{ row }">{{ row.detail || '—' }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无审计日志" :image-size="90" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
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
import { Refresh } from '@element-plus/icons-vue'
import { getAuditLogs } from '../api/admin'
import { fmtTime } from '../utils/format'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const action = ref('')

const ACTIONS = [
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
  { value: 'task_publish', label: '发布任务' },
  { value: 'task_accept', label: '验收任务' },
  { value: 'task_cancel', label: '取消任务' },
  { value: 'review_company', label: '企业审核' },
  { value: 'risk_resolve', label: '风控处置' },
  { value: 'tax_declare', label: '税务申报' },
  { value: 'tax_quarter_report', label: '季度报送' },
  { value: 'config_update', label: '配置变更' },
  { value: 'worker_lock', label: '零工锁定' },
  { value: 'admin_user_create', label: '创建账号' },
  { value: 'admin_user_role', label: '调整角色' },
  { value: 'user_disable', label: '停用账号' },
  { value: 'user_enable', label: '启用账号' },
  { value: 'user_reset_password', label: '重置密码' },
  { value: 'change_password', label: '修改密码' }
]

const ACTION_TEXT = Object.fromEntries(ACTIONS.map(a => [a.value, a.label]))

function actionText(a) {
  return ACTION_TEXT[a] || a
}

function actionTagType(a) {
  if (['config_update', 'admin_user_role', 'worker_lock'].includes(a)) return 'warning'
  if (['user_disable', 'task_cancel'].includes(a)) return 'danger'
  if (['tax_declare', 'tax_quarter_report', 'review_company'].includes(a)) return 'success'
  if (['login', 'register'].includes(a)) return 'info'
  return 'primary'
}

function roleText(role) {
  return { admin: '运营', company: '企业', worker: '零工' }[role] || role || '—'
}

function roleTagType(role) {
  return { admin: 'primary', company: 'warning', worker: 'success' }[role] || 'info'
}

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (action.value) params.action = action.value
    const data = await getAuditLogs(params)
    list.value = data.list
    total.value = data.total
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

function onFilter() {
  page.value = 1
  load()
}

function onSizeChange() {
  page.value = 1
  load()
}

onMounted(load)
</script>
