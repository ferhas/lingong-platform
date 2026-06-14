<template>
  <div v-loading="profileStore.loading">
    <!-- 准入状态警示 -->
    <el-alert
      v-if="profile?.status === 'pending'"
      title="企业资质审核中"
      description="您的企业准入申请已提交，平台正在进行资质与风险审核，审核通过并签署《总承揽框架合同》后方可发布任务。"
      type="warning"
      show-icon
      :closable="false"
      class="status-alert"
    />
    <el-alert
      v-if="profile?.status === 'rejected'"
      title="企业准入被拒绝"
      :description="`拒绝原因：${profile?.reviewNote || '未提供'}`"
      type="error"
      show-icon
      :closable="false"
      class="status-alert"
    />

    <!-- 统计卡 -->
    <div class="stat-grid">
      <StatCard
        icon="Wallet"
        label="可用余额"
        :value="`¥${fmtMoney(profile?.account?.available)}`"
        extra="存管户可用于发布任务冻结"
        clickable
        @click="router.push('/funds')"
      />
      <StatCard
        icon="Lock"
        label="冻结金额"
        :value="`¥${fmtMoney(profile?.account?.frozen)}`"
        extra="进行中任务的预算冻结"
        clickable
        @click="router.push('/funds')"
      />
      <StatCard
        icon="Coin"
        label="账户总额"
        :value="`¥${fmtMoney(profile?.account?.balance)}`"
        extra="银行存管虚拟户总额"
        clickable
        @click="router.push('/funds')"
      />
      <StatCard
        icon="CircleCheck"
        label="准入状态"
        :extra="profile?.masterContractNo ? `框架合同：${profile.masterContractNo}` : '审核通过后签署框架合同'"
      >
        <el-tag :type="statusMeta.tag" size="large" effect="light" class="status-tag">{{ statusMeta.label }}</el-tag>
      </StatCard>
    </div>

    <!-- 图表 -->
    <el-alert
      v-if="chartsEmpty && !chartLoading"
      type="info"
      :closable="false"
      show-icon
      class="status-alert"
      title="暂无统计数据"
      description="发布并完成任务结算后，这里将展示近 30 日结算金额趋势与任务状态分布。"
    />
    <div v-show="!chartsEmpty || chartLoading" class="chart-grid">
      <div class="page-card chart-card">
        <h3 class="page-title">近 30 日结算金额</h3>
        <div ref="trendRef" v-loading="chartLoading" class="chart-box"></div>
      </div>
      <div class="page-card chart-card">
        <h3 class="page-title">任务状态分布</h3>
        <div ref="distRef" v-loading="chartLoading" class="chart-box"></div>
      </div>
    </div>

    <!-- 企业信息 -->
    <div v-if="profile" class="page-card info-card">
      <h3 class="page-title">企业信息</h3>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="企业名称">{{ profile.companyName }}</el-descriptions-item>
        <el-descriptions-item label="统一社会信用代码">{{ profile.licenseNo }}</el-descriptions-item>
        <el-descriptions-item label="所属行业">{{ profile.industry }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <!-- 模式说明 -->
    <div class="page-card mode-card">
      <h3 class="page-title">承揽后分包模式说明</h3>
      <div class="mode-grid">
        <div class="mode-item">
          <div class="mode-icon"><el-icon :size="26"><Tickets /></el-icon></div>
          <div class="mode-title">平台全额开具 6% 发票</div>
          <div class="mode-desc">
            企业将任务整体发包给平台<TermTip term="承揽价" text="承揽" tip="平台以任务总价（承揽价）整体承接任务，对交付成果负责" />，平台再以<TermTip term="分包价" />（零工实际获得的税前报酬）分包给实名零工。任务验收后，平台向企业全额开具
            6% 现代服务<TermTip term="数电票" text="数电专用发票" />。
          </div>
        </div>
        <div class="mode-item">
          <div class="mode-icon"><el-icon :size="26"><Stamp /></el-icon></div>
          <div class="mode-title">凭票税前扣除</div>
          <div class="mode-desc">
            发票与《总承揽框架合同》、任务工单、结算确认单形成完整<TermTip term="四流" text="四流证据链" />，企业凭票即可进行企业所得税税前扣除。
          </div>
        </div>
        <div class="mode-item">
          <div class="mode-icon"><el-icon :size="26"><Lock /></el-icon></div>
          <div class="mode-title">资金银行存管</div>
          <div class="mode-desc">
            企业充值至<TermTip term="存管户" text="银行存管虚拟户" />，发布任务即冻结预算，验收后划扣结算，资金链路全程留痕、安全可控。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import StatCard from '../components/StatCard.vue'
import TermTip from '../components/TermTip.vue'
import { useProfileStore } from '../stores/profile'
import { useThemeStore } from '../stores/theme'
import { getStatsTrend } from '../api/company'
import { fmtMoney, COMPANY_STATUS, TASK_STATUS } from '../utils/format'

const router = useRouter()
const profileStore = useProfileStore()
const theme = useThemeStore()

const profile = computed(() => profileStore.profile)
const statusMeta = computed(
  () => COMPANY_STATUS[profile.value?.status] || { label: '加载中', tag: 'info' }
)

// —— 图表 ——
const trendRef = ref()
const distRef = ref()
const chartLoading = ref(false)
const chartsEmpty = ref(false)
let trendChart = null
let distChart = null
let statsData = { trend: [], statusDist: [] }

// 主题相关取色：从 CSS 变量读取，保证深浅模式一致
function chartColors() {
  const css = getComputedStyle(document.documentElement)
  const v = name => css.getPropertyValue(name).trim()
  return {
    text: v('--text-2') || '#4b5563',
    textWeak: v('--text-3') || '#9ca3af',
    border: v('--border') || '#e5e7eb',
    brand: v('--brand') || '#4f46e5',
    bg: v('--bg-card') || '#fff'
  }
}

// 饼图配色与 TASK_STATUS 语义对齐，且不使用红色（红留给错误态）
const STATUS_COLORS = {
  recruiting: '#0ea5e9',
  working: '#6366f1',
  delivered: '#f59e0b',
  settled: '#22c55e',
  cancelled: '#9ca3af'
}

// echarts 按需异步加载：先渲染页面骨架，图表库就绪后再绘制，避免首次进入工作台时白屏等待
let echarts = null
async function loadECharts() {
  if (!echarts) echarts = (await import('../utils/echarts')).default
  return echarts
}

async function renderCharts() {
  await loadECharts()
  if (!trendRef.value || !distRef.value) return
  const c = chartColors()

  if (!trendChart) trendChart = echarts.init(trendRef.value)
  if (!distChart) distChart = echarts.init(distRef.value)

  const days = statsData.trend.map(t => t.day.slice(5))
  const amounts = statsData.trend.map(t => t.amount)

  trendChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: c.bg,
      borderColor: c.border,
      textStyle: { color: c.text },
      valueFormatter: val => `¥${fmtMoney(val)}`
    },
    grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: c.border } },
      axisLabel: { color: c.textWeak }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: c.textWeak, formatter: val => `¥${val >= 10000 ? `${val / 10000}万` : val}` },
      splitLine: { lineStyle: { color: c.border, type: 'dashed' } }
    },
    series: [
      {
        name: '结算金额',
        type: 'line',
        smooth: true,
        symbolSize: 6,
        data: amounts,
        itemStyle: { color: c.brand },
        lineStyle: { width: 3, color: c.brand },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: `${c.brand}55` },
            { offset: 1, color: `${c.brand}05` }
          ])
        }
      }
    ]
  }, true)

  const distData = statsData.statusDist.map(d => ({
    name: TASK_STATUS[d.status]?.label || d.status,
    value: d.count,
    itemStyle: { color: STATUS_COLORS[d.status] || c.textWeak }
  }))

  distChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: c.bg,
      borderColor: c.border,
      textStyle: { color: c.text }
    },
    legend: { bottom: 0, textStyle: { color: c.text } },
    series: [
      {
        name: '任务状态',
        type: 'pie',
        radius: ['46%', '70%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: c.bg, borderWidth: 2 },
        label: { color: c.text, formatter: '{b}：{c}' },
        emptyCircleStyle: { color: c.border },
        data: distData
      }
    ]
  }, true)
}

async function fetchStats() {
  chartLoading.value = true
  try {
    statsData = await getStatsTrend(30)
    chartsEmpty.value = !(statsData.trend?.length) && !(statsData.statusDist?.length)
    await nextTick()
    await renderCharts()
  } catch {
    // 错误已由拦截器提示
  } finally {
    chartLoading.value = false
  }
}

// 暗黑切换时重绘图表（文字/轴颜色随 CSS 变量更新）
watch(() => theme.isDark, async () => {
  await nextTick()
  renderCharts()
})

function onResize() {
  trendChart?.resize()
  distChart?.resize()
}

onMounted(() => {
  profileStore.fetch().catch(() => {})
  fetchStats()
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  trendChart?.dispose()
  distChart?.dispose()
  trendChart = null
  distChart = null
})
</script>

<style scoped>
.status-alert {
  margin-bottom: 16px;
  border-radius: 12px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.status-tag {
  font-size: 15px;
  font-weight: 600;
}

.chart-grid {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 16px;
  margin-bottom: 16px;
}

.chart-box {
  height: 280px;
}

.info-card {
  margin-bottom: 16px;
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.mode-item {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
}

.mode-icon {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  background: var(--brand-gradient);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
}

.mode-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}

.mode-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
}

@media (max-width: 1100px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .chart-grid {
    grid-template-columns: 1fr;
  }
  .mode-grid {
    grid-template-columns: 1fr;
  }
}
</style>
