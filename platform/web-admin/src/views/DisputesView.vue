<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">争议仲裁工作台</h2>
        <p class="page-sub">验收争议协商→仲裁举证→平台裁决→执行划付全流程处置</p>
      </div>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <div class="panel">
      <div class="filter-bar">
        <el-radio-group v-model="status" @change="load">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="negotiating">协商中</el-radio-button>
          <el-radio-button value="arbitrating">仲裁举证</el-radio-button>
          <el-radio-button value="ruled">已裁决</el-radio-button>
          <el-radio-button value="executed">已执行</el-radio-button>
          <el-radio-button value="closed">已关闭</el-radio-button>
        </el-radio-group>
        <el-select v-model="type" style="width: 160px" @change="load">
          <el-option label="全部类型" value="all" />
          <el-option
            v-for="(text, key) in TYPE_TEXT"
            :key="key"
            :label="text"
            :value="key"
          />
        </el-select>
      </div>

      <el-table :data="sortedList" v-loading="loading" stripe>
        <el-table-column label="争议单号" min-width="150">
          <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
        </el-table-column>
        <el-table-column label="任务" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.taskTitle }}
            <span class="sub-id">#{{ row.taskId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="双方" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">{{ row.companyName }} ↔ {{ row.workerName || '—' }}</template>
        </el-table-column>
        <el-table-column label="类型" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ typeText(row.type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="发起方" width="80" align="center">
          <template #default="{ row }">{{ roleText(row.initiatorRole) }}</template>
        </el-table-column>
        <el-table-column label="分包价" width="110" align="right">
          <template #default="{ row }">
            <span class="money">{{ fmtMoney(row.subPrice) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small" :effect="isActive(row.status) ? 'dark' : 'plain'">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="阶段截止" width="150">
          <template #default="{ row }">
            <span v-if="row.stageDeadline && isActive(row.status)" :class="{ 'deadline-danger': deadlineUrgent(row.stageDeadline) }">
              {{ deadlineText(row.stageDeadline) }}
            </span>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <el-table-column label="发起时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row.id)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无争议" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 争议详情抽屉 -->
    <el-drawer v-model="drawer.visible" title="争议详情" size="680px" destroy-on-close>
      <div v-loading="drawer.loading" class="detail-body">
        <template v-if="drawer.data">
          <!-- 任务信息 -->
          <div class="detail-section">
            <div class="detail-section-title">任务信息</div>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="争议单号" :span="2">
                <span class="mono">{{ drawer.data.no }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="任务" :span="2">
                {{ drawer.data.taskTitle }}（#{{ drawer.data.taskId }}）
              </el-descriptions-item>
              <el-descriptions-item label="企业">{{ drawer.data.companyName }}</el-descriptions-item>
              <el-descriptions-item label="零工">{{ drawer.data.workerName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="发单价">
                <span class="money">{{ fmtMoney(drawer.data.price) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="分包价">
                <span class="money">{{ fmtMoney(drawer.data.subPrice) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="争议类型">{{ typeText(drawer.data.type) }}</el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag :type="statusTagType(drawer.data.status)" size="small">
                  {{ statusText(drawer.data.status) }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="发起方诉求" :span="2">
                {{ roleText(drawer.data.initiatorRole) }}：{{ drawer.data.claim }}
                <span v-if="Number(drawer.data.claimAmount)">（主张金额 {{ fmtMoney(drawer.data.claimAmount) }}）</span>
              </el-descriptions-item>
            </el-descriptions>
          </div>

          <!-- 交付标准与交付物 -->
          <div class="detail-section">
            <div class="detail-section-title">交付标准与交付物</div>
            <div class="quote-box">
              <div class="quote-label">验收标准</div>
              <div class="quote-text">{{ drawer.data.standard || '—' }}</div>
            </div>
            <div class="quote-box">
              <div class="quote-label">交付物说明</div>
              <div class="quote-text">{{ drawer.data.deliverable || '—' }}</div>
            </div>
          </div>

          <!-- 双方时间线 -->
          <div class="detail-section">
            <div class="detail-section-title">双方时间线与证据</div>
            <el-empty v-if="!drawer.data.timeline.length" description="暂无举证记录" :image-size="50" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="e in drawer.data.timeline"
                :key="e.id"
                :timestamp="fmtTime(e.createdAt)"
                :type="timelineDotType(e.actorRole)"
              >
                <div class="tl-head">
                  <el-tag size="small" :type="actorTagType(e.actorRole)" effect="plain">
                    {{ roleText(e.actorRole) }}
                  </el-tag>
                  <span class="tl-action">{{ actionText(e.action) }}</span>
                </div>
                <div class="tl-content">{{ e.content }}</div>
                <div v-if="e.attachments?.length" class="tl-attachments">
                  <el-link
                    v-for="(a, ai) in e.attachments"
                    :key="a.id"
                    type="primary"
                    :href="a.url"
                    target="_blank"
                  >
                    <el-icon><Paperclip /></el-icon>证据附件{{ ai + 1 }}
                  </el-link>
                </div>
              </el-timeline-item>
            </el-timeline>
          </div>

          <!-- 已裁决结果 -->
          <div v-if="drawer.data.rulingType" class="detail-section">
            <div class="detail-section-title">裁决结果</div>
            <el-alert :type="drawer.data.status === 'executed' ? 'success' : 'warning'" :closable="false" show-icon>
              <template #title>
                {{ rulingText(drawer.data.rulingType) }}
                <span v-if="drawer.data.rulingAmount != null">（{{ fmtMoney(drawer.data.rulingAmount) }}）</span>
              </template>
              {{ drawer.data.rulingNote }}
            </el-alert>
          </div>

          <!-- 操作区 -->
          <div v-if="canRule" class="detail-section">
            <div class="detail-section-title">仲裁操作</div>

            <!-- 受理 -->
            <template v-if="drawer.data.status === 'negotiating'">
              <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
                争议仍在协商期。受理后转入仲裁举证阶段，双方须在限期内提交证据。
              </el-alert>
              <el-button type="primary" :loading="accepting" @click="onAccept">受理转仲裁</el-button>
            </template>

            <!-- 裁决表单 -->
            <template v-else-if="drawer.data.status === 'arbitrating'">
              <el-form label-position="top">
                <el-form-item label="裁决类型">
                  <el-radio-group v-model="ruleForm.rulingType">
                    <el-radio value="full_pay">全额支付</el-radio>
                    <el-radio value="partial_pay">部分支付</el-radio>
                    <el-radio value="no_pay">不予支付</el-radio>
                    <el-radio value="redeliver">退回重做</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item v-if="ruleForm.rulingType === 'partial_pay'" label="裁决金额（元，须小于分包价）">
                  <el-input-number
                    v-model="ruleForm.rulingAmount"
                    :min="0.01"
                    :max="Math.max(Number(drawer.data.subPrice) - 0.01, 0.01)"
                    :precision="2"
                    :step="100"
                    controls-position="right"
                    style="width: 220px"
                  />
                </el-form-item>
                <el-form-item label="裁决理由（不少于10个字，将同步给双方）">
                  <el-input
                    v-model="ruleForm.rulingNote"
                    type="textarea"
                    :rows="3"
                    maxlength="1000"
                    show-word-limit
                    placeholder="例如：经核查交付物与验收标准的差异，零工已完成主要工作量，裁决按 80% 支付"
                  />
                </el-form-item>
              </el-form>
              <el-button type="primary" :loading="ruling" @click="onRule">提交裁决</el-button>
            </template>

            <!-- 执行 -->
            <template v-else-if="drawer.data.status === 'ruled'">
              <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
                裁决已生效但尚未执行。执行后将按裁决结果完成资金划付，不可撤销。
              </el-alert>
              <el-button type="danger" :loading="executing" @click="onExecute">执行裁决</el-button>
            </template>

            <el-alert v-else type="info" :closable="false" show-icon>
              当前状态（{{ statusText(drawer.data.status) }}）无可用操作。
            </el-alert>
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
import { Refresh, Paperclip } from '@element-plus/icons-vue'
import {
  getDisputes,
  getDisputeDetail,
  acceptDispute,
  ruleDispute,
  executeDispute
} from '../api/admin'
import { withStepUp } from '../utils/stepup'
import { fmtMoney, fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canRule = computed(() => auth.can('dispute:rule'))

const status = ref('all')
const type = ref('all')
const loading = ref(false)
const list = ref([])

const TYPE_TEXT = {
  acceptance: '验收争议',
  payment_overdue: '逾期支付',
  worker_missing: '零工失联',
  quality_after: '事后质量',
  other: '其他'
}

const STATUS_TEXT = {
  negotiating: '协商中',
  arbitrating: '仲裁举证',
  ruled: '已裁决',
  executed: '已执行',
  closed: '已关闭',
  withdrawn: '已撤回',
  escalated: '线下升级'
}

const RULING_TEXT = {
  full_pay: '全额支付',
  partial_pay: '部分支付',
  no_pay: '不予支付',
  redeliver: '退回重做'
}

const ACTION_TEXT = {
  open: '发起争议',
  negotiate: '协商留言',
  evidence: '提交证据',
  accept: '平台受理',
  rule: '平台裁决',
  execute: '执行裁决',
  withdraw: '撤回争议',
  close: '关闭争议',
  escalate: '线下升级'
}

function typeText(t) {
  return TYPE_TEXT[t] || t
}

function statusText(s) {
  return STATUS_TEXT[s] || s
}

function rulingText(t) {
  return RULING_TEXT[t] || t
}

function actionText(a) {
  return ACTION_TEXT[a] || a
}

function roleText(role) {
  return { company: '企业', worker: '零工', admin: '平台' }[role] || role
}

function actorTagType(role) {
  return { company: 'warning', worker: 'primary', admin: 'danger' }[role] || 'info'
}

function timelineDotType(role) {
  return { company: 'warning', worker: 'primary', admin: 'danger' }[role] || 'info'
}

function statusTagType(s) {
  return {
    negotiating: 'warning',
    arbitrating: 'danger',
    ruled: 'primary',
    executed: 'success',
    closed: 'info',
    withdrawn: 'info',
    escalated: 'danger'
  }[s] || 'info'
}

function isActive(s) {
  return s === 'negotiating' || s === 'arbitrating'
}

// —— 优先展示协商/仲裁中的争议 ——
const sortedList = computed(() =>
  [...list.value].sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)))
)

// —— 阶段截止倒计时(不足24小时或已超期标红) ——
function deadlineMs(deadline) {
  const d = new Date(String(deadline).includes('T') ? deadline : String(deadline).replace(' ', 'T'))
  return d.getTime() - Date.now()
}

function deadlineUrgent(deadline) {
  return deadlineMs(deadline) < 24 * 3600 * 1000
}

function deadlineText(deadline) {
  const ms = deadlineMs(deadline)
  if (Number.isNaN(ms)) return String(deadline)
  if (ms <= 0) return '已超期'
  const hours = Math.floor(ms / 3600000)
  if (hours >= 24) return `剩 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
  if (hours >= 1) return `剩 ${hours} 小时`
  return `剩 ${Math.max(1, Math.floor(ms / 60000))} 分钟`
}

async function load() {
  loading.value = true
  try {
    const data = await getDisputes({ status: status.value, type: type.value })
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// —— 详情抽屉 ——
const drawer = reactive({ visible: false, loading: false, data: null })
const accepting = ref(false)
const ruling = ref(false)
const executing = ref(false)
const ruleForm = reactive({ rulingType: 'full_pay', rulingAmount: null, rulingNote: '' })

async function openDetail(id) {
  drawer.visible = true
  drawer.loading = true
  drawer.data = null
  ruleForm.rulingType = 'full_pay'
  ruleForm.rulingAmount = null
  ruleForm.rulingNote = ''
  try {
    drawer.data = await getDisputeDetail(id)
  } catch {
    drawer.visible = false
  } finally {
    drawer.loading = false
  }
}

async function refreshDetail() {
  await Promise.all([load(), openDetail(drawer.data.id)])
}

async function onAccept() {
  try {
    await ElMessageBox.confirm(
      '受理后争议转入仲裁举证阶段，双方将收到举证通知。确定受理？',
      '受理确认',
      { type: 'warning', confirmButtonText: '确认受理', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  accepting.value = true
  try {
    await acceptDispute(drawer.data.id)
    ElMessage.success('已受理，争议转入仲裁举证阶段')
    await refreshDetail()
  } catch {
    /* 错误已统一提示 */
  } finally {
    accepting.value = false
  }
}

async function onRule() {
  if (ruleForm.rulingNote.trim().length < 10) {
    ElMessage.warning('裁决理由不少于 10 个字')
    return
  }
  if (ruleForm.rulingType === 'partial_pay') {
    if (!ruleForm.rulingAmount || ruleForm.rulingAmount <= 0) {
      ElMessage.warning('部分支付须填写裁决金额')
      return
    }
    if (ruleForm.rulingAmount >= Number(drawer.data.subPrice)) {
      ElMessage.warning('部分支付的裁决金额须小于分包价')
      return
    }
  }
  ruling.value = true
  try {
    const payload = {
      rulingType: ruleForm.rulingType,
      rulingNote: ruleForm.rulingNote.trim()
    }
    if (ruleForm.rulingType === 'partial_pay') {
      payload.rulingAmount = ruleForm.rulingAmount
    }
    await withStepUp(totp => ruleDispute(drawer.data.id, payload, totp))
    ElMessage.success('裁决已提交，双方将收到裁决通知')
    await refreshDetail()
  } catch {
    /* 错误已统一提示/用户取消 */
  } finally {
    ruling.value = false
  }
}

async function onExecute() {
  try {
    await ElMessageBox.confirm(
      '执行后将按裁决结果完成资金划付，不可撤销。确定执行？',
      '执行裁决',
      { type: 'warning', confirmButtonText: '确认执行', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  executing.value = true
  try {
    await withStepUp(totp => executeDispute(drawer.data.id, totp))
    ElMessage.success('裁决已执行，资金已按裁决结果划付')
    await refreshDetail()
  } catch {
    /* 错误已统一提示/用户取消 */
  } finally {
    executing.value = false
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

.sub-id {
  font-size: 12px;
  color: var(--text-3);
}

.empty-dash {
  color: var(--text-3);
}

.deadline-danger {
  color: var(--danger);
  font-weight: 700;
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

.quote-box {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.quote-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 4px;
}

.quote-text {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
  white-space: pre-wrap;
}

.tl-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tl-action {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.tl-content {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  white-space: pre-wrap;
}

.tl-attachments {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
</style>
