<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">消息中心</h2>
        <p class="page-sub">外发消息模板管理与触达日志（短信/站内信）</p>
      </div>
      <el-button :icon="Refresh" circle @click="reload" />
    </div>

    <div class="panel">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="模板管理" name="templates" />
        <el-tab-pane label="外发日志" name="logs" />
      </el-tabs>

      <!-- 模板管理 -->
      <template v-if="activeTab === 'templates'">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
          模板中的 {{ '{' }}xxx{{ '}' }} 为变量占位符，发送时自动替换。停用后该场景不再外发，请谨慎操作。
        </el-alert>
        <el-table :data="templates" v-loading="tplLoading" stripe>
          <el-table-column label="模板编码" min-width="170">
            <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
          </el-table-column>
          <el-table-column label="渠道" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain" :type="row.channel === 'sms' ? 'warning' : 'primary'">
                {{ channelText(row.channel) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="标题模板" min-width="180">
            <template #default="{ row }">
              <el-input v-if="row.editing" v-model="row.draftTitle" size="small" maxlength="50" />
              <span v-else>{{ row.titleTpl }}</span>
            </template>
          </el-table-column>
          <el-table-column label="正文模板" min-width="280">
            <template #default="{ row }">
              <el-input
                v-if="row.editing"
                v-model="row.draftBody"
                type="textarea"
                :rows="3"
                size="small"
                maxlength="500"
              />
              <span v-else class="body-text">{{ row.bodyTpl }}</span>
            </template>
          </el-table-column>
          <el-table-column label="启用" width="90" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                :loading="row.switching"
                :disabled="row.editing"
                @change="v => onToggle(row, v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="更新时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right" align="center">
            <template #default="{ row }">
              <template v-if="row.editing">
                <el-button type="primary" link size="small" :loading="row.saving" @click="saveTemplate(row)">保存</el-button>
                <el-button link size="small" @click="cancelEdit(row)">取消</el-button>
              </template>
              <el-button v-else type="primary" link size="small" @click="startEdit(row)">编辑</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无消息模板" :image-size="90" />
          </template>
        </el-table>
      </template>

      <!-- 外发日志 -->
      <template v-else>
        <el-row :gutter="14" class="stat-row">
          <el-col :xs="12" :sm="6">
            <div class="mini-stat">
              <div class="mini-stat-label">累计外发</div>
              <div class="mini-stat-value">{{ logTotal }}</div>
            </div>
          </el-col>
          <el-col :xs="12" :sm="6">
            <div class="mini-stat">
              <div class="mini-stat-label">触达率</div>
              <div class="mini-stat-value">{{ deliveryRate }}</div>
            </div>
          </el-col>
        </el-row>

        <el-table :data="logs" v-loading="logLoading" stripe>
          <el-table-column label="手机号(脱敏)" width="130">
            <template #default="{ row }"><span class="mono">{{ row.phone || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="渠道" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain" :type="row.channel === 'sms' ? 'warning' : 'primary'">
                {{ channelText(row.channel) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="模板" min-width="150">
            <template #default="{ row }"><span class="mono">{{ row.templateCode }}</span></template>
          </el-table-column>
          <el-table-column prop="content" label="内容" min-width="260" show-overflow-tooltip />
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === 'sent' ? 'success' : 'danger'" size="small" :effect="row.status === 'sent' ? 'plain' : 'dark'">
                {{ row.status === 'sent' ? '已送达' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="错误" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.error }">{{ row.error || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="发送时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无外发记录" :image-size="90" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="logPage"
            v-model:page-size="logPageSize"
            :total="logTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadLogs"
            @size-change="onLogSizeChange"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getMessageTemplates, updateMessageTemplate, getMessageLogs } from '../api/admin'
import { fmtTime } from '../utils/format'

const activeTab = ref('templates')

function channelText(c) {
  return { sms: '短信', inapp: '站内信', notification: '站内信' }[c] || c
}

// —— 模板管理(行内编辑) ——
const tplLoading = ref(false)
const templates = ref([])

async function loadTemplates() {
  tplLoading.value = true
  try {
    const data = await getMessageTemplates()
    templates.value = (data.list || []).map(t => ({
      ...t,
      editing: false,
      saving: false,
      switching: false,
      draftTitle: t.titleTpl,
      draftBody: t.bodyTpl
    }))
  } catch {
    /* 错误已统一提示 */
  } finally {
    tplLoading.value = false
  }
}

function startEdit(row) {
  row.draftTitle = row.titleTpl
  row.draftBody = row.bodyTpl
  row.editing = true
}

function cancelEdit(row) {
  row.editing = false
}

async function saveTemplate(row) {
  if (row.draftTitle.trim().length < 2 || row.draftBody.trim().length < 5) {
    ElMessage.warning('标题不少于 2 个字、正文不少于 5 个字')
    return
  }
  row.saving = true
  try {
    await updateMessageTemplate(row.code, {
      titleTpl: row.draftTitle.trim(),
      bodyTpl: row.draftBody.trim()
    })
    row.titleTpl = row.draftTitle.trim()
    row.bodyTpl = row.draftBody.trim()
    row.updatedAt = new Date().toISOString()
    row.editing = false
    ElMessage.success(`模板「${row.code}」已保存`)
  } catch {
    /* 错误已统一提示 */
  } finally {
    row.saving = false
  }
}

async function onToggle(row, enabled) {
  row.switching = true
  try {
    await updateMessageTemplate(row.code, { enabled })
    row.enabled = enabled
    row.updatedAt = new Date().toISOString()
    ElMessage.success(`模板「${row.code}」已${enabled ? '启用' : '停用'}`)
  } catch {
    /* 错误已统一提示 */
  } finally {
    row.switching = false
  }
}

// —— 外发日志 ——
const logLoading = ref(false)
const logs = ref([])
const logTotal = ref(0)
const logPage = ref(1)
const logPageSize = ref(20)
const deliveryRate = ref('—')
const logsLoaded = ref(false)

async function loadLogs() {
  logLoading.value = true
  try {
    const data = await getMessageLogs({ page: logPage.value, pageSize: logPageSize.value })
    logs.value = data.list
    logTotal.value = data.total
    deliveryRate.value = data.deliveryRate
    logsLoaded.value = true
  } catch {
    /* 错误已统一提示 */
  } finally {
    logLoading.value = false
  }
}

function onLogSizeChange() {
  logPage.value = 1
  loadLogs()
}

function onTabChange() {
  if (activeTab.value === 'logs' && !logsLoaded.value) {
    loadLogs()
  }
}

function reload() {
  if (activeTab.value === 'templates') loadTemplates()
  else loadLogs()
}

onMounted(loadTemplates)
</script>

<style scoped>
.body-text {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  white-space: pre-wrap;
}

.stat-row {
  margin-bottom: 14px;
}

.mini-stat {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}

.mini-stat-label {
  font-size: 12px;
  color: var(--text-3);
}

.mini-stat-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 800;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.fail-reason {
  color: var(--danger);
}
</style>
