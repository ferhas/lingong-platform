<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">集成事件监控</h2>
        <p class="page-sub">外部服务商回调事件与出站调用日志，失败事件可人工重放</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="reload" />
    </div>

    <div class="panel">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="回调事件" name="webhooks" />
        <el-tab-pane label="出站调用日志" name="calls" />
      </el-tabs>

      <!-- 回调事件 -->
      <template v-if="activeTab === 'webhooks'">
        <div class="filter-bar">
          <el-radio-group v-model="whStatus" @change="loadWebhooks">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="received">待处理</el-radio-button>
            <el-radio-button value="processed">已处理</el-radio-button>
            <el-radio-button value="failed">处理失败</el-radio-button>
            <el-radio-button value="ignored">已忽略</el-radio-button>
          </el-radio-group>
        </div>

        <el-table v-loading="whLoading" :data="whList" stripe>
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="payload-box">
                <div class="payload-title">事件报文 payload</div>
                <pre class="payload-pre mono">{{ prettyPayload(row.payload) }}</pre>
                <div v-if="row.error" class="payload-error">处理错误：{{ row.error }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="id" label="ID" width="70" align="center" />
          <el-table-column label="服务商" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ providerText(row.provider) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="事件ID" min-width="170">
            <template #default="{ row }"><span class="mono">{{ row.eventId }}</span></template>
          </el-table-column>
          <el-table-column prop="eventType" label="事件类型" min-width="140">
            <template #default="{ row }"><span class="mono">{{ row.eventType }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="whTagType(row.status)" size="small" :effect="row.status === 'failed' ? 'dark' : 'plain'">
                {{ whStatusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="错误" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.error }">{{ row.error || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="接收时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column label="处理时间" width="160">
            <template #default="{ row }">{{ row.processedAt ? fmtTime(row.processedAt) : '—' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right" align="center">
            <template #default="{ row }">
              <el-button
                v-if="['failed', 'received'].includes(row.status)"
                type="warning"
                link
                size="small"
                :loading="row.id === replayingId"
                @click="onReplay(row)"
              >
                重 放
              </el-button>
              <span v-else class="empty-dash">—</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无回调事件" :image-size="90" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="whPage"
            v-model:page-size="whPageSize"
            :total="whTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadWebhooks"
            @size-change="onWhSizeChange"
          />
        </div>
      </template>

      <!-- 出站调用日志 -->
      <template v-else>
        <div class="filter-bar">
          <el-select v-model="callProvider" style="width: 160px" @change="loadCalls">
            <el-option label="全部服务商" value="all" />
            <el-option v-for="(text, key) in PROVIDER_TEXT" :key="key" :label="text" :value="key" />
          </el-select>
          <el-radio-group v-model="callStatus" @change="loadCalls">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="ok">成功</el-radio-button>
            <el-radio-button value="fail">失败</el-radio-button>
          </el-radio-group>
        </div>

        <el-table v-loading="callLoading" :data="callList" stripe>
          <el-table-column label="服务商" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ providerText(row.provider) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="action" label="动作" min-width="130">
            <template #default="{ row }"><span class="mono">{{ row.action }}</span></template>
          </el-table-column>
          <el-table-column label="业务引用" min-width="150">
            <template #default="{ row }"><span class="mono">{{ row.bizRef || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === 'ok' ? 'success' : 'danger'" size="small" :effect="row.status === 'ok' ? 'plain' : 'dark'">
                {{ row.status === 'ok' ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="时延" width="110" align="right">
            <template #default="{ row }">
              <span :class="latencyClass(row.latencyMs)">{{ row.latencyMs != null ? `${row.latencyMs} ms` : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="错误" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.error }">{{ row.error || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="调用时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无调用日志" :image-size="90" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="callPage"
            v-model:page-size="callPageSize"
            :total="callTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadCalls"
            @size-change="onCallSizeChange"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getWebhookEvents, replayWebhookEvent, getIntegrationCalls } from '../api/admin'
import { fmtTime } from '../utils/format'

const activeTab = ref('webhooks')

// 键须与后端实际 provider 一致：出站 integration_calls 用 track(key) 的 8 个 key；回调 webhook 用 escrow/einvoice/esign/insurance
const PROVIDER_TEXT = {
  realname: '公安实名',
  escrow: '银行存管',
  einvoice: '数电票',
  esign: '电子签',
  insurance: '保险',
  taxbureau: '税务申报',
  sms: '短信',
  wxsubscribe: '微信订阅消息'
}

function providerText(p) {
  return PROVIDER_TEXT[p] || p
}

// —— 回调事件 ——
const whLoading = ref(false)
const whList = ref([])
const whTotal = ref(0)
const whPage = ref(1)
const whPageSize = ref(20)
const whStatus = ref('all')
const replayingId = ref(0)

const WH_STATUS_TEXT = { received: '待处理', processed: '已处理', failed: '处理失败', ignored: '已忽略' }

function whStatusText(s) {
  return WH_STATUS_TEXT[s] || s
}

function whTagType(s) {
  return { received: 'warning', processed: 'success', failed: 'danger', ignored: 'info' }[s] || 'info'
}

function prettyPayload(payload) {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    return payload
  }
}

async function loadWebhooks() {
  whLoading.value = true
  try {
    const data = await getWebhookEvents({
      status: whStatus.value,
      page: whPage.value,
      pageSize: whPageSize.value
    })
    whList.value = data.list
    whTotal.value = data.total
  } catch {
    /* 错误已统一提示 */
  } finally {
    whLoading.value = false
  }
}

function onWhSizeChange() {
  whPage.value = 1
  loadWebhooks()
}

async function onReplay(row) {
  // 重放会再次触发该回调的业务处理（可能涉及资金/发票动作），需二次确认
  try {
    await ElMessageBox.confirm(
      `将重新处理该回调事件（${row.provider || '外部回调'}${row.eventType ? ' · ' + row.eventType : ''}）。重放会再次触发其业务处理，请确认。`,
      '确认重放事件',
      { type: 'warning', confirmButtonText: '确认重放', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  replayingId.value = row.id
  try {
    const r = await replayWebhookEvent(row.id)
    if (r.ok) {
      ElMessage.success('重放成功，事件已重新处理')
    } else {
      ElMessage.warning(`重放未成功：${r.error || '请查看事件错误详情'}`)
    }
    loadWebhooks()
  } catch {
    /* 错误已统一提示 */
  } finally {
    replayingId.value = 0
  }
}

// —— 出站调用日志 ——
const callLoading = ref(false)
const callList = ref([])
const callTotal = ref(0)
const callPage = ref(1)
const callPageSize = ref(20)
const callProvider = ref('all')
const callStatus = ref('all')
const callsLoaded = ref(false)

function latencyClass(ms) {
  if (ms == null) return ''
  return ms >= 2000 ? 'fail-reason' : ms >= 800 ? 'latency-slow' : ''
}

async function loadCalls() {
  callLoading.value = true
  try {
    const data = await getIntegrationCalls({
      provider: callProvider.value,
      status: callStatus.value,
      page: callPage.value,
      pageSize: callPageSize.value
    })
    callList.value = data.list
    callTotal.value = data.total
    callsLoaded.value = true
  } catch {
    /* 错误已统一提示 */
  } finally {
    callLoading.value = false
  }
}

function onCallSizeChange() {
  callPage.value = 1
  loadCalls()
}

function onTabChange() {
  if (activeTab.value === 'calls' && !callsLoaded.value) {
    loadCalls()
  }
}

function reload() {
  if (activeTab.value === 'webhooks') loadWebhooks()
  else loadCalls()
}

onMounted(loadWebhooks)
</script>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.payload-box {
  padding: 8px 20px 14px;
}

.payload-title {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 6px;
}

.payload-pre {
  margin: 0;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.payload-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--danger);
}

.fail-reason {
  color: var(--danger);
}

.latency-slow {
  color: var(--warning);
}

.empty-dash {
  color: var(--text-3);
}
</style>
