<template>
  <div>
    <PageHeader title="批量发单" subtitle="粘贴 CSV 或逐行编辑，一次最多发布 50 个任务；发布成功的任务将逐单冻结预算并生成工单" />

    <div class="page-card">
      <el-tabs v-model="activeTab">
        <!-- 粘贴 CSV -->
        <el-tab-pane label="粘贴 CSV" name="csv">
          <el-alert type="info" show-icon :closable="false" class="csv-alert">
            <template #title>每行一个任务，列顺序：标题,类目,计酬方式,承揽价,截止日期,描述,交付标准（最后一列可省略）</template>
            <div class="csv-hint">
              支持英文逗号、中文逗号或 Tab 分隔；首行若为表头将自动跳过；描述与交付标准中请勿包含分隔符。
            </div>
          </el-alert>
          <el-input
            v-model="csvText"
            type="textarea"
            :rows="10"
            :placeholder="csvPlaceholder"
            class="csv-input"
          />
          <div class="csv-actions">
            <el-button type="primary" :disabled="!csvText.trim()" @click="onParse">解析为任务列表</el-button>
            <el-button @click="csvText = ''">清空</el-button>
          </div>
        </el-tab-pane>

        <!-- 表格编辑 -->
        <el-tab-pane :label="`任务列表（${rows.length}）`" name="table">
          <el-table :data="rows" stripe>
            <el-table-column label="#" type="index" width="48" />
            <el-table-column label="任务标题" min-width="200">
              <template #default="{ row }">
                <el-input v-model="row.title" maxlength="80" placeholder="任务标题" />
              </template>
            </el-table-column>
            <el-table-column label="类目" width="120">
              <template #default="{ row }">
                <el-select v-model="row.category" placeholder="类目">
                  <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="计酬方式" width="120">
              <template #default="{ row }">
                <el-select v-model="row.payMethod" placeholder="计酬">
                  <el-option v-for="m in payMethods" :key="m" :label="m" :value="m" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="承揽价（元）" width="140">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.price"
                  :min="0.01"
                  :max="1000000"
                  :precision="2"
                  :controls="false"
                  style="width: 100%"
                  placeholder="金额"
                />
              </template>
            </el-table-column>
            <el-table-column label="截止日期" width="150">
              <template #default="{ row }">
                <el-date-picker v-model="row.deadline" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width: 100%" />
              </template>
            </el-table-column>
            <el-table-column label="任务描述" min-width="220">
              <template #default="{ row }">
                <el-input v-model="row.description" maxlength="2000" placeholder="任务描述（以成果交付为导向）" />
              </template>
            </el-table-column>
            <el-table-column label="交付标准" min-width="180">
              <template #default="{ row }">
                <el-input v-model="row.standard" maxlength="2000" placeholder="交付标准（可选）" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70" align="center" fixed="right">
              <template #default="{ $index }">
                <el-button type="danger" link size="small" @click="rows.splice($index, 1)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无任务，可粘贴 CSV 解析或手动添加" :image-size="72" />
            </template>
          </el-table>

          <div class="table-actions">
            <el-button :icon="Plus" :disabled="rows.length >= 50" @click="addRow">添加一行</el-button>
            <div class="table-summary">
              共 {{ rows.length }} 个任务，预算合计
              <span class="money total-money">¥{{ fmtMoney(totalBudget) }}</span>
              ，发布后将从<TermTip term="存管户" />逐单冻结
            </div>
            <el-button type="primary" size="large" :loading="submitting" :disabled="!rows.length" @click="onSubmit">
              批量发布（{{ rows.length }}）
            </el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 发布结果 -->
    <div v-if="result" class="page-card">
      <h3 class="page-title">发布结果：成功 {{ result.success }} 条，失败 {{ result.failed }} 条</h3>
      <el-table :data="result.results" stripe :row-class-name="resultRowClass">
        <el-table-column prop="row" label="行号" width="70" align="center" />
        <el-table-column label="标题" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ submittedItems[row.row - 1]?.title || '—' }}</template>
        </el-table-column>
        <el-table-column label="结果" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.ok ? 'success' : 'danger'" effect="light" size="small">
              {{ row.ok ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="工单号 / 失败原因" min-width="320">
          <template #default="{ row }">
            <span v-if="row.ok" class="mono">{{ row.workOrderNo }}</span>
            <span v-else class="error-text">{{ row.error }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="result-actions">
        <el-button type="primary" @click="router.push('/tasks')">去任务管理查看</el-button>
        <el-button v-if="result.failed" @click="keepFailedRows">仅保留失败行继续编辑</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import TermTip from '../components/TermTip.vue'
import { batchPublishTasks, getCompanyMeta } from '../api/company'
import { useProfileStore } from '../stores/profile'
import { fmtMoney } from '../utils/format'

const router = useRouter()
const profileStore = useProfileStore()

const DEFAULT_CATEGORIES = ['设计', '技术', '翻译', '文案', '视频', '其他']
const DEFAULT_PAY_METHODS = ['按成果', '按件', '按单']
const categories = ref(DEFAULT_CATEGORIES)
const payMethods = ref(DEFAULT_PAY_METHODS)

const activeTab = ref('csv')
const csvText = ref('')
const rows = ref([])
const submitting = ref(false)
const result = ref(null)
const submittedItems = ref([])

const csvPlaceholder = `示例（每行一个任务）：
电商主图设计（10 张）,设计,按成果,2000,2026-07-01,为新品拍摄图做主图精修与排版,提供源文件 + 可商用授权
产品介绍页文案,文案,按件,800,2026-06-30,撰写 5 篇产品介绍页文案
小程序登录模块开发,技术,按成果,5000,2026-07-15,实现微信小程序手机号登录与会话管理,通过验收用例并交付源码`

const totalBudget = computed(() => rows.value.reduce((s, r) => s + (Number(r.price) || 0), 0))

function addRow() {
  rows.value.push({
    title: '',
    category: '',
    payMethod: payMethods.value[0],
    price: undefined,
    deadline: '',
    description: '',
    standard: ''
  })
}

// —— CSV 解析：支持英文/中文逗号与 Tab，首行表头自动跳过 ——
function onParse() {
  const lines = csvText.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const parsed = []
  for (const line of lines) {
    const parts = line.split(/[,，\t]/).map(s => s.trim())
    if (parts[0] === '标题' || parts[0] === '任务标题') continue // 跳过表头
    parsed.push({
      title: parts[0] || '',
      category: parts[1] || '',
      payMethod: parts[2] || payMethods.value[0],
      price: parts[3] !== undefined && parts[3] !== '' && !isNaN(Number(parts[3])) ? Number(parts[3]) : undefined,
      deadline: (parts[4] || '').replace(/\//g, '-'),
      description: parts[5] || '',
      standard: parts[6] || ''
    })
  }
  if (!parsed.length) {
    ElMessage.warning('未解析到有效任务行，请检查内容格式')
    return
  }
  if (parsed.length > 50) {
    ElMessage.warning(`一次最多发布 50 条，已截取前 50 条（共解析到 ${parsed.length} 条）`)
    parsed.length = 50
  }
  rows.value = parsed
  result.value = null
  activeTab.value = 'table'
  ElMessage.success(`已解析 ${parsed.length} 条任务，请在列表中核对后批量发布`)
}

function validateRows() {
  if (!rows.value.length) {
    ElMessage.warning('请先添加任务')
    return false
  }
  if (rows.value.length > 50) {
    ElMessage.warning('一次最多发布 50 条任务')
    return false
  }
  for (let i = 0; i < rows.value.length; i++) {
    const r = rows.value[i]
    if (!r.title?.trim() || !r.category || !r.payMethod || !r.price || !r.deadline || !r.description?.trim()) {
      ElMessage.warning(`第 ${i + 1} 行信息不完整：标题、类目、计酬方式、承揽价、截止日期、描述均为必填`)
      return false
    }
  }
  return true
}

async function onSubmit() {
  if (!validateRows()) return
  try {
    await ElMessageBox.confirm(
      `即将批量发布 ${rows.value.length} 个任务，预算合计 ¥${fmtMoney(totalBudget.value)}，发布成功的任务将逐单从存管户冻结预算。是否继续？`,
      '批量发布确认',
      { confirmButtonText: '继续发布', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  const items = rows.value.map(r => ({
    title: r.title.trim(),
    category: r.category,
    payMethod: r.payMethod,
    price: Number(r.price),
    deadline: r.deadline,
    description: r.description.trim(),
    standard: (r.standard || '').trim()
  }))
  submitting.value = true
  try {
    submittedItems.value = items
    result.value = await batchPublishTasks(items)
    if (result.value.failed === 0) {
      ElMessage.success(`批量发布完成，${result.value.success} 个任务全部发布成功`)
    } else {
      ElMessage.warning(`批量发布完成：成功 ${result.value.success} 条，失败 ${result.value.failed} 条，失败原因见下方结果表`)
    }
    profileStore.fetch().catch(() => {})
  } catch {
    // 错误已由拦截器提示
  } finally {
    submitting.value = false
  }
}

// 仅保留失败行，便于修正后重发
function keepFailedRows() {
  if (!result.value) return
  const failedRows = new Set(result.value.results.filter(r => !r.ok).map(r => r.row))
  rows.value = rows.value.filter((_, i) => failedRows.has(i + 1))
  result.value = null
  activeTab.value = 'table'
}

function resultRowClass({ row }) {
  return row.ok ? '' : 'failed-row'
}

onMounted(async () => {
  try {
    const meta = await getCompanyMeta()
    if (Array.isArray(meta?.categories) && meta.categories.length) categories.value = meta.categories
    if (Array.isArray(meta?.payMethods) && meta.payMethods.length) payMethods.value = meta.payMethods
  } catch {
    // 静默失败，使用默认值
  }
})
</script>

<style scoped>
.csv-alert {
  margin-bottom: 14px;
  border-radius: 8px;
}

.csv-hint {
  font-size: 12px;
  line-height: 1.7;
}

.csv-input :deep(textarea) {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.8;
}

.csv-actions {
  margin-top: 14px;
  display: flex;
  gap: 10px;
}

.table-actions {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.table-summary {
  margin-left: auto;
  font-size: 13px;
  color: var(--text-2);
}

.total-money {
  font-weight: 700;
  color: var(--brand);
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.error-text {
  color: var(--danger);
  font-size: 12px;
  line-height: 1.6;
}

:deep(.failed-row) {
  --el-table-tr-bg-color: var(--el-color-danger-light-9);
}

.result-actions {
  margin-top: 16px;
  display: flex;
  gap: 10px;
}
</style>
