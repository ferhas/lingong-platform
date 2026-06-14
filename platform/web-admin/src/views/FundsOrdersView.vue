<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">结算/提现单据</h2>
        <p class="page-sub">提现申请单（T+1 出金）与结算单（两阶段分账）全程监控</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="reload" />
    </div>

    <!-- 应急开关(config:write + step-up + 二次确认) -->
    <div v-if="canConfigWrite" class="panel switch-panel">
      <div class="switch-info">
        <div class="switch-title">
          资金应急开关
          <el-tag v-if="switchesKnown && (switches.settlementPaused || switches.withdrawalPaused)" type="danger" size="small" effect="dark">
            已熔断
          </el-tag>
          <el-tag v-else-if="!switchesKnown" type="info" size="small">状态未知</el-tag>
        </div>
        <div class="switch-desc">
          发现资金异常（如对账不平、负余额）时一键止血：暂停后新的结算分账/提现出金将排队等待，恢复后自动继续。
        </div>
      </div>
      <div v-if="switchesKnown" class="switch-controls">
        <div class="switch-item">
          <span class="switch-label">结算暂停</span>
          <el-switch
            :model-value="switches.settlementPaused"
            :loading="switchLoading.settlement"
            @change="v => onSwitch('settlementPaused', v)"
          />
        </div>
        <div class="switch-item">
          <span class="switch-label">提现暂停</span>
          <el-switch
            :model-value="switches.withdrawalPaused"
            :loading="switchLoading.withdrawal"
            @change="v => onSwitch('withdrawalPaused', v)"
          />
        </div>
      </div>
      <div
        v-else
        class="switch-unknown"
        style="font-size: 12px; color: var(--el-color-warning); line-height: 1.7; max-width: 560px"
      >
        实时开关状态需「查看外部服务状态(integration:read)」权限，当前账号无法读取，故暂不展示开关以免误导。如需查看或操作应急开关，请使用具备该权限的账号。
      </div>
    </div>

    <div class="panel">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="提现单" name="withdrawals" />
        <el-tab-pane label="结算单" name="settlements" />
        <el-tab-pane label="对账差异" name="diffs" />
      </el-tabs>

      <!-- 提现单 -->
      <template v-if="activeTab === 'withdrawals'">
        <div class="filter-bar">
          <el-radio-group v-model="wStatus" @change="loadWithdrawals">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="applied">已申请</el-radio-button>
            <el-radio-button value="processing">出金中</el-radio-button>
            <el-radio-button value="done">已到账</el-radio-button>
            <el-radio-button value="failed">已失败</el-radio-button>
          </el-radio-group>
        </div>

        <el-table v-loading="wLoading" :data="wList" stripe>
          <el-table-column prop="id" label="单号" width="80" align="center" />
          <el-table-column label="零工" min-width="130">
            <template #default="{ row }">
              {{ row.workerName }}
              <span class="sub-id">#{{ row.workerId }}</span>
            </template>
          </el-table-column>
          <el-table-column label="金额" min-width="120" align="right">
            <template #default="{ row }">
              <span class="money">{{ fmtMoney(row.amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="银行卡" min-width="160">
            <template #default="{ row }"><span class="mono">{{ row.bankCard }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="withdrawTagType(row.status)" size="small" :effect="row.status === 'failed' ? 'dark' : 'plain'">
                {{ withdrawText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="失败原因" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.failReason }">{{ row.failReason || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="申请时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="完成时间" width="160">
            <template #default="{ row }">{{ row.doneAt ? fmtTime(row.doneAt) : '—' }}</template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无提现单" :image-size="90" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="wPage"
            v-model:page-size="wPageSize"
            :total="wTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadWithdrawals"
            @size-change="onWSizeChange"
          />
        </div>
      </template>

      <!-- 结算单 -->
      <template v-else-if="activeTab === 'settlements'">
        <div class="filter-bar">
          <el-radio-group v-model="sStatus" @change="loadSettlements">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="pending">处理中</el-radio-button>
            <el-radio-button value="done">已完成</el-radio-button>
            <el-radio-button value="failed">已失败</el-radio-button>
          </el-radio-group>
        </div>

        <el-table v-loading="sLoading" :data="sList" stripe>
          <el-table-column label="任务" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.taskTitle }}
              <span class="sub-id">#{{ row.taskId }}</span>
            </template>
          </el-table-column>
          <el-table-column label="确认单号" min-width="170">
            <template #default="{ row }"><span class="mono">{{ row.confirmNo }}</span></template>
          </el-table-column>
          <el-table-column label="实发" min-width="110" align="right">
            <template #default="{ row }">
              <span class="money net-amount">{{ fmtMoney(row.net) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="税费" min-width="100" align="right">
            <template #default="{ row }">
              <span class="money">{{ fmtMoney(row.tax) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="服务费" min-width="100" align="right">
            <template #default="{ row }">
              <span class="money">{{ fmtMoney(row.margin) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="settleTagType(row.status)" size="small" :effect="row.status === 'failed' ? 'dark' : 'plain'">
                {{ settleText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="已完成腿" min-width="220">
            <template #default="{ row }">
              <span v-if="!row.legsDone?.length" class="empty-dash">—</span>
              <el-tag
                v-for="leg in row.legsDone"
                :key="leg"
                type="success"
                size="small"
                effect="plain"
                class="leg-tag"
              >
                {{ legText(leg) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="重试" width="70" align="center">
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.attempts > 1 }">{{ row.attempts }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最后错误" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'fail-reason': row.lastError }">{{ row.lastError || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column v-if="canFlowWrite" label="操作" width="100" fixed="right" align="center">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'failed'"
                type="warning"
                link
                size="small"
                :loading="row.id === retryingId"
                @click="onRetry(row)"
              >
                人工重推
              </el-button>
              <span v-else class="empty-dash">—</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无结算单" :image-size="90" />
          </template>
        </el-table>
      </template>

      <!-- 对账差异 -->
      <template v-else>
        <div class="filter-bar">
          <el-radio-group v-model="dStatus" @change="loadDiffs">
            <el-radio-button value="open">待处置</el-radio-button>
            <el-radio-button value="resolved">已处置</el-radio-button>
            <el-radio-button value="all">全部</el-radio-button>
          </el-radio-group>
        </div>

        <el-table v-loading="dLoading" :data="dList" stripe>
          <el-table-column prop="day" label="对账日" width="110" align="center" />
          <el-table-column label="差异方向" width="120" align="center">
            <template #default="{ row }">
              <el-tag :type="row.side === 'bank_only' ? 'warning' : 'danger'" size="small" effect="plain">
                {{ sideText(row.side) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="参考单号" min-width="170">
            <template #default="{ row }"><span class="mono">{{ row.refNo || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="金额" width="120" align="right">
            <template #default="{ row }">
              <span class="money fail-reason">{{ fmtMoney(row.amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="差异说明" min-width="220" show-overflow-tooltip />
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === 'resolved' ? 'success' : 'danger'" size="small">
                {{ row.status === 'resolved' ? '已处置' : '待处置' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="处置说明" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ row.resolveNote || '—' }}</template>
          </el-table-column>
          <el-table-column v-if="canFlowWrite" label="操作" width="80" fixed="right" align="center">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'open'"
                type="primary"
                link
                size="small"
                @click="openResolveDiff(row)"
              >
                处 置
              </el-button>
              <span v-else class="empty-dash">—</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无对账差异，账实相符" :image-size="90" />
          </template>
        </el-table>
      </template>
    </div>

    <!-- 对账差异处置 -->
    <el-dialog v-model="diffDialog.visible" title="对账差异处置" width="480px" destroy-on-close>
      <el-alert
        v-if="diffDialog.row"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
      >
        <template #title>
          {{ diffDialog.row.day }} · {{ sideText(diffDialog.row.side) }} · {{ fmtMoney(diffDialog.row.amount) }}
        </template>
        {{ diffDialog.row.detail }}
      </el-alert>
      <el-form label-position="top">
        <el-form-item label="处置说明（必填）">
          <el-input
            v-model="diffDialog.note"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如：银行重复回执，已与存管行核实为同一笔出金，平台账无误"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="diffDialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="diffDialog.submitting" @click="submitResolveDiff">
          确认处置
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  getSettlements,
  getWithdrawals,
  getReconDiffs,
  resolveReconDiff,
  retrySettlement,
  setFundSwitches,
  getSystemHealth
} from '../api/admin'
import { withStepUp } from '../utils/stepup'
import { fmtMoney, fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canFlowWrite = computed(() => auth.can('flow:write'))
const canConfigWrite = computed(() => auth.can('config:write'))

const activeTab = ref('withdrawals')

// —— 提现单 ——
const wLoading = ref(false)
const wList = ref([])
const wTotal = ref(0)
const wPage = ref(1)
const wPageSize = ref(20)
const wStatus = ref('all')

// —— 结算单 ——
const sLoading = ref(false)
const sList = ref([])
const sStatus = ref('all')
const sLoaded = ref(false)
const retryingId = ref(0)

// —— 对账差异 ——
const dLoading = ref(false)
const dList = ref([])
const dStatus = ref('open')
const dLoaded = ref(false)
const diffDialog = reactive({ visible: false, row: null, note: '', submitting: false })

// —— 应急开关(状态来源:/admin/system-health) ——
const switches = reactive({ settlementPaused: false, withdrawalPaused: false })
const switchLoading = reactive({ settlement: false, withdrawal: false })
// 开关实时状态是否已成功读取（需 integration:read）：未知时不展示可能误导的 OFF 开关
const switchesKnown = ref(false)

const WITHDRAW_TEXT = { applied: '已申请', processing: '出金中', done: '已到账', failed: '已失败' }
const SETTLE_TEXT = { pending: '处理中', done: '已完成', failed: '已失败' }
const LEG_TEXT = { net: '实发打款', tax: '税费归集', margin: '服务费入账', invoice: '发票开具' }

function withdrawText(status) {
  return WITHDRAW_TEXT[status] || status
}

function withdrawTagType(status) {
  return { applied: 'primary', processing: 'warning', done: 'success', failed: 'danger' }[status] || 'info'
}

function settleText(status) {
  return SETTLE_TEXT[status] || status
}

function settleTagType(status) {
  return { pending: 'warning', done: 'success', failed: 'danger' }[status] || 'info'
}

function legText(leg) {
  return LEG_TEXT[leg] || leg
}

function sideText(side) {
  return { bank_only: '银行有/平台无', platform_only: '平台有/银行无' }[side] || side
}

async function loadWithdrawals() {
  wLoading.value = true
  try {
    const data = await getWithdrawals({
      status: wStatus.value,
      page: wPage.value,
      pageSize: wPageSize.value
    })
    wList.value = data.list
    wTotal.value = data.total
  } catch {
    /* 错误已统一提示 */
  } finally {
    wLoading.value = false
  }
}

function onWSizeChange() {
  wPage.value = 1
  loadWithdrawals()
}

async function loadSettlements() {
  sLoading.value = true
  try {
    const data = await getSettlements({ status: sStatus.value })
    sList.value = data.list
    sLoaded.value = true
  } catch {
    /* 错误已统一提示 */
  } finally {
    sLoading.value = false
  }
}

async function loadDiffs() {
  dLoading.value = true
  try {
    const data = await getReconDiffs({ status: dStatus.value })
    dList.value = data.list
    dLoaded.value = true
  } catch {
    /* 错误已统一提示 */
  } finally {
    dLoading.value = false
  }
}

// —— 结算单人工重推(flow:write + step-up) ——
async function onRetry(row) {
  try {
    await ElMessageBox.confirm(
      `确定人工重推结算单「${row.confirmNo}」吗？系统将按原分账方案重新执行未完成的腿。`,
      '人工重推确认',
      { type: 'warning', confirmButtonText: '确认重推', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  retryingId.value = row.id
  try {
    const r = await withStepUp(totp => retrySettlement(row.id, totp))
    if (r.status === 'done') {
      ElMessage.success('重推成功，结算单已完成')
    } else {
      ElMessage.warning(`重推未完成：${r.error || '仍有分账腿失败，已转入自动重试'}`)
    }
    loadSettlements()
  } catch {
    /* 错误已统一提示/用户取消 */
  } finally {
    retryingId.value = 0
  }
}

// —— 应急开关(config:write + 二次确认 + step-up) ——
async function loadSwitches() {
  // 开关状态来自 /admin/system-health(需 integration:read),无权限时置"未知"(不展示误导性 OFF)
  if (!auth.can('integration:read')) { switchesKnown.value = false; return }
  try {
    const health = await getSystemHealth()
    switches.settlementPaused = health.switches.settlementPaused
    switches.withdrawalPaused = health.switches.withdrawalPaused
    switchesKnown.value = true
  } catch {
    /* 错误已统一提示 */
  }
}

async function onSwitch(key, value) {
  const label = key === 'settlementPaused' ? '结算' : '提现'
  try {
    await ElMessageBox.confirm(
      value
        ? `确定暂停全平台${label}吗？暂停期间新的${label}请求将排队等待，并自动生成高风险预警。`
        : `确定恢复全平台${label}吗？排队中的${label}将自动继续执行。`,
      `${value ? '暂停' : '恢复'}${label}确认`,
      {
        type: 'warning',
        confirmButtonText: value ? `确认暂停${label}` : `确认恢复${label}`,
        cancelButtonText: '取消'
      }
    )
  } catch {
    return
  }
  const loadingKey = key === 'settlementPaused' ? 'settlement' : 'withdrawal'
  switchLoading[loadingKey] = true
  try {
    const res = await withStepUp(totp => setFundSwitches({ [key]: value }, totp))
    switches.settlementPaused = res.settlementPaused
    switches.withdrawalPaused = res.withdrawalPaused
    switchesKnown.value = true // 操作返回权威状态，状态即已知
    ElMessage.success(`${label}${value ? '已暂停' : '已恢复'}`)
  } catch {
    /* 错误已统一提示/用户取消 */
  } finally {
    switchLoading[loadingKey] = false
  }
}

function onTabChange() {
  // 首次切换时再拉取,避免无谓请求
  if (activeTab.value === 'settlements' && !sLoaded.value) {
    loadSettlements()
  } else if (activeTab.value === 'diffs' && !dLoaded.value) {
    loadDiffs()
  }
}

function openResolveDiff(row) {
  diffDialog.row = row
  diffDialog.note = ''
  diffDialog.visible = true
}

async function submitResolveDiff() {
  if (diffDialog.note.trim().length < 2) {
    ElMessage.warning('请填写处置说明')
    return
  }
  diffDialog.submitting = true
  try {
    await resolveReconDiff(diffDialog.row.id, diffDialog.note.trim())
    diffDialog.visible = false
    ElMessage.success('差异已处置')
    loadDiffs()
  } catch {
    /* 错误已统一提示 */
  } finally {
    diffDialog.submitting = false
  }
}

function reload() {
  if (activeTab.value === 'withdrawals') {
    loadWithdrawals()
  } else if (activeTab.value === 'settlements') {
    loadSettlements()
  } else {
    loadDiffs()
  }
  if (canConfigWrite.value) loadSwitches()
}

onMounted(() => {
  loadWithdrawals()
  if (canConfigWrite.value) loadSwitches()
})
</script>

<style scoped>
.filter-bar {
  margin-bottom: 14px;
}

.sub-id {
  font-size: 12px;
  color: var(--text-3);
}

.net-amount {
  color: var(--success);
  font-weight: 700;
}

.fail-reason {
  color: var(--danger);
}

.empty-dash {
  color: var(--text-3);
}

.leg-tag {
  margin-right: 6px;
}

/* —— 应急开关卡片 —— */
.switch-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 16px;
  border-left: 4px solid var(--danger);
}

.switch-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 8px;
}

.switch-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.switch-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 26px;
}

.switch-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.switch-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}

@media (max-width: 768px) {
  .switch-panel {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>
