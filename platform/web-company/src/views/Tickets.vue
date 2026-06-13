<template>
  <div class="page-card">
    <PageHeader title="客服工单" subtitle="提现/结算类问题自动升级为紧急工单（2 小时内首响），办结后可评价满意度">
      <template #actions>
        <el-button :icon="Refresh" @click="fetchList">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建工单</el-button>
      </template>
    </PageHeader>

    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column prop="no" label="工单号" width="180">
        <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
      </el-table-column>
      <el-table-column label="分类" width="110" align="center">
        <template #default="{ row }">
          <el-tag effect="plain" size="small">{{ TICKET_CATEGORY[row.category] || row.category }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="问题标题" min-width="200" show-overflow-tooltip />
      <el-table-column label="优先级" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="priorityMeta(row.priority).tag" effect="light" size="small">
            {{ priorityMeta(row.priority).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="statusMeta(row.status).tag" effect="light" size="small">
            {{ statusMeta(row.status).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="满意度" width="130" align="center">
        <template #default="{ row }">
          <el-rate v-if="row.satisfaction" :model-value="row.satisfaction" disabled size="small" />
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="80" fixed="right" align="center">
        <template #default="{ row }">
          <el-button type="primary" link @click="openDetail(row.id)">详情</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无工单">
          <el-button type="primary" @click="openCreate">提交第一个工单</el-button>
        </el-empty>
      </template>
    </el-table>

    <!-- 新建工单 -->
    <el-dialog v-model="createVisible" title="新建工单" width="560px" destroy-on-close>
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="90px">
        <el-form-item label="问题分类" prop="category">
          <el-select v-model="createForm.category" placeholder="请选择问题分类" style="width: 240px">
            <el-option v-for="(label, key) in TICKET_CATEGORY" :key="key" :label="label" :value="key" />
          </el-select>
        </el-form-item>
        <el-form-item label="问题标题" prop="title">
          <el-input v-model="createForm.title" maxlength="80" show-word-limit placeholder="一句话描述问题" />
        </el-form-item>
        <el-form-item label="问题描述" prop="content">
          <el-input
            v-model="createForm.content"
            type="textarea"
            :rows="5"
            maxlength="2000"
            show-word-limit
            placeholder="请详细描述问题发生的场景、操作步骤与期望结果"
          />
        </el-form-item>
        <el-form-item label="关联单据">
          <el-select v-model="createForm.refType" placeholder="单据类型（可选）" clearable style="width: 150px">
            <el-option v-for="(label, key) in REF_TYPE" :key="key" :label="label" :value="key" />
          </el-select>
          <el-input-number
            v-model="createForm.refId"
            :min="1"
            :precision="0"
            :controls="false"
            :disabled="!createForm.refType"
            style="width: 130px; margin-left: 10px"
            placeholder="单据 ID"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="onCreate">提交工单</el-button>
      </template>
    </el-dialog>

    <!-- 工单详情抽屉 -->
    <el-drawer v-model="drawerVisible" :title="detail ? `工单 ${detail.no}` : '工单详情'" size="560px" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="状态">
              <el-tag :type="statusMeta(detail.status).tag" effect="light" size="small">
                {{ statusMeta(detail.status).label }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="优先级">
              <el-tag :type="priorityMeta(detail.priority).tag" effect="light" size="small">
                {{ priorityMeta(detail.priority).label }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="分类">{{ TICKET_CATEGORY[detail.category] || detail.category }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">{{ fmtDateTime(detail.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="标题" :span="2">{{ detail.title }}</el-descriptions-item>
            <el-descriptions-item v-if="detail.refType" label="关联单据" :span="2">
              {{ REF_TYPE[detail.refType] || detail.refType }} #{{ detail.refId }}
            </el-descriptions-item>
          </el-descriptions>

          <!-- 对话流 -->
          <div class="section-title">沟通记录（{{ detail.messages?.length || 0 }}）</div>
          <div class="msg-list">
            <div
              v-for="m in detail.messages"
              :key="m.id"
              class="msg-item"
              :class="{ mine: m.sender === 'user', system: m.sender === 'system' }"
            >
              <template v-if="m.sender === 'system'">
                <div class="msg-system">{{ m.content }} · {{ fmtDateTime(m.createdAt) }}</div>
              </template>
              <template v-else>
                <div class="msg-meta">
                  {{ m.sender === 'user' ? '我' : '客服' }} · {{ fmtDateTime(m.createdAt) }}
                </div>
                <div class="msg-bubble pre-wrap">{{ m.content }}</div>
              </template>
            </div>
          </div>

          <!-- 追加回复 -->
          <template v-if="!isDone">
            <div class="section-title">追加回复</div>
            <el-input
              v-model="replyContent"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-word-limit
              placeholder="补充信息或回复客服"
            />
            <div class="action-bar">
              <el-button type="primary" :loading="replying" @click="onReply">发送回复</el-button>
              <el-button type="warning" plain @click="onClose">问题已解决，关闭工单</el-button>
            </div>
          </template>

          <!-- 满意度评价 -->
          <template v-if="isDone">
            <div class="section-title">满意度评价</div>
            <div v-if="detail.satisfaction" class="rate-done">
              <el-rate :model-value="detail.satisfaction" disabled />
              <span class="rate-tip">感谢您的评价</span>
            </div>
            <div v-else class="rate-bar">
              <el-rate v-model="satisfaction" />
              <el-button type="primary" size="small" :disabled="!satisfaction" :loading="rating" @click="onRate">
                提交评价
              </el-button>
            </div>
          </template>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import { createTicket, getTickets, getTicketDetail, addTicketMessage, closeTicket, rateTicket } from '../api/me'
import { fmtDateTime, TICKET_CATEGORY, TICKET_STATUS, TICKET_PRIORITY } from '../utils/format'

const REF_TYPE = {
  task: '任务',
  withdrawal: '提现单',
  invoice: '发票',
  settlement: '结算单',
  dispute: '争议单'
}

const list = ref([])
const loading = ref(false)

const createVisible = ref(false)
const createFormRef = ref()
const creating = ref(false)
const createForm = reactive({ category: '', title: '', content: '', refType: '', refId: undefined })

const createRules = {
  category: [{ required: true, message: '请选择问题分类', trigger: 'change' }],
  title: [
    { required: true, message: '请输入问题标题', trigger: 'blur' },
    { min: 2, max: 80, message: '标题长度应为 2 至 80 个字符', trigger: 'blur' }
  ],
  content: [
    { required: true, message: '请输入问题描述', trigger: 'blur' },
    { min: 5, max: 2000, message: '问题描述至少 5 个字符', trigger: 'blur' }
  ]
}

const drawerVisible = ref(false)
const detailLoading = ref(false)
const detail = ref(null)
const replyContent = ref('')
const replying = ref(false)
const satisfaction = ref(0)
const rating = ref(false)

const statusMeta = s => TICKET_STATUS[s] || { label: s || '—', tag: 'info' }
const priorityMeta = p => TICKET_PRIORITY[p] || { label: p || '—', tag: 'info' }
const isDone = computed(() => ['resolved', 'closed'].includes(detail.value?.status))

async function fetchList() {
  loading.value = true
  try {
    const data = await getTickets()
    list.value = data.list || []
  } finally {
    loading.value = false
  }
}

function openCreate() {
  createForm.category = ''
  createForm.title = ''
  createForm.content = ''
  createForm.refType = ''
  createForm.refId = undefined
  createVisible.value = true
}

async function onCreate() {
  try {
    await createFormRef.value.validate()
  } catch {
    return
  }
  creating.value = true
  try {
    const res = await createTicket({
      category: createForm.category,
      title: createForm.title.trim(),
      content: createForm.content.trim(),
      refType: createForm.refType || undefined,
      refId: createForm.refType && createForm.refId ? createForm.refId : undefined
    })
    ElMessage.success(
      res.priority === 'urgent'
        ? `工单 ${res.no} 已提交（紧急），客服将在 2 小时内首次响应`
        : `工单 ${res.no} 已提交，客服会尽快处理，进展将通过站内通知告知`
    )
    createVisible.value = false
    fetchList()
  } catch {
    // 错误已由拦截器提示
  } finally {
    creating.value = false
  }
}

async function openDetail(id) {
  drawerVisible.value = true
  detailLoading.value = true
  detail.value = null
  replyContent.value = ''
  satisfaction.value = 0
  try {
    detail.value = await getTicketDetail(id)
  } finally {
    detailLoading.value = false
  }
}

async function refreshDetail() {
  if (detail.value?.id) {
    detail.value = await getTicketDetail(detail.value.id)
  }
  fetchList()
}

async function onReply() {
  if (!replyContent.value.trim()) {
    ElMessage.warning('请填写回复内容')
    return
  }
  replying.value = true
  try {
    await addTicketMessage(detail.value.id, replyContent.value.trim())
    ElMessage.success('回复已发送')
    replyContent.value = ''
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  } finally {
    replying.value = false
  }
}

async function onClose() {
  try {
    await ElMessageBox.confirm('关闭后该工单不可再回复，如有新问题需重新提交工单。是否继续？', '关闭工单', {
      confirmButtonText: '继续关闭',
      cancelButtonText: '再想想',
      type: 'warning'
    })
  } catch {
    return
  }
  try {
    await closeTicket(detail.value.id)
    ElMessage.success('工单已关闭，欢迎评价本次服务')
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  }
}

async function onRate() {
  rating.value = true
  try {
    await rateTicket(detail.value.id, satisfaction.value)
    ElMessage.success('感谢您的评价')
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  } finally {
    rating.value = false
  }
}

onMounted(fetchList)
</script>

<style scoped>
.mono {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin: 20px 0 10px;
}

.pre-wrap {
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.7;
}

/* —— 对话流 —— */
.msg-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.msg-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 100%;
}

.msg-item.mine {
  align-items: flex-end;
}

.msg-item.system {
  align-items: center;
}

.msg-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 4px;
}

.msg-bubble {
  max-width: 86%;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--bg-hover);
  font-size: 13px;
  color: var(--text-1);
}

.msg-item.mine .msg-bubble {
  background: var(--brand);
  color: #fff;
}

.msg-system {
  font-size: 12px;
  color: var(--text-3);
}

.action-bar {
  margin-top: 12px;
  display: flex;
  gap: 10px;
}

.rate-bar,
.rate-done {
  display: flex;
  align-items: center;
  gap: 14px;
}

.rate-tip {
  font-size: 12px;
  color: var(--text-3);
}
</style>
