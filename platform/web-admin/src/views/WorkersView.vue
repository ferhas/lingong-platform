<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">零工管理</h2>
        <p class="page-sub">实名核验、签约主体与年度收入概览</p>
      </div>
      <div class="page-actions">
        <el-button type="primary" plain :icon="Download" :loading="exporting" @click="onExport">
          导出名册
        </el-button>
        <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
      </div>
    </div>

    <div class="panel">
      <div class="filter-bar">
        <el-input
          v-model="filters.keyword"
          placeholder="按姓名搜索"
          clearable
          style="width: 180px"
          @keyup.enter="onFilter"
          @clear="onFilter"
        />
        <el-select v-model="filters.subjectType" style="width: 140px" @change="onFilter">
          <el-option label="全部主体" value="all" />
          <el-option label="自然人" value="person" />
          <el-option label="个体工商户" value="soletrader" />
        </el-select>
        <el-select v-model="filters.verified" style="width: 130px" @change="onFilter">
          <el-option label="实名不限" value="all" />
          <el-option label="已实名" value="1" />
          <el-option label="未实名" value="0" />
        </el-select>
        <el-select v-model="filters.status" style="width: 130px" @change="onFilter">
          <el-option label="状态不限" value="all" />
          <el-option label="正常" value="active" />
          <el-option label="已停用" value="disabled" />
        </el-select>
        <el-checkbox v-model="filters.lockedOnly" @change="onFilter">仅看已锁定</el-checkbox>
        <el-button :icon="Search" @click="onFilter">查询</el-button>
      </div>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="id" label="ID" width="70" align="center" />
        <el-table-column prop="name" label="姓名" min-width="110" />
        <el-table-column prop="phone" label="手机号" min-width="140">
          <template #default="{ row }">
            <span class="mono">{{ row.phone }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实名状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.verified ? 'success' : 'info'" size="small">
              {{ row.verified ? '已实名' : '未实名' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="主体类型" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="row.subjectType === 'soletrader' ? 'warning' : 'primary'" size="small" effect="plain">
              {{ subjectText(row.subjectType) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="接单锁定" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.locked" type="danger" size="small" effect="dark">已锁定</el-tag>
            <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="本年收入" min-width="120" align="right">
          <template #default="{ row }">
            <span class="money">{{ fmtMoney(row.yearGross) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" :width="canManage ? 150 : 90" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row.id)">详情</el-button>
            <template v-if="canManage">
              <el-button
                v-if="!row.locked"
                type="danger"
                link
                size="small"
                @click="toggleLock(row, true)"
              >
                锁 定
              </el-button>
              <el-button v-else type="success" link size="small" @click="toggleLock(row, false)">
                解 锁
              </el-button>
            </template>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无零工数据" :image-size="90" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="load"
          @size-change="onSizeChange"
        />
      </div>
    </div>

    <!-- 零工详情抽屉 -->
    <el-drawer v-model="drawer.visible" title="零工详情" size="620px" destroy-on-close>
      <div v-loading="drawer.loading" class="detail-body">
        <template v-if="drawer.data">
          <!-- 档案 -->
          <div class="detail-section">
            <div class="detail-section-title">
              基本档案
              <el-button
                v-if="canReadPii && !pii.data"
                type="warning"
                size="small"
                plain
                :loading="pii.loading"
                class="pii-btn"
                @click="onViewPii"
              >
                查看完整 PII
              </el-button>
            </div>
            <el-alert
              v-if="pii.data"
              type="warning"
              :closable="false"
              show-icon
              style="margin-bottom: 10px"
            >
              <template #title>完整个人信息（本次查看已记录审计日志）</template>
              <span class="pii-field">姓名：{{ pii.data.realName || pii.data.name }}</span>
              <span class="pii-field">手机号：<span class="mono">{{ pii.data.phone }}</span></span>
              <span class="pii-field">身份证号：<span class="mono">{{ pii.data.idCard }}</span></span>
            </el-alert>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="姓名">{{ drawer.data.worker.name }}</el-descriptions-item>
              <el-descriptions-item label="手机号">
                <span class="mono">{{ drawer.data.worker.phone }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="实名状态">
                <el-tag :type="drawer.data.worker.verified ? 'success' : 'info'" size="small">
                  {{ drawer.data.worker.verified ? '已实名' : '未实名' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="主体类型">
                {{ subjectText(drawer.data.worker.subjectType) }}
              </el-descriptions-item>
              <el-descriptions-item label="接单状态">
                <el-tag :type="drawer.data.worker.locked ? 'danger' : 'success'" size="small">
                  {{ drawer.data.worker.locked ? '已锁定' : '正常' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="银行卡">
                <span class="mono">{{ drawer.data.worker.bankCard || '—' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="分包框架协议号">
                <span class="mono">{{ drawer.data.worker.frameContractNo || '—' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="注册时间">
                {{ fmtTime(drawer.data.worker.createdAt) }}
              </el-descriptions-item>
            </el-descriptions>
          </div>

          <!-- 账户 -->
          <div class="detail-section">
            <div class="detail-section-title">资金账户</div>
            <div v-if="drawer.data.account" class="acct-grid">
              <div class="acct-cell">
                <div class="acct-label">可用余额</div>
                <div class="acct-num">{{ fmtMoney(drawer.data.account.balance) }}</div>
              </div>
              <div class="acct-cell">
                <div class="acct-label">冻结金额（提现在途）</div>
                <div class="acct-num acct-frozen">{{ fmtMoney(drawer.data.account.frozen) }}</div>
              </div>
            </div>
            <el-empty v-else description="尚未开通资金账户" :image-size="60" />
          </div>

          <!-- 接单状态分布 -->
          <div class="detail-section">
            <div class="detail-section-title">接单状态分布</div>
            <div v-if="drawer.data.orderStats.length" class="order-stats">
              <el-tag
                v-for="o in drawer.data.orderStats"
                :key="o.status"
                :type="taskStatusTagType(o.status)"
                effect="plain"
                size="large"
              >
                {{ taskStatusText(o.status) }}：{{ o.count }} 单
              </el-tag>
            </div>
            <el-empty v-else description="暂无接单记录" :image-size="50" />
          </div>

          <!-- 近10条收入 -->
          <div class="detail-section">
            <div class="detail-section-title">近10条收入记录</div>
            <el-table :data="drawer.data.recentIncome" size="small" border>
              <el-table-column prop="taskTitle" label="任务" min-width="150" show-overflow-tooltip />
              <el-table-column label="税前" width="100" align="right">
                <template #default="{ row }">
                  <span class="money">{{ fmtMoney(row.gross) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="税费" width="90" align="right">
                <template #default="{ row }">
                  <span class="money">{{ fmtMoney(row.tax) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="实收" width="100" align="right">
                <template #default="{ row }">
                  <span class="money income-net">{{ fmtMoney(row.net) }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="period" label="所属期" width="90" align="center" />
              <template #empty>
                <el-empty description="暂无收入记录" :image-size="50" />
              </template>
            </el-table>
          </div>

          <!-- 合同 -->
          <div class="detail-section">
            <div class="detail-section-title">签署合同</div>
            <el-table :data="drawer.data.contracts" size="small" border>
              <el-table-column label="类型" width="130">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain">{{ contractTypeText(row.type) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="合同编号" min-width="180">
                <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
              </el-table-column>
              <el-table-column label="签署时间" width="150">
                <template #default="{ row }">{{ fmtTime(row.signedAt) }}</template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无合同" :image-size="50" />
              </template>
            </el-table>
          </div>

          <!-- 关联预警 -->
          <div class="detail-section">
            <div class="detail-section-title">关联风控预警</div>
            <el-empty
              v-if="drawer.data.alerts.length === 0"
              description="暂无关联预警"
              :image-size="50"
            />
            <div v-for="a in drawer.data.alerts" :key="a.id" class="mini-alert">
              <div class="mini-alert-head">
                <el-tag :type="alertLevelTagType(a.level)" size="small" effect="dark">{{ a.level }}风险</el-tag>
                <span class="mini-alert-type">{{ a.type }}</span>
                <el-tag :type="a.status === 'resolved' ? 'success' : 'danger'" size="small" effect="plain">
                  {{ a.status === 'resolved' ? '已处理' : '待处理' }}
                </el-tag>
              </div>
              <div class="mini-alert-detail">{{ a.detail }}</div>
              <div class="mini-alert-time">{{ fmtTime(a.createdAt) }}</div>
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
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Download, Search } from '@element-plus/icons-vue'
import { getWorkers, getWorkerDetail, lockWorker, getWorkerPii } from '../api/admin'
import { fmtMoney, fmtTime, today } from '../utils/format'
import { downloadCsv } from '../utils/download'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const auth = useAuthStore()
const canManage = computed(() => auth.can('worker:manage'))
const canReadPii = computed(() => auth.can('user:read_pii'))

const loading = ref(false)
const exporting = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const drawer = reactive({ visible: false, loading: false, data: null })

const filters = reactive({ keyword: '', subjectType: 'all', verified: 'all', status: 'all', lockedOnly: false })

const TASK_STATUS_TEXT = {
  recruiting: '报名中',
  working: '进行中',
  delivered: '待验收',
  settled: '已结算',
  cancelled: '已取消'
}

function subjectText(type) {
  return { person: '自然人', soletrader: '个体工商户' }[type] || type || '—'
}

function taskStatusText(status) {
  return TASK_STATUS_TEXT[status] || status
}

function taskStatusTagType(status) {
  return {
    recruiting: 'primary',
    working: 'warning',
    delivered: 'info',
    settled: 'success',
    cancelled: 'danger'
  }[status] || 'info'
}

function contractTypeText(type) {
  return {
    master: '总承揽框架合同',
    frame_sub: '分包框架合同',
    work_order: '工单合同',
    sub_order: '分包工单合同'
  }[type] || type
}

function alertLevelTagType(level) {
  return level === '高' ? 'danger' : level === '中' ? 'warning' : 'info'
}

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (filters.keyword.trim()) params.keyword = filters.keyword.trim()
    if (filters.subjectType !== 'all') params.subjectType = filters.subjectType
    if (filters.verified !== 'all') params.verified = filters.verified
    if (filters.status !== 'all') params.status = filters.status
    if (filters.lockedOnly) params.locked = '1'
    const data = await getWorkers(params)
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

// —— 详情抽屉 ——
async function openDetail(id) {
  drawer.visible = true
  drawer.loading = true
  drawer.data = null
  pii.data = null
  try {
    drawer.data = await getWorkerDetail(id)
  } catch {
    drawer.visible = false
  } finally {
    drawer.loading = false
  }
}

// —— 完整 PII 查看(user:read_pii 专项权限,服务端记录审计) ——
const pii = reactive({ loading: false, data: null })

async function onViewPii() {
  try {
    await ElMessageBox.confirm(
      '查看完整手机号与身份证号属于敏感操作，将记录审计日志。确定查看？',
      '敏感信息查看确认',
      { type: 'warning', confirmButtonText: '确认查看', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  pii.loading = true
  try {
    pii.data = await getWorkerPii(drawer.data.worker.id)
  } catch {
    /* 错误已统一提示 */
  } finally {
    pii.loading = false
  }
}

async function toggleLock(row, lock) {
  const action = lock ? '锁定' : '解锁'
  try {
    await ElMessageBox.confirm(
      lock
        ? `确定锁定「${row.name}」的接单权限吗?锁定后该零工无法报名新任务。`
        : `确定恢复「${row.name}」的接单权限吗?`,
      `${action}确认`,
      { type: 'warning', confirmButtonText: `确认${action}`, cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await lockWorker(row.id, lock)
    ElMessage.success(`已${action}该零工的接单权限`)
    load()
  } catch {
    /* 错误已统一提示 */
  }
}

async function onExport() {
  exporting.value = true
  try {
    await downloadCsv('/admin/workers/export', `零工名册_${today()}.csv`)
    ElMessage.success('名册已导出')
  } catch {
    /* 错误已统一提示 */
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  load()
  // 风控预警等页面通过 ?focus=零工ID 跳转,自动打开详情抽屉
  const focus = Number(route.query.focus)
  if (focus) openDetail(focus)
})
</script>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
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

.pii-btn {
  margin-left: 10px;
}

.pii-field {
  margin-right: 16px;
}

.acct-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.acct-cell {
  background: var(--bg-hover);
  border-radius: 10px;
  padding: 12px 16px;
}

.acct-label {
  font-size: 12px;
  color: var(--text-3);
}

.acct-num {
  margin-top: 6px;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.acct-frozen {
  color: var(--warning);
}

.order-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.income-net {
  color: var(--success);
  font-weight: 700;
}

.mini-alert {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.mini-alert-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini-alert-type {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.mini-alert-detail {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
}

.mini-alert-time {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
