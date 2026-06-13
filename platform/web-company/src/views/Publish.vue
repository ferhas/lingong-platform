<template>
  <div>
    <!-- 余额不足引导 -->
    <el-alert v-if="insufficient" type="warning" show-icon :closable="false" class="balance-alert">
      <template #title>
        <TermTip term="存管户" />可用余额 ¥{{ fmtMoney(available) }}，不足以冻结本次预算 ¥{{ fmtMoney(form.price) }}，发布将被拦截
      </template>
      <el-button type="primary" size="small" class="recharge-btn" @click="router.push('/funds')">去充值</el-button>
    </el-alert>

    <el-alert
      type="warning"
      show-icon
      :closable="false"
      class="compliance-alert"
      title="合规提示"
      description="平台禁止发布按月固定薪资、打卡考勤类任务（承揽合规要求）。任务须以成果交付为导向，命中违禁词将被风控阻断并产生预警。"
    />

    <div class="page-card publish-card">
      <div class="publish-head">
        <h3 class="page-title">发布任务</h3>
        <el-button type="primary" link @click="router.push('/batch-publish')">
          <el-icon style="margin-right: 4px"><Files /></el-icon>多个任务？试试批量发单
        </el-button>
      </div>
      <div class="publish-body">
        <el-form ref="formRef" :model="form" :rules="rules" label-width="100px" class="publish-form">
          <el-form-item label="任务标题" prop="title">
            <el-input v-model="form.title" maxlength="80" show-word-limit placeholder="例如：电商主图设计（10 张）" />
          </el-form-item>

          <el-form-item label="任务类目" prop="category">
            <el-select v-model="form.category" placeholder="请选择类目" style="width: 240px">
              <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>

          <el-form-item label="工种（选填）" prop="trade">
            <el-select v-model="form.trade" placeholder="细分工种，便于零工按技能匹配" clearable style="width: 240px">
              <el-option v-for="t in trades" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>

          <el-form-item label="工作地点" prop="city">
            <el-select v-model="form.city" placeholder="线上任务选「远程」" style="width: 240px">
              <el-option v-for="c in cities" :key="c" :label="c" :value="c" />
            </el-select>
            <span class="form-tip">线下作业（配送/安装/施工）将自动投保高保额方案</span>
          </el-form-item>

          <el-form-item label="计酬方式" prop="payMethod">
            <el-radio-group v-model="form.payMethod">
              <el-radio-button v-for="m in payMethods" :key="m" :value="m">{{ m }}</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="预算金额" prop="price">
            <el-input-number
              v-model="form.price"
              :min="0.01"
              :max="1000000"
              :precision="2"
              :step="100"
              :controls="false"
              style="width: 240px"
              placeholder="发布后将从存管户冻结该金额"
            />
            <span class="form-tip">元，发布后将从<TermTip term="存管户" />冻结该金额</span>
          </el-form-item>

          <el-form-item label="截止日期" prop="deadline">
            <el-date-picker
              v-model="form.deadline"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="选择截止日期"
              :disabled-date="d => d.getTime() < Date.now() - 86400000"
              style="width: 240px"
            />
          </el-form-item>

          <el-form-item label="任务描述" prop="description">
            <el-input
              v-model="form.description"
              type="textarea"
              :rows="5"
              maxlength="2000"
              show-word-limit
              placeholder="请清晰描述任务内容、范围与要求（以成果交付为导向）"
            />
          </el-form-item>

          <el-form-item label="交付标准" prop="standard">
            <el-input
              v-model="form.standard"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-word-limit
              placeholder="验收时将依据交付标准判断，例如：提供源文件 + 可商用授权"
            />
          </el-form-item>

          <el-form-item>
            <el-popconfirm
              :title="`发布后将从存管户冻结预算 ¥${fmtMoney(form.price || 0)}，零工即可看到任务并报名。是否继续？`"
              confirm-button-text="继续发布"
              cancel-button-text="再想想"
              width="300"
              @confirm="onSubmit"
            >
              <template #reference>
                <el-button type="primary" size="large" :loading="submitting">发布任务</el-button>
              </template>
            </el-popconfirm>
            <el-button size="large" @click="onReset">重置</el-button>
          </el-form-item>
        </el-form>

        <!-- 费用速算（v4：发布前税负测算预览） -->
        <div class="estimate-card" v-loading="estimateLoading">
          <div class="estimate-title">
            <el-icon><DataLine /></el-icon>费用速算
          </div>
          <template v-if="estimate">
            <div class="estimate-row total-row">
              <span class="estimate-label">
                <TermTip term="承揽价" text="任务总价（承揽价）" />
              </span>
              <span class="money estimate-value">¥{{ fmtMoney(estimate.price) }}</span>
            </div>
            <el-divider class="estimate-divider" />
            <div class="estimate-row">
              <span class="estimate-label">
                <TermTip term="分包价" text="零工税前所得（分包价）" />
              </span>
              <span class="money estimate-value strong">¥{{ fmtMoney(estimate.subPrice) }}</span>
            </div>
            <div class="estimate-row">
              <span class="estimate-label">平台服务费</span>
              <span class="money estimate-value">¥{{ fmtMoney(estimate.platformFee) }}</span>
            </div>
            <div class="estimate-row">
              <span class="estimate-label">预计税费</span>
              <span class="money estimate-value">¥{{ fmtMoney(estimate.estimatedVat) }}</span>
            </div>
            <div class="estimate-row">
              <span class="estimate-label">保险费</span>
              <span class="money estimate-value">¥{{ fmtMoney(estimate.insurance) }}</span>
            </div>
            <div v-if="estimate.note" class="estimate-note">{{ estimate.note }}</div>
            <el-alert
              v-if="estimate.safe === false"
              type="warning"
              show-icon
              :closable="false"
              class="estimate-warn"
              title="该价格下平台税负承压，可能影响接单服务"
            />
          </template>
          <el-empty v-else description="输入预算金额即可预览费用构成" :image-size="64" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useDebounceFn } from '@vueuse/core'
import { publishTask, getCompanyMeta, getEstimate } from '../api/company'
import { useProfileStore } from '../stores/profile'
import { fmtMoney } from '../utils/format'
import TermTip from '../components/TermTip.vue'

const router = useRouter()
const profileStore = useProfileStore()

// 兜底默认值：/company/meta 加载失败时回退
const DEFAULT_CATEGORIES = ['设计', '技术', '翻译', '文案', '视频', '配送', '安装', '施工', '其他']
const DEFAULT_PAY_METHODS = ['按成果', '按件', '按单']
const DEFAULT_CITIES = ['远程', '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '其他']

const categories = ref(DEFAULT_CATEGORIES)
const payMethods = ref(DEFAULT_PAY_METHODS)
const cities = ref(DEFAULT_CITIES)
const trades = ref([])

onMounted(async () => {
  // 余额不足提示依赖账户信息
  if (!profileStore.profile) profileStore.fetch().catch(() => {})
  try {
    const meta = await getCompanyMeta()
    if (Array.isArray(meta?.categories) && meta.categories.length) categories.value = meta.categories
    if (Array.isArray(meta?.payMethods) && meta.payMethods.length) payMethods.value = meta.payMethods
    if (Array.isArray(meta?.cities) && meta.cities.length) cities.value = meta.cities
    if (Array.isArray(meta?.trades)) trades.value = meta.trades
    // 当前选中的计酬方式不在动态列表中时，回到列表第一项
    if (!payMethods.value.includes(form.payMethod)) form.payMethod = payMethods.value[0]
  } catch {
    // 静默失败，使用默认值
  }
})

const formRef = ref()
const submitting = ref(false)

const form = reactive({
  title: '',
  category: '',
  trade: '',
  city: '远程',
  payMethod: '按成果',
  price: undefined,
  deadline: '',
  description: '',
  standard: ''
})

// —— 余额不足引导 ——
const available = computed(() => profileStore.profile?.account?.available)
const insufficient = computed(
  () => Number(form.price) > 0 && available.value !== undefined && Number(form.price) > Number(available.value)
)

// —— 费用速算：金额/类目变化防抖 500ms 调测算接口 ——
const estimate = ref(null)
const estimateLoading = ref(false)
let estimateSeq = 0

async function fetchEstimate() {
  const price = Number(form.price)
  if (!price || price <= 0) {
    estimate.value = null
    estimateLoading.value = false
    return
  }
  const seq = ++estimateSeq
  estimateLoading.value = true
  try {
    const data = await getEstimate(price, form.category)
    if (seq === estimateSeq) estimate.value = data
  } catch {
    if (seq === estimateSeq) estimate.value = null
  } finally {
    if (seq === estimateSeq) estimateLoading.value = false
  }
}

const debouncedEstimate = useDebounceFn(fetchEstimate, 500)

watch(
  () => [form.price, form.category],
  () => {
    if (!form.price || Number(form.price) <= 0) {
      // 金额清空：立即回到引导文案
      estimateSeq++
      estimate.value = null
      estimateLoading.value = false
      return
    }
    debouncedEstimate()
  }
)

const rules = {
  title: [
    { required: true, message: '请输入任务标题', trigger: 'blur' },
    { min: 2, max: 80, message: '标题长度应为 2 至 80 个字符', trigger: 'blur' }
  ],
  category: [{ required: true, message: '请选择任务类目', trigger: 'change' }],
  payMethod: [{ required: true, message: '请选择计酬方式', trigger: 'change' }],
  price: [{ required: true, message: '请输入预算金额', trigger: 'blur' }],
  deadline: [{ required: true, message: '请选择截止日期', trigger: 'change' }],
  description: [
    { required: true, message: '请输入任务描述', trigger: 'blur' },
    { min: 5, max: 2000, message: '任务描述至少 5 个字符', trigger: 'blur' }
  ]
}

async function onSubmit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  submitting.value = true
  try {
    const res = await publishTask({
      title: form.title,
      category: form.category,
      trade: form.trade || undefined,
      city: form.city || '远程',
      payMethod: form.payMethod,
      price: form.price,
      deadline: form.deadline,
      description: form.description,
      standard: form.standard || ''
    })
    ElMessage({
      type: 'success',
      duration: 6000,
      message: `发布成功，任务工单号 ${res.workOrderNo}，已冻结预算 ¥${fmtMoney(res.frozen)}。零工报名后您会收到站内通知`
    })
    profileStore.fetch().catch(() => {})
    router.push('/tasks')
  } catch {
    // 后端 400（违禁词 / 余额不足 / 未准入）已由拦截器展示 message
  } finally {
    submitting.value = false
  }
}

function onReset() {
  formRef.value.resetFields()
}
</script>

<style scoped>
.compliance-alert,
.balance-alert {
  margin-bottom: 16px;
  border-radius: 12px;
}

.recharge-btn {
  margin-top: 6px;
}

.publish-card {
  max-width: 1080px;
}

.publish-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.publish-body {
  display: flex;
  gap: 28px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.publish-form {
  flex: 1 1 520px;
  max-width: 720px;
  margin-top: 8px;
}

.form-tip {
  margin-left: 10px;
  color: var(--text-3);
  font-size: 12px;
}

/* —— 费用速算卡 —— */
.estimate-card {
  flex: 0 1 280px;
  min-width: 250px;
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-hover);
  padding: 18px 20px;
  position: sticky;
  top: 16px;
}

.estimate-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 14px;
}

.estimate-title .el-icon {
  color: var(--brand);
}

.estimate-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin: 9px 0;
  font-size: 13px;
}

.estimate-label {
  color: var(--text-2);
}

.estimate-value {
  color: var(--text-1);
}

.estimate-value.strong {
  font-weight: 700;
  color: var(--brand);
}

.total-row .estimate-value {
  font-weight: 700;
  font-size: 15px;
}

.estimate-divider {
  margin: 10px 0;
}

.estimate-note {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}

.estimate-warn {
  margin-top: 12px;
  border-radius: 8px;
}
</style>
