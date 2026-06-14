<template>
  <div class="page-card">
    <PageHeader title="争议中心" subtitle="协商期可撤回，仲裁期请按时提交证据，裁决结果由平台依据双方举证作出">
      <template #actions>
        <el-button :icon="Refresh" @click="fetchList">刷新</el-button>
      </template>
    </PageHeader>

    <el-table v-loading="loading" :data="list" stripe>
      <el-table-column prop="no" label="争议单号" width="190">
        <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
      </el-table-column>
      <el-table-column prop="taskTitle" label="关联任务" min-width="170" show-overflow-tooltip />
      <el-table-column label="类型" width="130" align="center">
        <template #default="{ row }">
          <el-tag effect="plain" size="small">{{ DISPUTE_TYPE[row.type] || row.type }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发起方" width="80" align="center">
        <template #default="{ row }">{{ roleLabel(row.initiatorRole) }}</template>
      </el-table-column>
      <el-table-column label="主张金额" width="120" align="right">
        <template #default="{ row }">
          <span class="money">{{ row.claimAmount ? `¥${fmtMoney(row.claimAmount)}` : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="statusMeta(row.status).tag" effect="light" size="small">
            {{ statusMeta(row.status).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="阶段截止" width="170">
        <template #default="{ row }">
          <span :class="{ 'deadline-warn': isActive(row.status) && row.stageDeadline }">
            {{ isActive(row.status) ? fmtDateTime(row.stageDeadline) : '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="发起时间" width="170">
        <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="80" fixed="right" align="center">
        <template #default="{ row }">
          <el-button type="primary" link @click="openDetail(row.id)">详情</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无争议记录。可在任务管理中对进行中 / 已结算任务发起争议" />
      </template>
    </el-table>

    <!-- 争议详情抽屉 -->
    <el-drawer v-model="drawerVisible" :title="detail ? `争议 ${detail.no}` : '争议详情'" size="560px" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="状态" :span="2">
              <el-tag :type="statusMeta(detail.status).tag" effect="light" size="small">
                {{ statusMeta(detail.status).label }}
              </el-tag>
              <span v-if="isActive(detail.status) && detail.stageDeadline" class="deadline-tip">
                阶段截止：{{ fmtDateTime(detail.stageDeadline) }}
              </span>
            </el-descriptions-item>
            <el-descriptions-item label="类型">{{ DISPUTE_TYPE[detail.type] || detail.type }}</el-descriptions-item>
            <el-descriptions-item label="发起方">{{ roleLabel(detail.initiatorRole) }}</el-descriptions-item>
            <el-descriptions-item label="关联任务" :span="2">{{ detail.taskTitle }}</el-descriptions-item>
            <el-descriptions-item label="主张金额">
              <span class="money">{{ detail.claimAmount ? `¥${fmtMoney(detail.claimAmount)}` : '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="发起时间">{{ fmtDateTime(detail.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="诉求描述" :span="2">
              <div class="pre-wrap">{{ detail.claim }}</div>
            </el-descriptions-item>
          </el-descriptions>

          <!-- 裁决结果 -->
          <template v-if="detail.rulingType">
            <div class="section-title">裁决结果</div>
            <el-alert :type="detail.status === 'executed' ? 'success' : 'warning'" show-icon :closable="false" class="ruling-box">
              <template #title>
                {{ RULING_TYPE[detail.rulingType] || detail.rulingType }}
                <template v-if="detail.rulingAmount != null">
                  · 金额 ¥{{ fmtMoney(detail.rulingAmount) }}
                </template>
              </template>
              <div v-if="detail.rulingNote" class="ruling-note">裁决说明：{{ detail.rulingNote }}</div>
              <div class="ruling-time">裁决时间：{{ fmtDateTime(detail.ruledAt) }}</div>
            </el-alert>
          </template>

          <!-- 时间线 -->
          <div class="section-title">处理时间线（{{ detail.timeline?.length || 0 }}）</div>
          <el-timeline class="dispute-timeline">
            <el-timeline-item
              v-for="e in detail.timeline"
              :key="e.id"
              :timestamp="`${roleLabel(e.actorRole)} · ${fmtDateTime(e.createdAt)}`"
              :type="timelineType(e.action)"
              placement="top"
            >
              <div class="event-action">{{ actionLabel(e.action) }}</div>
              <div v-if="e.content" class="event-content pre-wrap">{{ e.content }}</div>
              <div v-if="e.attachments?.length" class="event-attaches">
                <el-button
                  v-for="(f, i) in e.attachments"
                  :key="f.id"
                  type="primary"
                  link
                  size="small"
                  @click="onDownload(f, i)"
                >
                  <el-icon style="margin-right: 2px"><Paperclip /></el-icon>附件{{ i + 1 }}
                </el-button>
              </div>
            </el-timeline-item>
          </el-timeline>

          <!-- 举证留言 -->
          <template v-if="isActive(detail.status)">
            <div class="section-title">举证留言</div>
            <el-input
              v-model="eventContent"
              type="textarea"
              :rows="3"
              maxlength="1000"
              show-word-limit
              placeholder="补充事实、证据说明或协商意见（双方与平台仲裁员均可见）"
            />
            <div class="action-bar">
              <el-button type="primary" :loading="eventSubmitting" @click="onSubmitEvent">提交留言</el-button>
              <el-button
                v-if="detail.initiatorRole === 'company'"
                type="warning"
                plain
                @click="onWithdraw"
              >
                撤回争议
              </el-button>
            </div>
          </template>

          <!-- 不服裁决 → 线下升级 -->
          <div v-if="detail.status === 'ruled'" class="action-bar">
            <el-button type="danger" plain @click="onEscalate">不服裁决，声明线下升级</el-button>
            <span class="escalate-tip">声明后可向仲裁委 / 法院提起，平台将按需出具证据包</span>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import { getDisputes, getDisputeDetail, addDisputeEvent, withdrawDispute, escalateDispute } from '../api/me'
import { downloadFile } from '../utils/download'
import { fmtMoney, fmtDateTime, DISPUTE_STATUS, DISPUTE_TYPE, RULING_TYPE } from '../utils/format'

const list = ref([])
const loading = ref(false)

const drawerVisible = ref(false)
const detailLoading = ref(false)
const detail = ref(null)

const eventContent = ref('')
const eventSubmitting = ref(false)

const statusMeta = s => DISPUTE_STATUS[s] || { label: s || '—', tag: 'info' }
const isActive = s => ['negotiating', 'arbitrating'].includes(s)

const ROLE_LABEL = { company: '我方（企业）', worker: '零工', admin: '平台' }
const roleLabel = r => ROLE_LABEL[r] || r || '—'

const ACTION_LABEL = {
  create: '发起争议',
  evidence: '举证留言',
  accept: '平台受理仲裁',
  rule: '平台裁决',
  execute: '裁决执行',
  withdraw: '撤回争议',
  escalate: '声明线下升级'
}
const actionLabel = a => ACTION_LABEL[a] || a

function timelineType(action) {
  if (action === 'rule' || action === 'execute') return 'success'
  if (action === 'withdraw' || action === 'escalate') return 'warning'
  if (action === 'create') return 'danger'
  return 'primary'
}

async function fetchList() {
  loading.value = true
  try {
    const data = await getDisputes()
    list.value = data.list || []
  } finally {
    loading.value = false
  }
}

async function openDetail(id) {
  drawerVisible.value = true
  detailLoading.value = true
  detail.value = null
  eventContent.value = ''
  try {
    detail.value = await getDisputeDetail(id)
  } finally {
    detailLoading.value = false
  }
}

async function refreshDetail() {
  if (detail.value?.id) {
    detail.value = await getDisputeDetail(detail.value.id)
  }
  fetchList()
}

async function onSubmitEvent() {
  if (!eventContent.value.trim()) {
    ElMessage.warning('请填写留言内容')
    return
  }
  eventSubmitting.value = true
  try {
    await addDisputeEvent(detail.value.id, eventContent.value.trim())
    ElMessage.success('留言已提交，对方与平台仲裁员均可见')
    eventContent.value = ''
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  } finally {
    eventSubmitting.value = false
  }
}

async function onWithdraw() {
  try {
    await ElMessageBox.confirm(
      '撤回表示双方已和解或我方放弃主张，争议将关闭且不可恢复。是否继续？',
      '撤回争议',
      { confirmButtonText: '继续撤回', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await withdrawDispute(detail.value.id)
    ElMessage.success('争议已撤回')
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  }
}

async function onEscalate() {
  try {
    await ElMessageBox.confirm(
      '声明线下升级后，争议将标记为线下处理，可向仲裁委 / 法院提起，平台将按需出具四流证据包。是否继续？',
      '声明线下升级',
      { confirmButtonText: '继续声明', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await escalateDispute(detail.value.id)
    ElMessage.success('已声明线下升级，可联系客服获取证据包')
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  }
}

async function onDownload(f, i) {
  try {
    await downloadFile(f.url, `争议附件${i + 1}`)
  } catch {
    // 错误已由拦截器提示
  }
}

onMounted(fetchList)
</script>

<style scoped>
.mono {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.deadline-warn {
  color: var(--danger);
  font-weight: 600;
}

.deadline-tip {
  margin-left: 10px;
  font-size: 12px;
  color: var(--danger);
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

.ruling-box {
  border-radius: 8px;
}

.ruling-note {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.7;
}

.ruling-time {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}

.dispute-timeline {
  padding-left: 4px;
}

.event-action {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.event-content {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-2);
}

.event-attaches {
  margin-top: 4px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.escalate-tip {
  font-size: 12px;
  color: var(--text-3);
}
</style>
