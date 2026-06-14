<template>
  <div v-loading="loading" class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">运营总览</h2>
        <p class="page-sub">平台核心经营与合规指标一览</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
    </div>

    <!-- 四张统计卡(可点击跳转) -->
    <el-row :gutter="16">
      <el-col v-for="card in statCards" :key="card.label" :xs="12" :sm="12" :md="6">
        <div
          class="stat-card"
          :class="{ clickable: card.allowed }"
          @click="card.allowed && router.push(card.to)"
        >
          <div class="stat-icon" :style="{ background: card.color }">
            <el-icon><component :is="card.icon" /></el-icon>
          </div>
          <div>
            <div class="stat-label">{{ card.label }}</div>
            <div class="stat-value money">{{ card.value }}</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 近30日经营趋势图表 -->
    <el-row :gutter="16" class="chart-row">
      <el-col :xs="24" :md="14">
        <div class="panel chart-panel">
          <div class="panel-title">近30日结算金额趋势</div>
          <div ref="trendEl" class="chart chart-lg"></div>
        </div>
      </el-col>
      <el-col :xs="24" :md="10">
        <div class="panel chart-panel">
          <div class="panel-title">任务状态分布</div>
          <div ref="statusEl" class="chart chart-lg"></div>
        </div>
      </el-col>
    </el-row>
    <div class="panel chart-panel chart-row">
      <div class="panel-title">近30日税费构成(个税 / 增值税)</div>
      <div ref="taxEl" class="chart chart-md"></div>
    </div>

    <!-- 累计二级统计 -->
    <div class="panel totals-panel">
      <div class="panel-title">平台累计</div>
      <el-row :gutter="16">
        <el-col v-for="t in totalItems" :key="t.label" :xs="12" :sm="12" :md="6">
          <div class="total-item">
            <div class="total-value money">{{ t.value }}</div>
            <div class="total-label">{{ t.label }}</div>
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 四流合一硬校验说明 -->
    <div class="panel rules-panel">
      <div class="panel-title">
        四流合一·硬校验
        <el-tag size="small" effect="dark" type="primary" style="margin-left: 8px">
          合规底线
        </el-tag>
      </div>
      <p class="rules-desc">
        平台对每笔结算强制执行合同流、业务流、资金流、发票流四流一致校验,任一环节缺失即阻断后续动作:
      </p>
      <el-row :gutter="16">
        <el-col v-for="(r, i) in rules" :key="r.title" :xs="24" :sm="12" :md="6">
          <div class="rule-item">
            <div class="rule-step">{{ i + 1 }}</div>
            <div class="rule-title">{{ r.title }}</div>
            <div class="rule-text">{{ r.text }}</div>
          </div>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh, Money, OfficeBuilding, Warning, Coin } from '@element-plus/icons-vue'
import { getDashboard, getStatsTrend } from '../api/admin'
import { fmtMoney } from '../utils/format'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'

const router = useRouter()
const auth = useAuthStore()
const theme = useThemeStore()

const loading = ref(false)
const data = ref(null)
const trendData = ref(null)

const trendEl = ref()
const statusEl = ref()
const taxEl = ref()
let charts = []

const statCards = computed(() => [
  { label: '今日交易额', value: fmtMoney(data.value?.todayAmount ?? 0), icon: Money, color: 'linear-gradient(135deg, #6366f1, #8b5cf6)', to: '/flows', allowed: auth.can('flow:read') },
  { label: '待审核企业', value: String(data.value?.pendingCompanies ?? 0), icon: OfficeBuilding, color: 'linear-gradient(135deg, #f59e0b, #f97316)', to: '/companies', allowed: auth.can('company:read') },
  { label: '待处理预警', value: String(data.value?.openAlerts ?? 0), icon: Warning, color: 'linear-gradient(135deg, #ef4444, #f43f5e)', to: '/risk', allowed: auth.can('risk:read') },
  { label: '本月代扣税费', value: fmtMoney(data.value?.monthTax ?? 0), icon: Coin, color: 'linear-gradient(135deg, #10b981, #14b8a6)', to: '/tax', allowed: auth.can('tax:read') }
])

const totalItems = computed(() => {
  const t = data.value?.totals || {}
  return [
    { label: '入驻企业数', value: String(t.companies ?? 0) },
    { label: '注册零工数', value: String(t.workers ?? 0) },
    { label: '任务总数', value: String(t.tasks ?? 0) },
    { label: '累计结算额', value: fmtMoney(t.settledAmount ?? 0) }
  ]
})

const rules = [
  { title: '合同流', text: '无签约工单不可结算' },
  { title: '业务流', text: '无交付物不可验收' },
  { title: '发票流', text: '无验收不可开票' },
  { title: '资金流', text: '无开票依据不可分账' }
]

const STATUS_TEXT = {
  recruiting: '报名中',
  working: '进行中',
  delivered: '待验收',
  settled: '已结算',
  cancelled: '已取消'
}

function chartPalette() {
  const dark = theme.isDark
  return {
    text: dark ? '#a3adc2' : '#6b7280',
    axisLine: dark ? '#283450' : '#e5e7eb',
    splitLine: dark ? '#1f2a40' : '#f3f4f6',
    tooltipBg: dark ? '#1b2538' : '#ffffff',
    tooltipText: dark ? '#e7eaf0' : '#111827'
  }
}

function baseTooltip(p) {
  return {
    backgroundColor: p.tooltipBg,
    borderColor: p.axisLine,
    textStyle: { color: p.tooltipText, fontSize: 12 }
  }
}

// 无数据/全为 0 时隐藏空轴并居中提示「暂无数据」，避免渲染成像坏掉的空白网格
// 置于 setOption 末尾展开，空态时覆盖 xAxis/yAxis/legend/series
function emptyOpt(isEmpty, p) {
  if (!isEmpty) return {}
  return {
    title: {
      text: '暂无数据',
      left: 'center',
      top: 'middle',
      textStyle: { color: p.text, fontWeight: 'normal', fontSize: 13 }
    },
    xAxis: { show: false },
    yAxis: { show: false },
    legend: { show: false },
    series: []
  }
}

function disposeCharts() {
  charts.forEach(c => c.dispose())
  charts = []
}

// echarts 按需异步加载：先渲染页面骨架，图表库就绪后再绘制，避免首次进入总览时白屏等待
let echarts = null
async function loadECharts() {
  if (!echarts) echarts = (await import('../utils/echarts')).default
  return echarts
}

async function renderCharts() {
  if (!trendData.value) return
  await loadECharts()
  disposeCharts()
  const p = chartPalette()
  const { trend = [], taxTrend = [], statusDist = [] } = trendData.value

  // ① 结算金额折线
  if (trendEl.value) {
    const c = echarts.init(trendEl.value)
    c.setOption({
      tooltip: {
        trigger: 'axis',
        ...baseTooltip(p),
        valueFormatter: v => fmtMoney(v)
      },
      grid: { left: 16, right: 16, top: 24, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: trend.map(t => t.day.slice(5)),
        axisLabel: { color: p.text },
        axisLine: { lineStyle: { color: p.axisLine } }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: p.text },
        splitLine: { lineStyle: { color: p.splitLine } }
      },
      series: [{
        name: '结算金额',
        type: 'line',
        smooth: true,
        symbolSize: 6,
        data: trend.map(t => t.amount),
        itemStyle: { color: '#6366f1' },
        lineStyle: { width: 3, color: '#6366f1' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(99, 102, 241, 0.32)' },
            { offset: 1, color: 'rgba(99, 102, 241, 0.02)' }
          ])
        }
      }],
      ...emptyOpt(!trend.some(t => t.amount), p)
    })
    charts.push(c)
  }

  // ② 任务状态分布环形
  if (statusEl.value) {
    const c = echarts.init(statusEl.value)
    c.setOption({
      tooltip: { trigger: 'item', ...baseTooltip(p) },
      legend: { bottom: 0, textStyle: { color: p.text } },
      color: ['#6366f1', '#f59e0b', '#0ea5e9', '#10b981', '#9ca3af'],
      series: [{
        name: '任务状态',
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: theme.isDark ? '#151e30' : '#ffffff', borderWidth: 2 },
        label: { color: p.text, formatter: '{b}: {c}' },
        data: statusDist.map(s => ({ name: STATUS_TEXT[s.status] || s.status, value: s.count }))
      }],
      ...emptyOpt(!statusDist.some(s => s.count), p)
    })
    charts.push(c)
  }

  // ③ 税费堆叠柱状
  if (taxEl.value) {
    const c = echarts.init(taxEl.value)
    c.setOption({
      tooltip: {
        trigger: 'axis',
        ...baseTooltip(p),
        valueFormatter: v => fmtMoney(v)
      },
      legend: { top: 0, textStyle: { color: p.text } },
      grid: { left: 16, right: 16, top: 36, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: taxTrend.map(t => t.day.slice(5)),
        axisLabel: { color: p.text },
        axisLine: { lineStyle: { color: p.axisLine } }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: p.text },
        splitLine: { lineStyle: { color: p.splitLine } }
      },
      series: [
        {
          name: '预扣个税',
          type: 'bar',
          stack: 'tax',
          barMaxWidth: 26,
          itemStyle: { color: '#6366f1', borderRadius: [0, 0, 0, 0] },
          data: taxTrend.map(t => t.tax)
        },
        {
          name: '增值税',
          type: 'bar',
          stack: 'tax',
          barMaxWidth: 26,
          itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
          data: taxTrend.map(t => t.vat)
        }
      ],
      ...emptyOpt(!taxTrend.some(t => t.tax || t.vat), p)
    })
    charts.push(c)
  }
}

function resizeCharts() {
  charts.forEach(c => c.resize())
}

async function load() {
  loading.value = true
  try {
    const [dash, trend] = await Promise.all([getDashboard(), getStatsTrend(30)])
    data.value = dash
    trendData.value = trend
    await nextTick()
    await renderCharts()
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// 主题切换时重绘图表
watch(() => theme.isDark, () => {
  nextTick(renderCharts)
})

onMounted(() => {
  load()
  window.addEventListener('resize', resizeCharts)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCharts)
  disposeCharts()
})
</script>

<style scoped>
.chart-row,
.totals-panel,
.rules-panel {
  margin-top: 16px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
}

.chart {
  width: 100%;
}

.chart-lg {
  height: 300px;
}

.chart-md {
  height: 240px;
}

.total-item {
  background: var(--bg-hover);
  border-radius: 10px;
  padding: 16px;
  text-align: center;
}

.total-value {
  font-size: 22px;
  font-weight: 800;
  color: var(--text-1);
}

.total-label {
  font-size: 13px;
  color: var(--text-3);
  margin-top: 6px;
}

.rules-desc {
  margin: -6px 0 16px;
  font-size: 13px;
  color: var(--text-3);
}

.rule-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  position: relative;
  height: 100%;
}

.rule-step {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
}

.rule-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 4px;
}

.rule-text {
  font-size: 13px;
  color: var(--text-2);
}

@media (max-width: 992px) {
  .stat-card,
  .total-item,
  .rule-item,
  .chart-panel {
    margin-bottom: 12px;
  }
}
</style>
