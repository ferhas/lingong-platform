<template>
  <div>
    <!-- 余额卡 -->
    <div v-loading="profileStore.loading" class="balance-card">
      <div class="balance-main">
        <div class="balance-label">可用余额（元）</div>
        <div class="balance-value money">¥{{ fmtMoney(account?.available) }}</div>
      </div>
      <div class="balance-sub">
        <div class="balance-item">
          <div class="balance-item-label">冻结金额</div>
          <div class="balance-item-value money">¥{{ fmtMoney(account?.frozen) }}</div>
        </div>
        <div class="balance-divider"></div>
        <div class="balance-item">
          <div class="balance-item-label">账户总额</div>
          <div class="balance-item-value money">¥{{ fmtMoney(account?.balance) }}</div>
        </div>
      </div>
      <div class="balance-actions">
        <el-button v-if="auth.canRecharge" size="large" class="recharge-btn" @click="openCashier">
          <el-icon style="margin-right: 6px"><Wallet /></el-icon>充值
        </el-button>
        <div class="balance-note">
          资金由<TermTip term="存管户" text="银行存管虚拟户" />托管，发布任务冻结、验收后划扣
          <span v-if="!auth.canRecharge">（充值需企业主或财务角色）</span>
        </div>
      </div>
    </div>

    <!-- 充值单 -->
    <div class="page-card">
      <div class="card-head">
        <h3 class="page-title">充值单</h3>
        <el-button :icon="Refresh" circle size="small" aria-label="刷新充值单" @click="fetchOrders" />
      </div>
      <el-table v-loading="ordersLoading" :data="orders" stripe>
        <el-table-column prop="no" label="充值单号" width="200">
          <template #default="{ row }"><span class="mono">{{ row.no }}</span></template>
        </el-table-column>
        <el-table-column label="金额" width="140" align="right">
          <template #default="{ row }">
            <span class="money">¥{{ fmtMoney(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="专属入金账号" min-width="180">
          <template #default="{ row }"><span class="mono">{{ row.payAccount || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="orderMeta(row.status).tag" effect="light" size="small">
              {{ orderMeta(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="存管流水号" min-width="160">
          <template #default="{ row }"><span class="mono">{{ row.escrowTxnNo || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="到账时间" width="170">
          <template #default="{ row }">{{ fmtDateTime(row.paidAt) }}</template>
        </el-table-column>
        <el-table-column v-if="isDev && auth.canRecharge" label="操作" width="110" fixed="right" align="center">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'created'"
              type="primary"
              link
              size="small"
              :loading="mockPayingNo === row.no"
              @click="onMockPay(row)"
            >
              模拟入金
            </el-button>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无充值单，点击右上方「充值」创建" :image-size="72" />
        </template>
      </el-table>
    </div>

    <!-- 流水 -->
    <div class="page-card">
      <h3 class="page-title">资金流水</h3>
      <el-table v-loading="loading" :data="flows" stripe>
        <el-table-column prop="id" label="流水号" width="90" />
        <el-table-column label="类型" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="flowMeta(row.type).tag" effect="light">{{ flowMeta(row.type).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="140" align="right">
          <template #default="{ row }">
            <span class="money" :class="amountClass(row)">{{ amountText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="变动后余额" width="140" align="right">
          <template #default="{ row }">
            <span class="money">¥{{ fmtMoney(row.balanceAfter) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="220" show-overflow-tooltip />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无资金流水" />
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
          @current-change="fetchFlows"
          @size-change="onSizeChange"
        />
      </div>
    </div>

    <!-- 充值单收银台 -->
    <el-dialog
      v-model="cashierVisible"
      :title="cashierStep === 'input' ? '存管户充值' : '充值单已创建 · 对公转账入金'"
      width="520px"
      destroy-on-close
      @closed="resetCashier"
    >
      <!-- 第一步：填金额创建充值单 -->
      <template v-if="cashierStep === 'input'">
        <el-alert
          type="info"
          :closable="false"
          title="创建充值单后将获得专属入金账户，使用企业对公账户转账，银行确认后自动到账"
          style="margin-bottom: 16px"
        />
        <el-form @submit.prevent>
          <el-form-item label="充值金额">
            <el-input-number
              v-model="rechargeAmount"
              :min="0.01"
              :max="10000000"
              :precision="2"
              :step="1000"
              :controls="false"
              style="width: 100%"
              placeholder="请输入充值金额（元）"
            />
          </el-form-item>
        </el-form>
      </template>

      <!-- 第二步：展示专属入金账户 -->
      <template v-else>
        <el-result icon="success" title="充值单创建成功" class="cashier-result">
          <template #sub-title>
            请在 {{ cashierOrder.expireMinutes }} 分钟内完成对公转账，逾期充值单将自动失效
          </template>
        </el-result>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="充值单号">
            <span class="mono">{{ cashierOrder.orderNo }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="转账金额">
            <span class="money cashier-amount">¥{{ fmtMoney(cashierOrder.amount) }}</span>
            <span class="cashier-tip">（金额须与充值单完全一致）</span>
          </el-descriptions-item>
          <el-descriptions-item label="收款户名">{{ cashierOrder.payee }}</el-descriptions-item>
          <el-descriptions-item label="开户银行">{{ cashierOrder.payBank }}</el-descriptions-item>
          <el-descriptions-item label="收款账号">
            <span class="mono">{{ cashierOrder.payAccount }}</span>
            <el-button type="primary" link size="small" @click="copyText(cashierOrder.payAccount)">复制</el-button>
          </el-descriptions-item>
          <el-descriptions-item label="有效期">{{ cashierOrder.expireMinutes }} 分钟</el-descriptions-item>
        </el-descriptions>
        <el-alert v-if="cashierOrder.note" type="warning" show-icon :closable="false" class="cashier-note" :title="cashierOrder.note" />
      </template>

      <template #footer>
        <template v-if="cashierStep === 'input'">
          <el-button @click="cashierVisible = false">取消</el-button>
          <el-button type="primary" :loading="creating" @click="onCreateOrder">创建充值单</el-button>
        </template>
        <template v-else>
          <el-button
            v-if="isDev"
            type="warning"
            plain
            :loading="mockPayingNo === cashierOrder.orderNo"
            @click="onMockPay({ no: cashierOrder.orderNo })"
          >
            模拟入金（开发）
          </el-button>
          <el-button type="primary" @click="cashierVisible = false">我已知晓，去转账</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { createRechargeOrder, getRechargeOrders, mockPayRechargeOrder, getFlows } from '../api/company'
import { useProfileStore } from '../stores/profile'
import { useAuthStore } from '../stores/auth'
import { fmtMoney, fmtDateTime, FLOW_TYPE, RECHARGE_ORDER_STATUS } from '../utils/format'
import TermTip from '../components/TermTip.vue'

const isDev = import.meta.env.DEV

const auth = useAuthStore()
const profileStore = useProfileStore()
const account = computed(() => profileStore.profile?.account)

const flows = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)

// —— 充值单 ——
const orders = ref([])
const ordersLoading = ref(false)
const orderMeta = s => RECHARGE_ORDER_STATUS[s] || { label: s || '—', tag: 'info' }

// —— 收银台对话框 ——
const cashierVisible = ref(false)
const cashierStep = ref('input')
const rechargeAmount = ref(undefined)
const creating = ref(false)
const cashierOrder = ref({})
const mockPayingNo = ref(null)

const flowMeta = t => FLOW_TYPE[t] || { label: t, tag: 'info' }

const OUT_TYPES = ['freeze', 'settle_out', 'withdraw']
function amountText(row) {
  const sign = OUT_TYPES.includes(row.type) ? '-' : '+'
  return `${sign}¥${fmtMoney(Math.abs(row.amount))}`
}
function amountClass(row) {
  return OUT_TYPES.includes(row.type) ? 'amount-out' : 'amount-in'
}

async function fetchFlows() {
  loading.value = true
  try {
    const data = await getFlows(page.value, pageSize.value)
    flows.value = data.list
    total.value = data.total
  } finally {
    loading.value = false
  }
}

function onSizeChange() {
  page.value = 1
  fetchFlows()
}

async function fetchOrders() {
  ordersLoading.value = true
  try {
    const data = await getRechargeOrders()
    orders.value = data.list || []
  } finally {
    ordersLoading.value = false
  }
}

function openCashier() {
  cashierStep.value = 'input'
  cashierVisible.value = true
}

function resetCashier() {
  cashierStep.value = 'input'
  rechargeAmount.value = undefined
  cashierOrder.value = {}
}

async function onCreateOrder() {
  if (!rechargeAmount.value || rechargeAmount.value <= 0) {
    ElMessage.warning('请输入有效的充值金额')
    return
  }
  creating.value = true
  try {
    cashierOrder.value = await createRechargeOrder(rechargeAmount.value)
    cashierStep.value = 'pay'
    fetchOrders()
  } catch {
    // 错误已由拦截器提示
  } finally {
    creating.value = false
  }
}

async function onMockPay(order) {
  mockPayingNo.value = order.no
  try {
    await mockPayRechargeOrder(order.no)
    ElMessage.success('已模拟银行入金，资金已到账存管户')
    cashierVisible.value = false
    page.value = 1
    await Promise.all([profileStore.fetch(), fetchOrders(), fetchFlows()])
  } catch {
    // 错误已由拦截器提示
  } finally {
    mockPayingNo.value = null
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text))
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动复制')
  }
}

onMounted(() => {
  profileStore.fetch().catch(() => {})
  fetchOrders()
  fetchFlows()
})
</script>

<style scoped>
.balance-card {
  background: var(--brand-gradient);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.25);
  color: #fff;
  padding: 28px 32px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 48px;
  flex-wrap: wrap;
}

.balance-label {
  font-size: 13px;
  opacity: 0.85;
  margin-bottom: 8px;
}

.balance-value {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.1;
}

.balance-sub {
  display: flex;
  align-items: center;
  gap: 28px;
}

.balance-divider {
  width: 1px;
  height: 40px;
  background: rgba(255, 255, 255, 0.25);
}

.balance-item-label {
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 6px;
}

.balance-item-value {
  font-size: 22px;
  font-weight: 600;
}

.balance-actions {
  margin-left: auto;
  text-align: right;
}

.recharge-btn {
  background: #fff;
  color: var(--brand);
  border: none;
  font-weight: 600;
}

.balance-note {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.8;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.amount-in {
  color: var(--success);
  font-weight: 600;
}

.amount-out {
  color: var(--danger);
  font-weight: 600;
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

/* —— 收银台 —— */
.cashier-result {
  padding: 8px 0 16px;
}

.cashier-amount {
  font-size: 16px;
  font-weight: 700;
  color: var(--brand);
}

.cashier-tip {
  margin-left: 6px;
  font-size: 12px;
  color: var(--text-3);
}

.cashier-note {
  margin-top: 14px;
  border-radius: 8px;
}
</style>
