<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">客服工单</h2>
        <p class="page-sub">零工/企业的咨询与投诉受理，紧急工单自动置顶</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
    </div>

    <div class="panel">
      <div class="filter-bar">
        <el-radio-group v-model="status" @change="load">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="open">待受理</el-radio-button>
          <el-radio-button value="pending_agent">待客服跟进</el-radio-button>
          <el-radio-button value="pending_user">待用户补充</el-radio-button>
          <el-radio-button value="resolved">已办结</el-radio-button>
          <el-radio-button value="closed">已关闭</el-radio-button>
        </el-radio-group>
        <el-select v-model="category" style="width: 150px" @change="load">
          <el-option label="全部分类" value="all" />
          <el-option
            v-for="(text, key) in CATEGORY_TEXT"
            :key="key"
            :label="text"
            :value="key"
          />
        </el-select>
      </div>

      <el-table v-loading="loading" :data="list" stripe :row-class-name="rowClass">
        <el-table-column label="工单号" min-width="140">
          <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
        </el-table-column>
        <el-table-column label="优先级" width="90" align="center">
          <template #default="{ row }">
            <el-tag
              :type="priorityTagType(row.priority)"
              size="small"
              :effect="row.priority === 'urgent' ? 'dark' : 'plain'"
            >
              {{ priorityText(row.priority) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.title }}
            <el-tag v-if="row.escalated" type="danger" size="small" effect="plain">已升级</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="90" align="center">
          <template #default="{ row }">{{ categoryText(row.category) }}</template>
        </el-table-column>
        <el-table-column label="提单人" min-width="120">
          <template #default="{ row }">
            {{ row.userName }}
            <el-tag size="small" effect="plain" :type="row.userRole === 'worker' ? 'primary' : 'warning'">
              {{ row.userRole === 'worker' ? '零工' : '企业' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="受理人" width="100">
          <template #default="{ row }">{{ row.assigneeName || '—' }}</template>
        </el-table-column>
        <el-table-column label="满意度" width="80" align="center">
          <template #default="{ row }">{{ row.satisfaction ? `${row.satisfaction} 分` : '—' }}</template>
        </el-table-column>
        <el-table-column label="提单时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row.id)">处理</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无工单" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 工单详情抽屉 -->
    <el-drawer v-model="drawer.visible" title="工单详情" size="640px" destroy-on-close>
      <div v-loading="drawer.loading" class="detail-body">
        <template v-if="drawer.data">
          <!-- 用户信息与关联单据 -->
          <div class="detail-section">
            <div class="detail-section-title">工单信息</div>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="工单号">
                <span class="mono">{{ drawer.data.no }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="优先级">
                <el-tag :type="priorityTagType(drawer.data.priority)" size="small">
                  {{ priorityText(drawer.data.priority) }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="提单人">
                {{ drawer.data.userName }}（{{ drawer.data.userRole === 'worker' ? '零工' : '企业' }}）
              </el-descriptions-item>
              <el-descriptions-item label="联系电话">
                <span class="mono">{{ drawer.data.userPhone }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="分类">{{ categoryText(drawer.data.category) }}</el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag :type="statusTagType(drawer.data.status)" size="small">
                  {{ statusText(drawer.data.status) }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="关联单据" :span="2">
                <span v-if="drawer.data.refType" class="mono">
                  {{ refTypeText(drawer.data.refType) }} #{{ drawer.data.refId }}
                </span>
                <span v-else>—</span>
              </el-descriptions-item>
              <el-descriptions-item label="标题" :span="2">{{ drawer.data.title }}</el-descriptions-item>
            </el-descriptions>
          </div>

          <!-- 分派 -->
          <div v-if="canManage && !isDone" class="detail-section">
            <div class="detail-section-title">分派受理人</div>
            <div class="assign-row">
              <el-select
                v-model="assignForm.assigneeId"
                filterable
                placeholder="选择运营同事"
                style="width: 240px"
              >
                <el-option v-for="u in admins" :key="u.id" :label="`${u.name}（${u.roleName || '运营'}）`" :value="u.id" />
              </el-select>
              <el-button :loading="assignForm.submitting" :disabled="!assignForm.assigneeId" @click="onAssign">
                分 派
              </el-button>
            </div>
          </div>

          <!-- 对话流 -->
          <div class="detail-section">
            <div class="detail-section-title">对话记录</div>
            <el-empty v-if="!drawer.data.messages.length" description="暂无对话" :image-size="50" />
            <div
              v-for="m in drawer.data.messages"
              :key="m.id"
              class="msg-item"
              :class="m.sender === 'agent' ? 'msg-agent' : 'msg-user'"
            >
              <div class="msg-meta">
                <el-tag size="small" :type="m.sender === 'agent' ? 'success' : 'primary'" effect="plain">
                  {{ m.sender === 'agent' ? '客服' : '用户' }}
                </el-tag>
                <span class="msg-time">{{ fmtTime(m.createdAt) }}</span>
              </div>
              <div class="msg-bubble">{{ m.content }}</div>
              <div v-if="m.attachments?.length" class="msg-attachments">
                <el-link
                  v-for="(a, ai) in m.attachments"
                  :key="a.id"
                  type="primary"
                  :href="a.url"
                  target="_blank"
                >
                  附件{{ ai + 1 }}
                </el-link>
              </div>
            </div>
          </div>

          <!-- 回复 -->
          <div v-if="canManage && drawer.data.status !== 'closed'" class="detail-section">
            <div class="detail-section-title">客服回复</div>
            <el-input
              v-model="replyForm.content"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-word-limit
              placeholder="回复后工单状态将变为「待用户补充」，用户会收到站内通知"
            />
            <div class="reply-actions">
              <el-button
                type="primary"
                :loading="replyForm.submitting"
                :disabled="!replyForm.content.trim()"
                @click="onReply"
              >
                发送回复
              </el-button>
              <el-button v-if="!isDone" type="success" plain :loading="resolving" @click="onResolve">
                办 结
              </el-button>
            </div>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button @click="drawer.visible = false">关 闭</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  getTickets,
  getTicketDetail,
  assignTicket,
  replyTicket,
  resolveTicket,
  getAdminUsers
} from '../api/admin'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canManage = computed(() => auth.can('ticket:manage'))

const status = ref('all')
const category = ref('all')
const loading = ref(false)
const list = ref([])

const CATEGORY_TEXT = {
  account: '账号',
  realname: '实名',
  settlement: '结算',
  withdraw: '提现',
  invoice: '发票',
  tax: '税务',
  insurance: '保险',
  complaint: '投诉',
  other: '其他'
}

const STATUS_TEXT = {
  open: '待受理',
  pending_user: '待用户补充',
  pending_agent: '待客服跟进',
  resolved: '已办结',
  closed: '已关闭'
}

function categoryText(c) {
  return CATEGORY_TEXT[c] || c
}

function statusText(s) {
  return STATUS_TEXT[s] || s
}

function statusTagType(s) {
  return {
    open: 'danger',
    pending_agent: 'warning',
    pending_user: 'primary',
    resolved: 'success',
    closed: 'info'
  }[s] || 'info'
}

function priorityText(p) {
  return { urgent: '紧急', high: '高', normal: '普通' }[p] || p
}

function priorityTagType(p) {
  return { urgent: 'danger', high: 'warning', normal: 'info' }[p] || 'info'
}

function refTypeText(t) {
  return {
    task: '任务',
    settlement: '结算单',
    withdrawal: '提现单',
    invoice: '发票',
    dispute: '争议单'
  }[t] || t
}

// 紧急工单整行标红(服务端已按优先级置顶排序)
function rowClass({ row }) {
  return row.priority === 'urgent' && !['resolved', 'closed'].includes(row.status) ? 'row-urgent' : ''
}

async function load() {
  loading.value = true
  try {
    const data = await getTickets({ status: status.value, category: category.value })
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// —— 详情抽屉 ——
const drawer = reactive({ visible: false, loading: false, data: null })
const replyForm = reactive({ content: '', submitting: false })
const assignForm = reactive({ assigneeId: null, submitting: false })
const resolving = ref(false)
const admins = ref([])
const adminsLoaded = ref(false)

const isDone = computed(() => ['resolved', 'closed'].includes(drawer.data?.status))

async function loadAdmins() {
  // 分派下拉取运营列表(需 user:read 权限,无权限时下拉留空)
  if (adminsLoaded.value || !canManage.value || !auth.can('user:read')) return
  try {
    const data = await getAdminUsers({ page: 1, pageSize: 100 })
    admins.value = (data.list || []).filter(u => u.status === 'active')
    adminsLoaded.value = true
  } catch {
    /* 错误已统一提示 */
  }
}

async function openDetail(id) {
  drawer.visible = true
  drawer.loading = true
  drawer.data = null
  replyForm.content = ''
  assignForm.assigneeId = null
  try {
    drawer.data = await getTicketDetail(id)
    assignForm.assigneeId = drawer.data.assigneeId || null
    loadAdmins()
  } catch {
    drawer.visible = false
  } finally {
    drawer.loading = false
  }
}

async function refreshDetail() {
  const id = drawer.data.id
  await Promise.all([load(), openDetail(id)])
}

async function onAssign() {
  assignForm.submitting = true
  try {
    await assignTicket(drawer.data.id, assignForm.assigneeId)
    ElMessage.success('已分派，受理人将收到站内通知')
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    assignForm.submitting = false
  }
}

async function onReply() {
  replyForm.submitting = true
  try {
    await replyTicket(drawer.data.id, replyForm.content.trim())
    ElMessage.success('回复已发送')
    replyForm.content = ''
    await refreshDetail()
  } catch {
    /* 错误已统一提示 */
  } finally {
    replyForm.submitting = false
  }
}

async function onResolve() {
  let note = ''
  try {
    const { value } = await ElMessageBox.prompt(
      '办结说明（可选，将作为最后一条客服回复同步给用户）',
      '办结工单',
      {
        confirmButtonText: '确认办结',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '例如：已为用户重新触发提现，款项预计 T+1 到账'
      }
    )
    note = (value || '').trim()
  } catch {
    return
  }
  resolving.value = true
  try {
    await resolveTicket(drawer.data.id, note)
    ElMessage.success('工单已办结')
    await refreshDetail()
  } catch {
    /* 错误已统一提示 */
  } finally {
    resolving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

:deep(.el-table .row-urgent) {
  --el-table-tr-bg-color: rgba(239, 68, 68, 0.08);
}

.detail-body {
  min-height: 200px;
}

.detail-section {
  margin-bottom: 22px;
}

.detail-section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 10px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
}

.assign-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.msg-item {
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
}

.msg-item.msg-agent {
  align-items: flex-end;
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.msg-time {
  font-size: 12px;
  color: var(--text-3);
}

.msg-bubble {
  max-width: 85%;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
  background: var(--bg-hover);
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-agent .msg-bubble {
  background: var(--accent-weak);
}

.msg-attachments {
  margin-top: 4px;
  display: flex;
  gap: 10px;
}

.reply-actions {
  margin-top: 10px;
  display: flex;
  gap: 10px;
}
</style>
