<template>
  <div>
    <!-- 余额不足引导 -->
    <el-alert v-if="insufficient" type="warning" show-icon :closable="false" class="balance-alert">
      <template #title>
        <TermTip term="存管户" />可用余额 ¥{{ fmtMoney(available) }}，不足以冻结本次预算 ¥{{
          fmtMoney(form.price)
        }}，发布将被拦截
      </template>
      <el-button type="primary" size="small" class="recharge-btn" @click="router.push('/funds')"
        >去充值</el-button
      >
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
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-width="100px"
          class="publish-form"
        >
          <el-form-item label="任务标题" prop="title">
            <el-input
              v-model="form.title"
              maxlength="80"
              show-word-limit
              placeholder="例如：电商主图设计（10 张）"
            />
          </el-form-item>

          <el-form-item label="任务类目" prop="category">
            <el-select v-model="form.category" placeholder="请选择类目" style="width: 240px">
              <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
            </el-select>
            <span v-if="isOffline" class="form-tip"
              >线下作业类目，将自动投保高保额方案，并需选择具体工作城市</span
            >
          </el-form-item>

          <el-form-item label="工种（选填）" prop="trade">
            <el-select
              v-model="form.trade"
              :placeholder="tradePlaceholder"
              :disabled="!form.category || !availableTrades.length"
              clearable
              style="width: 240px"
            >
              <el-option v-for="t in availableTrades" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>

          <el-form-item label="工作地点" prop="city">
            <el-select
              v-model="form.city"
              :placeholder="isOffline ? '请选择具体工作城市' : '线上任务选「远程」'"
              style="width: 240px"
            >
              <el-option
                v-for="c in cities"
                :key="c"
                :label="c"
                :value="c"
                :disabled="isOffline && c === '远程'"
              />
            </el-select>
            <span class="form-tip"
              >线下作业类目（{{
                offlineCategories.join('/')
              }}）会自动投保高保额方案；线上任务选「远程」即可</span
            >
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
              placeholder="请输入预算金额"
            />
            <span class="form-tip">元，发布后将从<TermTip term="存管户" />冻结该金额</span>
          </el-form-item>

          <el-form-item label="截止日期" prop="deadline">
            <el-date-picker
              v-model="form.deadline"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="选择截止日期"
              :disabled-date="(d) => d.getTime() < Date.now() - 86400000"
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
            <el-button type="primary" size="large" :loading="submitting" @click="onSubmit"
              >发布任务</el-button
            >
            <el-button size="large" @click="onReset">重置</el-button>
          </el-form-item>
        </el-form>

        <!-- 费用速算（v4：发布前税负测算预览） -->
        <div v-loading="estimateLoading" class="estimate-card">
          <div class="estimate-title">
            <el-icon><DataLine /></el-icon>费用速算
          </div>
          <template v-if="estimate">
            <div class="estimate-total">
              <span class="estimate-total-label">
                <TermTip term="承揽价" text="任务总价（承揽价）" />
              </span>
              <span class="money estimate-total-value">¥{{ fmtMoney(estimate.price) }}</span>
            </div>
            <div class="estimate-breakdown-label">费用构成</div>
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
import { ElMessage, ElMessageBox } from 'element-plus'
import { useDebounceFn } from '@vueuse/core'
import { publishTask, getCompanyMeta, getEstimate } from '../api/company'
import { useProfileStore } from '../stores/profile'
import { fmtMoney } from '../utils/format'
import TermTip from '../components/TermTip.vue'

const router = useRouter()
const profileStore = useProfileStore()

// 兜底默认值：/company/meta 加载失败时回退（与后端 db.js 配置 / taxonomy.js 保持同步）
const DEFAULT_CATEGORIES = [
  '设计',
  '技术',
  '翻译',
  '文案',
  '视频',
  '直播电商',
  '跨境边贸',
  '文旅',
  '配送',
  '物流仓储',
  '安装',
  '施工',
  '制造生产',
  '农业',
  '家政服务',
  '其他',
]
const DEFAULT_PAY_METHODS = ['按成果', '按件', '按单']
const DEFAULT_CITIES = [
  '远程',
  '南宁',
  '柳州',
  '桂林',
  '梧州',
  '北海',
  '防城港',
  '钦州',
  '贵港',
  '玉林',
  '百色',
  '贺州',
  '河池',
  '来宾',
  '崇左',
  '其他',
]
const DEFAULT_CATEGORY_TRADES = {
  设计: ['UI设计', '平面设计', '电商美工', '空间设计'],
  技术: ['前端开发', '后端开发', '小程序开发', '测试运维'],
  翻译: ['中英翻译', '越南语翻译', '小语种翻译', '同声传译'],
  文案: ['文案策划', '新媒体运营', '稿件撰写'],
  视频: ['短视频剪辑', '配音', '动画制作', '直播运营'],
  直播电商: ['带货主播', '直播助播', '选品场控', '直播投流'],
  跨境边贸: ['跨境电商客服', '报关报检', '海外仓运营', '选品采购'],
  文旅: ['导游讲解', '景区服务', '民宿管家', '活动执行'],
  配送: ['同城配送', '快递分拣', '仓储理货'],
  物流仓储: ['货运司机', '装卸搬运', '仓储分拣', '调度跟单'],
  安装: ['家具安装', '家电安装', '弱电安装'],
  施工: ['水电施工', '泥瓦工', '木工', '油漆工'],
  制造生产: ['普工', '质检员', '装配工', '食品加工'],
  农业: ['果蔬采摘', '分拣包装', '茶叶采制', '农技服务'],
  家政服务: ['家庭保洁', '月嫂育儿', '养老护理', '收纳整理'],
  其他: [],
}
const DEFAULT_OFFLINE = ['配送', '安装', '施工', '物流仓储', '制造生产', '农业', '家政服务']

const categories = ref(DEFAULT_CATEGORIES)
const payMethods = ref(DEFAULT_PAY_METHODS)
const cities = ref(DEFAULT_CITIES)
const categoryTrades = ref(DEFAULT_CATEGORY_TRADES)
const offlineCategories = ref(DEFAULT_OFFLINE)

// 当前类目下可选的细分工种（类目→工种级联）
const availableTrades = computed(() => categoryTrades.value[form.category] || [])
// 当前类目是否为线下作业（决定高保额提示与"不可远程"约束）
const isOffline = computed(() => offlineCategories.value.includes(form.category))
const tradePlaceholder = computed(() => {
  if (!form.category) return '请先选择任务类目'
  if (!availableTrades.value.length) return '该类目暂无细分工种'
  return '细分工种，便于零工按技能匹配'
})

onMounted(async () => {
  // 余额不足提示依赖账户信息
  if (!profileStore.profile) profileStore.fetch().catch(() => {})
  try {
    const meta = await getCompanyMeta()
    if (Array.isArray(meta?.categories) && meta.categories.length)
      categories.value = meta.categories
    if (Array.isArray(meta?.payMethods) && meta.payMethods.length)
      payMethods.value = meta.payMethods
    if (Array.isArray(meta?.cities) && meta.cities.length) cities.value = meta.cities
    if (meta?.categoryTrades && typeof meta.categoryTrades === 'object')
      categoryTrades.value = meta.categoryTrades
    if (Array.isArray(meta?.offlineCategories)) offlineCategories.value = meta.offlineCategories
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
  standard: '',
})

// 类目变化：清掉不属于新类目的工种；若新类目为线下且当前地点为"远程"，清空地点强制重选
watch(
  () => form.category,
  () => {
    if (form.trade && !availableTrades.value.includes(form.trade)) form.trade = ''
    if (isOffline.value && form.city === '远程') form.city = ''
  },
)

// —— 余额不足引导 ——
const available = computed(() => profileStore.profile?.account?.available)
const insufficient = computed(
  () =>
    Number(form.price) > 0 &&
    available.value !== undefined &&
    Number(form.price) > Number(available.value),
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
  },
)

const rules = {
  title: [
    { required: true, message: '请输入任务标题', trigger: 'blur' },
    { min: 2, max: 80, message: '标题长度应为 2 至 80 个字符', trigger: 'blur' },
  ],
  category: [{ required: true, message: '请选择任务类目', trigger: 'change' }],
  payMethod: [{ required: true, message: '请选择计酬方式', trigger: 'change' }],
  price: [{ required: true, message: '请输入预算金额', trigger: 'blur' }],
  deadline: [{ required: true, message: '请选择截止日期', trigger: 'change' }],
  city: [
    { required: true, message: '请选择工作地点', trigger: 'change' },
    {
      validator: (_r, value, cb) =>
        isOffline.value && value === '远程'
          ? cb(new Error('线下作业类目需选择具体工作城市，不能为「远程」'))
          : cb(),
      trigger: 'change',
    },
  ],
  description: [
    { required: true, message: '请输入任务描述', trigger: 'blur' },
    { min: 5, max: 2000, message: '任务描述至少 5 个字符', trigger: 'blur' },
  ],
  standard: [
    { required: true, message: '请输入交付标准（验收依据）', trigger: 'blur' },
    { min: 5, max: 2000, message: '交付标准至少 5 个字符', trigger: 'blur' },
  ],
}

async function onSubmit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  // 校验通过后再二次确认，展示真实冻结金额（避免确认「¥0」后才报字段错误）
  try {
    await ElMessageBox.confirm(
      `发布后将从存管户冻结预算 ¥${fmtMoney(form.price)}，零工即可看到任务并报名。是否继续？`,
      '确认发布任务',
      { confirmButtonText: '继续发布', cancelButtonText: '再想想', type: 'warning' },
    )
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
      standard: form.standard || '',
    })
    ElMessage({
      type: 'success',
      duration: 6000,
      message: `发布成功，任务工单号 ${res.workOrderNo}，已冻结预算 ¥${fmtMoney(res.frozen)}。零工报名后您会收到站内通知`,
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

/* 承揽价：作为速算卡的锚点数字，独立成块、品牌弱底强调 */
.estimate-total {
  background: var(--brand-weak);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
}

.estimate-total-label {
  display: block;
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 4px;
}

.estimate-total-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--brand);
}

.estimate-breakdown-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  margin-bottom: 6px;
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
  color: var(--text-1);
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
