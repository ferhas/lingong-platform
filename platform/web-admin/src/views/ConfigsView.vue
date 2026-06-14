<template>
  <div v-loading="loading" class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">业务参数配置</h2>
        <p class="page-sub">
          算税参数、风控阈值、任务规则、保险方案,保存后对后续业务实时生效
          <el-tag v-if="!canWrite" size="small" type="info" effect="plain" style="margin-left: 8px">只读</el-tag>
        </p>
      </div>
      <div class="page-actions">
        <el-input
          v-model="keyword"
          placeholder="搜索参数名称或键名"
          clearable
          :prefix-icon="Search"
          style="width: 240px"
        />
        <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
      </div>
    </div>

    <el-empty v-if="keyword && groups.length === 0" :description="`没有匹配「${keyword}」的配置项`" :image-size="90" />

    <div v-for="group in groups" :key="group.key" class="panel group-panel">
      <div class="group-head">
        <span class="group-badge" :style="{ background: group.color }">
          <el-icon><component :is="group.icon" /></el-icon>
        </span>
        <span class="group-title">{{ group.title }}</span>
        <span class="group-count">{{ group.items.length }} 项</span>
      </div>

      <el-empty v-if="group.items.length === 0" description="该分组暂无配置项" :image-size="60" />

      <div v-for="item in group.items" :key="item.key" class="config-item">
        <div class="config-info">
          <div class="config-label">{{ item.label }}</div>
          <div class="config-meta">
            <span class="mono config-key">{{ item.key }}</span>
            <span class="config-updated">更新于 {{ fmtTime(item.updatedAt) }}</span>
          </div>
        </div>

        <div class="config-control">
          <!-- 0/1 开关 -->
          <el-switch
            v-if="isBoolean(item)"
            v-model="item.draft"
            :active-value="1"
            :inactive-value="0"
            active-text="开启"
            inactive-text="关闭"
            inline-prompt
            :disabled="!canWrite"
          />

          <!-- 数字 -->
          <el-input-number
            v-else-if="item.type === 'number'"
            v-model="item.draft"
            :step="numberStep(item.value)"
            :precision="numberPrecision(item.value)"
            :min="0"
            :max="numberMax(item)"
            :disabled="!canWrite"
            controls-position="right"
            style="width: 200px"
          />

          <!-- 数组:动态标签可增删 -->
          <div v-else-if="item.type === 'array'" class="tags-editor" :class="{ readonly: !canWrite }">
            <el-tag
              v-for="(tag, ti) in item.draft"
              :key="`${tag}-${ti}`"
              :closable="canWrite"
              size="default"
              effect="plain"
              @close="item.draft.splice(ti, 1)"
            >
              {{ tag }}
            </el-tag>
            <el-input
              v-if="canWrite && item.adding"
              :ref="el => setTagInputRef(item.key, el)"
              v-model="item.newTag"
              size="small"
              class="tag-input"
              maxlength="30"
              @keyup.enter="confirmTag(item)"
              @blur="confirmTag(item)"
            />
            <el-button
              v-else-if="canWrite"
              size="small"
              :icon="Plus"
              @click="startAddTag(item)"
            >
              添加
            </el-button>
          </div>

          <!-- 字符串 -->
          <el-input
            v-else
            v-model="item.draft"
            :disabled="!canWrite"
            style="width: 200px"
            maxlength="60"
          />

          <el-tooltip
            :content="canWrite ? '保存后实时生效' : '需要「配置编辑」权限'"
            placement="top"
          >
            <span>
              <el-button
                type="primary"
                :disabled="!canWrite || !isDirty(item)"
                :loading="item.saving"
                @click="save(item)"
              >
                保 存
              </el-button>
            </span>
          </el-tooltip>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, h, nextTick, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, Search, Coin, Warning, Tickets, Umbrella, Money, Service, Star, Lock, Bell, Opportunity } from '@element-plus/icons-vue'
import { getConfigs, updateConfig } from '../api/admin'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canWrite = computed(() => auth.can('config:write'))

const loading = ref(false)
const items = ref([])

// 须覆盖后端 CONFIG_SEEDS 全部分组，否则该组配置在 UI 中无入口
const GROUP_META = [
  { key: 'tax', title: '算税参数', icon: Coin, color: 'linear-gradient(135deg, #6366f1, #8b5cf6)' },
  { key: 'risk', title: '风控阈值', icon: Warning, color: 'linear-gradient(135deg, #ef4444, #f43f5e)' },
  { key: 'task', title: '任务规则', icon: Tickets, color: 'linear-gradient(135deg, #f59e0b, #f97316)' },
  { key: 'insurance', title: '保险方案', icon: Umbrella, color: 'linear-gradient(135deg, #10b981, #14b8a6)' },
  { key: 'dispute', title: '争议仲裁', icon: Opportunity, color: 'linear-gradient(135deg, #0ea5e9, #6366f1)' },
  { key: 'fund', title: '资金规则', icon: Money, color: 'linear-gradient(135deg, #14b8a6, #10b981)' },
  { key: 'ticket', title: '客服工单 SLA', icon: Service, color: 'linear-gradient(135deg, #8b5cf6, #d946ef)' },
  { key: 'review', title: '评价 / 信用 / 技能', icon: Star, color: 'linear-gradient(135deg, #f59e0b, #eab308)' },
  { key: 'security', title: '安全与导出', icon: Lock, color: 'linear-gradient(135deg, #64748b, #475569)' },
  { key: 'notify', title: '消息通知', icon: Bell, color: 'linear-gradient(135deg, #ec4899, #f43f5e)' }
]

// 全局资金应急开关由「结算/提现单据·应急开关」step-up 复验入口治理，不在此明文编辑（避免绕过二次验证）
// deliverySpecs 为结构化对象配置，由「交付物模板」专用编辑器维护（通用编辑器仅支持标量/数组）
const HIDDEN_KEYS = ['settlementPaused', 'withdrawalPaused', 'deliverySpecs']
// 0/1 语义的开关型配置，渲染为开关而非数字框
const BOOLEAN_KEYS = ['withdrawSmsRequired', 'faceVerifyRequired']
// 允许保存为空数组的配置（如订阅消息模板ID，为空表示不发订阅消息）
const ALLOW_EMPTY_ARRAY = ['subscribeTmplIds']

// 关键字过滤：按参数名称或键名筛选，便于在长配置页快速定位（保存逻辑不受影响）
const keyword = ref('')
const groups = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return GROUP_META.map(g => {
    let groupItems = items.value.filter(i => i.group === g.key && !HIDDEN_KEYS.includes(i.key))
    if (kw) {
      groupItems = groupItems.filter(
        i => (i.label || '').toLowerCase().includes(kw) || (i.key || '').toLowerCase().includes(kw)
      )
    }
    return { ...g, items: groupItems }
  }).filter(g => !kw || g.items.length > 0)
})

function valueType(value) {
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return 'number'
  return 'string'
}

function isBoolean(item) {
  return BOOLEAN_KEYS.includes(item.key)
}

// 比率/阈值类配置后端强制 ≤1（configStore），前端同步上限避免无效输入
function numberMax(item) {
  return /(Rate|Threshold)$/.test(item.key) ? 1 : undefined
}

/** 数字步进:小数(比例类)0.01,大额整数 100,普通整数 1 */
function numberStep(original) {
  if (!Number.isInteger(original) || Math.abs(original) < 1) return 0.01
  if (Math.abs(original) >= 10000) return 100
  return 1
}

function numberPrecision(original) {
  return !Number.isInteger(original) || Math.abs(original) < 1 ? 2 : 0
}

function isDirty(item) {
  if (item.type === 'array') {
    return JSON.stringify(item.draft) !== JSON.stringify(item.value)
  }
  return item.draft !== item.value
}

const tagInputRefs = {}
function setTagInputRef(key, el) {
  tagInputRefs[key] = el
}

function startAddTag(item) {
  item.adding = true
  item.newTag = ''
  nextTick(() => tagInputRefs[item.key]?.focus())
}

function confirmTag(item) {
  const tag = (item.newTag || '').trim()
  if (tag && !item.draft.includes(tag)) {
    item.draft.push(tag)
  }
  item.adding = false
  item.newTag = ''
}

async function load() {
  loading.value = true
  try {
    const data = await getConfigs()
    items.value = (data.list || []).map(c => ({
      ...c,
      type: valueType(c.value),
      draft: Array.isArray(c.value) ? [...c.value] : c.value,
      saving: false,
      adding: false,
      newTag: ''
    }))
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

/** 配置值的可读展示(数组用顿号连接) */
function displayValue(value) {
  return Array.isArray(value) ? value.join('、') : String(value)
}

/** 保存前二次确认:展示旧值 → 新值对比与实时生效提示 */
function confirmSave(item) {
  return ElMessageBox.confirm(
    h('div', { class: 'config-confirm' }, [
      h('div', { class: 'config-confirm-row' }, [
        h('span', { class: 'config-confirm-label' }, '旧值：'),
        h('span', { class: 'config-confirm-old' }, displayValue(item.value))
      ]),
      h('div', { class: 'config-confirm-row' }, [
        h('span', { class: 'config-confirm-label' }, '新值：'),
        h('span', { class: 'config-confirm-new' }, displayValue(item.draft))
      ]),
      h('div', { class: 'config-confirm-tip' }, '保存后将实时影响后续算税与风控，请确认无误。')
    ]),
    `确认修改「${item.label}」？`,
    { type: 'warning', confirmButtonText: '确认修改', cancelButtonText: '取消' }
  )
}

async function save(item) {
  if (item.type === 'array' && item.draft.length === 0 && !ALLOW_EMPTY_ARRAY.includes(item.key)) {
    ElMessage.warning('列表至少保留一项')
    return
  }
  try {
    await confirmSave(item)
  } catch {
    return
  }
  item.saving = true
  try {
    const value = item.type === 'array' ? [...item.draft] : item.draft
    const res = await updateConfig(item.key, value)
    item.value = res.value
    item.draft = Array.isArray(res.value) ? [...res.value] : res.value
    item.updatedAt = new Date().toISOString()
    ElMessage.success(`「${item.label}」已保存,已实时生效`)
  } catch {
    /* 错误已统一提示 */
  } finally {
    item.saving = false
  }
}

onMounted(load)
</script>

<style scoped>
.group-panel {
  margin-bottom: 16px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.group-badge {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.group-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.group-count {
  font-size: 12px;
  color: var(--text-3);
}

.config-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 4px;
  border-bottom: 1px dashed var(--border);
}

.config-item:last-child {
  border-bottom: none;
}

.config-info {
  min-width: 0;
}

.config-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

.config-meta {
  margin-top: 4px;
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-3);
}

.config-key {
  color: var(--accent);
}

.config-control {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.tags-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 480px;
  justify-content: flex-end;
}

.tag-input {
  width: 110px;
}

@media (max-width: 768px) {
  .config-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .tags-editor {
    justify-content: flex-start;
  }
}
</style>

<!-- 确认弹窗渲染在 body 下,需用全局样式 -->
<style>
.config-confirm-row {
  display: flex;
  gap: 6px;
  line-height: 1.8;
  word-break: break-all;
}

.config-confirm-label {
  flex-shrink: 0;
  color: var(--text-3);
}

.config-confirm-old {
  color: var(--text-2);
  text-decoration: line-through;
}

.config-confirm-new {
  color: var(--accent);
  font-weight: 700;
}

.config-confirm-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--warning);
}
</style>
