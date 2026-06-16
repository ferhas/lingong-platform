<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">交付物模板</h2>
        <p class="page-sub">为每个工种定义交付时「要填写的字段」与「要上传的材料」，零工端按此动态生成交付表单、企业端据此结构化验收。</p>
      </div>
      <div class="head-actions">
        <span v-if="dirty" class="dirty-tip"><i></i>有未保存改动</span>
        <el-button :icon="Refresh" :loading="loading" @click="reload">刷新</el-button>
        <el-button v-if="canWrite" type="primary" :icon="Check" :loading="saving" :disabled="!dirty" @click="save">保存模板</el-button>
      </div>
    </div>

    <el-alert v-if="!canWrite" type="info" :closable="false" show-icon class="ro-tip" title="当前账号无 config:write 权限，仅可查看模板。" />

    <template v-if="model">
      <!-- 模板选择器（顶部横排，自动换行，无需竖向滚动） -->
      <div class="chooser">
        <div class="ch-top">
          <span class="ch-prio">解析优先级：<b>工种覆盖</b> <i>›</i> <b>大类基础</b> <i>›</i> <b>默认兜底</b></span>
          <el-input v-model="kw" :prefix-icon="Search" placeholder="搜索类目 / 工种" clearable size="small" class="ch-search" />
        </div>

        <div class="ch-row">
          <span class="ch-label">默认</span>
          <div class="chips">
            <button class="chip" :class="{ on: sel.type === 'default' }" :title="miniCount(model.default)" @click="select('default')">
              默认兜底模板
            </button>
          </div>
        </div>

        <div class="ch-row">
          <span class="ch-label">按大类<em>{{ categoryKeys.length }}</em></span>
          <div class="chips">
            <button
              v-for="c in shownCategories"
              :key="'c' + c"
              class="chip"
              :class="{ on: sel.type === 'cat' && sel.key === c }"
              :title="miniCount(model.byCategory[c])"
              @click="select('cat', c)"
            >
              {{ c }}
              <el-icon v-if="canWrite" class="chip-x" title="删除" @click.stop="remove('cat', c)"><Close /></el-icon>
            </button>
            <span v-if="!shownCategories.length" class="chips-none">无匹配类目</span>
            <div v-if="canWrite && !kw" class="chip-add">
              <el-select v-model="newCategory" placeholder="+ 添加类目" size="small" filterable clearable>
                <el-option v-for="c in addableCategories" :key="c" :label="c" :value="c" />
              </el-select>
              <el-button size="small" :icon="Plus" :disabled="!newCategory" @click="addCategory" />
            </div>
          </div>
        </div>

        <div class="ch-row">
          <span class="ch-label">按工种<em>{{ tradeKeys.length }}</em></span>
          <div class="chips">
            <button
              v-for="t in shownTrades"
              :key="'t' + t"
              class="chip chip-trade"
              :class="{ on: sel.type === 'trade' && sel.key === t }"
              :title="miniCount(model.byTrade[t])"
              @click="select('trade', t)"
            >
              {{ t }}
              <el-icon v-if="canWrite" class="chip-x" title="删除" @click.stop="remove('trade', t)"><Close /></el-icon>
            </button>
            <span v-if="!shownTrades.length && !canWrite" class="chips-none">暂无工种覆盖</span>
            <div v-if="canWrite && !kw" class="chip-add">
              <el-select v-model="newTrade" placeholder="+ 添加工种" size="small" filterable allow-create default-first-option clearable>
                <el-option v-for="t in addableTrades" :key="t" :label="t" :value="t" />
              </el-select>
              <el-button size="small" :icon="Plus" :disabled="!newTrade" @click="addTrade" />
            </div>
          </div>
        </div>
      </div>

      <!-- 编辑 + 零工端预览 -->
      <section v-loading="loading" class="main">
        <div class="main-head">
          <div class="mh-left">
            <h3 class="mh-title">{{ selTitle }}</h3>
            <el-tag :type="selTagType" size="small" effect="light" round>{{ selTagText }}</el-tag>
            <span class="mh-sum">{{ selSummary }}</span>
          </div>
          <p class="mh-note">{{ selNote }}</p>
        </div>

        <div class="main-grid">
          <div class="edit-col">
            <DeliverySpecEditor :key="selKey" :spec="selectedSpec" :readonly="!canWrite" />
          </div>
          <div class="preview-col">
            <div class="pv-sticky">
              <DeliverySpecPreview :spec="selectedSpec" />
            </div>
          </div>
        </div>
      </section>
    </template>
    <div v-else v-loading="loading" class="loading-holder" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Check, Search, Plus, Close } from '@element-plus/icons-vue'
import { getConfigs, updateConfig } from '../api/admin'
import { useAuthStore } from '../stores/auth'
import DeliverySpecEditor from '../components/DeliverySpecEditor.vue'
import DeliverySpecPreview from '../components/DeliverySpecPreview.vue'

const auth = useAuthStore()
const canWrite = computed(() => auth.can('config:write'))

const loading = ref(false)
const saving = ref(false)
const model = ref(null)
const original = ref('')
const categories = ref([])
const allTrades = ref([])
const kw = ref('')
const sel = ref({ type: 'default', key: '' })
const newCategory = ref('')
const newTrade = ref('')

const emptySpec = () => ({ fields: [], uploads: [] })
const categoryKeys = computed(() => Object.keys(model.value?.byCategory || {}))
const tradeKeys = computed(() => Object.keys(model.value?.byTrade || {}))
const addableCategories = computed(() => categories.value.filter(c => !categoryKeys.value.includes(c)))
const addableTrades = computed(() => allTrades.value.filter(t => !tradeKeys.value.includes(t)))
const dirty = computed(() => model.value && JSON.stringify(model.value) !== original.value)

const flt = arr => {
  const k = kw.value.trim()
  return k ? arr.filter(x => x.includes(k)) : arr
}
const shownCategories = computed(() => flt(categoryKeys.value))
const shownTrades = computed(() => flt(tradeKeys.value))

const selectedSpec = computed(() => {
  if (!model.value) return emptySpec()
  if (sel.value.type === 'default') return model.value.default
  if (sel.value.type === 'cat') return model.value.byCategory[sel.value.key] || emptySpec()
  return model.value.byTrade[sel.value.key] || emptySpec()
})
const selKey = computed(() => sel.value.type + ':' + sel.value.key)
const selTitle = computed(() => (sel.value.type === 'default' ? '默认兜底模板' : sel.value.key))
const selTagText = computed(() => ({ default: '默认兜底', cat: '大类基础', trade: '工种覆盖' }[sel.value.type]))
const selTagType = computed(() => ({ default: 'info', cat: 'warning', trade: 'success' }[sel.value.type]))
const selNote = computed(() => ({
  default: '所有未单独配置的工种都会使用这套模板。',
  cat: `承接「${sel.value.key}」类目、且无更细工种覆盖的任务，使用这套模板。`,
  trade: `承接「${sel.value.key}」工种的任务优先使用这套模板（覆盖所属大类）。`
}[sel.value.type]))
const selSummary = computed(() => {
  const s = selectedSpec.value
  const reqF = (s.fields || []).filter(f => f.required).length
  const reqU = (s.uploads || []).filter(u => u.required).length
  return `${s.fields?.length || 0} 个字段 · ${s.uploads?.length || 0} 项材料 · ${reqF + reqU} 项必填必传`
})

function miniCount(spec) {
  return `${spec?.fields?.length || 0} 填 · ${spec?.uploads?.length || 0} 传`
}
function select(type, key = '') {
  sel.value = { type, key }
}

async function load() {
  loading.value = true
  try {
    const data = await getConfigs()
    const list = data.list || []
    const raw = list.find(c => c.key === 'deliverySpecs')?.value || { default: emptySpec(), byCategory: {}, byTrade: {} }
    const cloned = JSON.parse(JSON.stringify(raw))
    if (!cloned.default) cloned.default = emptySpec()
    if (!cloned.byCategory) cloned.byCategory = {}
    if (!cloned.byTrade) cloned.byTrade = {}
    model.value = cloned
    original.value = JSON.stringify(cloned)
    categories.value = list.find(c => c.key === 'categories')?.value || []
    allTrades.value = [...new Set([...Object.keys(cloned.byTrade)])]
    if (sel.value.type === 'cat' && !cloned.byCategory[sel.value.key]) select('default')
    if (sel.value.type === 'trade' && !cloned.byTrade[sel.value.key]) select('default')
  } catch {
    ElMessage.error('加载交付模板失败')
  } finally {
    loading.value = false
  }
}

async function reload() {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('刷新会丢弃当前未保存的改动，确认继续？', '放弃改动', { confirmButtonText: '放弃并刷新', cancelButtonText: '取消', type: 'warning' })
    } catch { return }
  }
  load()
}

function addCategory() {
  const c = newCategory.value
  if (!c || model.value.byCategory[c]) return
  model.value.byCategory[c] = emptySpec()
  newCategory.value = ''
  kw.value = ''
  select('cat', c)
}
function addTrade() {
  const t = String(newTrade.value).trim()
  if (!t || model.value.byTrade[t]) return
  model.value.byTrade[t] = emptySpec()
  newTrade.value = ''
  kw.value = ''
  select('trade', t)
}
async function remove(type, key) {
  try {
    await ElMessageBox.confirm(`确认删除「${key}」的${type === 'cat' ? '大类' : '工种'}模板？删除后该${type === 'cat' ? '类目' : '工种'}将回落到上一级模板。`, '删除模板', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch { return }
  if (type === 'cat') delete model.value.byCategory[key]
  else delete model.value.byTrade[key]
  if (sel.value.key === key) select('default')
}

async function save() {
  try {
    await ElMessageBox.confirm('保存后将立即影响零工端交付表单与企业端验收展示，请确认无误。', '保存交付模板', {
      confirmButtonText: '确认保存', cancelButtonText: '再看看', type: 'warning'
    })
  } catch { return }
  saving.value = true
  try {
    await updateConfig('deliverySpecs', model.value)
    ElMessage.success('交付模板已保存，已即时生效')
    original.value = JSON.stringify(model.value)
  } catch {
    // 拦截器已弹出后端校验信息（字段标识重复 / 类型非法等）
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.page { padding: 4px 2px; }
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.page-title { font-size: 20px; font-weight: 700; }
.page-sub {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 6px;
  max-width: 760px;
  line-height: 1.6;
}
.head-actions { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
.dirty-tip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--el-color-warning); }
.dirty-tip i { width: 7px; height: 7px; border-radius: 50%; background: var(--el-color-warning); }
.ro-tip { margin-bottom: 14px; }
.loading-holder { min-height: 300px; }

/* —— 顶部选择器 —— */
.chooser {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
  padding: 14px 16px;
  margin-bottom: 14px;
}
.ch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.ch-prio { font-size: 12px; color: var(--el-text-color-secondary); }
.ch-prio b { color: var(--el-text-color-regular); font-weight: 600; }
.ch-prio i { color: var(--el-color-primary); font-style: normal; margin: 0 3px; }
.ch-search { width: 220px; flex: none; }

.ch-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 9px 0;
}
.ch-row + .ch-row { border-top: 1px dashed var(--el-border-color-lighter); }
.ch-label {
  flex: 0 0 64px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
  padding-top: 6px;
}
.ch-label em {
  font-style: normal;
  margin-left: 5px;
  font-weight: 600;
  color: var(--el-text-color-placeholder);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
  align-items: center;
}
.chip {
  position: relative;
  border: 1px solid var(--el-border-color);
  background: var(--el-fill-color-blank, var(--el-bg-color));
  color: var(--el-text-color-regular);
  border-radius: 18px;
  padding: 5px 13px;
  font-size: 13px;
  cursor: pointer;
  transition: all .15s;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 1.4;
}
.chip:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.chip.on {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 4px 12px -4px var(--el-color-primary);
}
.chip-trade.on { background: var(--el-color-success); border-color: var(--el-color-success); box-shadow: 0 4px 12px -4px var(--el-color-success); }
.chip-trade:hover { border-color: var(--el-color-success); color: var(--el-color-success); }
.chip-x {
  font-size: 13px;
  margin-right: -4px;
  border-radius: 50%;
  opacity: .55;
  transition: opacity .15s, background .15s;
}
.chip-x:hover { opacity: 1; background: rgba(0, 0, 0, .12); }
.chip.on .chip-x { opacity: .8; }
.chips-none { font-size: 12.5px; color: var(--el-text-color-placeholder); padding: 4px 0; }
.chip-add { display: inline-flex; gap: 6px; align-items: center; }
.chip-add :deep(.el-select) { width: 130px; }

/* —— 主区 —— */
.main {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
  padding: 18px 20px;
  min-height: 360px;
}
.main-head {
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 14px;
  margin-bottom: 16px;
}
.mh-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mh-title { font-size: 17px; font-weight: 700; color: var(--el-text-color-primary); }
.mh-sum { font-size: 12px; color: var(--el-text-color-secondary); }
.mh-note { margin-top: 6px; font-size: 12.5px; color: var(--el-text-color-secondary); }

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 312px;
  gap: 22px;
  align-items: start;
}
.edit-col { min-width: 0; }
.preview-col { border-left: 1px dashed var(--el-border-color); padding-left: 20px; min-width: 0; }
.pv-sticky { position: sticky; top: 12px; }

@media (max-width: 1100px) {
  .main-grid { grid-template-columns: 1fr; }
  .preview-col { border-left: none; padding-left: 0; border-top: 1px dashed var(--el-border-color); padding-top: 16px; }
  .pv-sticky { position: static; }
}
@media (max-width: 640px) {
  .ch-top { flex-direction: column; align-items: stretch; }
  .ch-search { width: 100%; }
  .ch-row { flex-direction: column; gap: 6px; }
}
</style>
