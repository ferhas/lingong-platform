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

    <div v-if="model" class="workbench">
      <!-- 左：模板导航 -->
      <aside class="nav">
        <div class="nav-prio">
          解析优先级：<b>工种覆盖</b> <i>›</i> <b>大类基础</b> <i>›</i> <b>默认兜底</b>
        </div>
        <el-input v-model="kw" :prefix-icon="Search" placeholder="搜索类目 / 工种" clearable size="small" class="nav-search" />

        <div class="nav-group">
          <div class="nav-gh">默认</div>
          <button class="nav-item" :class="{ on: sel.type === 'default' }" @click="select('default')">
            <span class="ni-name">默认兜底模板</span>
            <span class="ni-meta">{{ miniCount(model.default) }}</span>
          </button>
        </div>

        <div class="nav-group">
          <div class="nav-gh">按大类<em>{{ categoryKeys.length }}</em></div>
          <div class="nav-list">
            <button
              v-for="c in shownCategories"
              :key="'c' + c"
              class="nav-item"
              :class="{ on: sel.type === 'cat' && sel.key === c }"
              @click="select('cat', c)"
            >
              <span class="ni-name">{{ c }}</span>
              <span class="ni-meta">{{ miniCount(model.byCategory[c]) }}</span>
              <el-icon v-if="canWrite" class="ni-del" title="删除" @click.stop="remove('cat', c)"><Close /></el-icon>
            </button>
            <div v-if="!shownCategories.length" class="nav-none">无匹配类目</div>
          </div>
          <div v-if="canWrite" class="nav-add">
            <el-select v-model="newCategory" placeholder="选择类目添加" size="small" filterable clearable>
              <el-option v-for="c in addableCategories" :key="c" :label="c" :value="c" />
            </el-select>
            <el-button size="small" :icon="Plus" :disabled="!newCategory" @click="addCategory" />
          </div>
        </div>

        <div class="nav-group">
          <div class="nav-gh">按工种覆盖<em>{{ tradeKeys.length }}</em></div>
          <div class="nav-list">
            <button
              v-for="t in shownTrades"
              :key="'t' + t"
              class="nav-item"
              :class="{ on: sel.type === 'trade' && sel.key === t }"
              @click="select('trade', t)"
            >
              <span class="ni-name">{{ t }}</span>
              <span class="ni-meta">{{ miniCount(model.byTrade[t]) }}</span>
              <el-icon v-if="canWrite" class="ni-del" title="删除" @click.stop="remove('trade', t)"><Close /></el-icon>
            </button>
            <div v-if="!shownTrades.length" class="nav-none">暂无工种覆盖</div>
          </div>
          <div v-if="canWrite" class="nav-add">
            <el-select v-model="newTrade" placeholder="选择/输入工种" size="small" filterable allow-create default-first-option clearable>
              <el-option v-for="t in addableTrades" :key="t" :label="t" :value="t" />
            </el-select>
            <el-button size="small" :icon="Plus" :disabled="!newTrade" @click="addTrade" />
          </div>
        </div>
      </aside>

      <!-- 右：编辑 + 预览 -->
      <section v-loading="loading" class="main">
        <div class="main-head">
          <div class="mh-left">
            <h3 class="mh-title">{{ selTitle }}</h3>
            <el-tag :type="selTagType" size="small" effect="light" round>{{ selTagText }}</el-tag>
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
    </div>
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
const selTitle = computed(() => {
  if (sel.value.type === 'default') return '默认兜底模板'
  return sel.value.key
})
const selTagText = computed(() => ({ default: '默认兜底', cat: '大类基础', trade: '工种覆盖' }[sel.value.type]))
const selTagType = computed(() => ({ default: 'info', cat: 'warning', trade: 'success' }[sel.value.type]))
const selNote = computed(() => ({
  default: '所有未单独配置的工种都会使用这套模板。',
  cat: `承接「${sel.value.key}」类目、且无更细工种覆盖的任务，使用这套模板。`,
  trade: `承接「${sel.value.key}」工种的任务优先使用这套模板（覆盖所属大类）。`
}[sel.value.type]))

function miniCount(spec) {
  const f = spec?.fields?.length || 0
  const u = spec?.uploads?.length || 0
  return `${f}填·${u}传`
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
    // 选中项失效则回到默认
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
.dirty-tip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--el-color-warning);
}
.dirty-tip i { width: 7px; height: 7px; border-radius: 50%; background: var(--el-color-warning); }
.ro-tip { margin-bottom: 14px; }
.loading-holder { min-height: 300px; }

.workbench {
  display: grid;
  grid-template-columns: 264px 1fr;
  gap: 16px;
  align-items: start;
}

/* —— 左侧导航 —— */
.nav {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
  padding: 12px;
  position: sticky;
  top: 8px;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}
.nav-prio {
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  padding: 7px 9px;
  margin-bottom: 10px;
  line-height: 1.5;
}
.nav-prio b { color: var(--el-text-color-regular); font-weight: 600; }
.nav-prio i { color: var(--el-color-primary); font-style: normal; margin: 0 2px; }
.nav-search { margin-bottom: 12px; }
.nav-group { margin-bottom: 14px; }
.nav-gh {
  font-size: 12px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
  margin: 0 0 7px 2px;
  display: flex;
  align-items: center;
}
.nav-gh em {
  font-style: normal;
  margin-left: 6px;
  font-weight: 600;
  color: var(--el-text-color-placeholder);
}
.nav-list { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 8px 9px;
  cursor: pointer;
  color: var(--el-text-color-regular);
  font-size: 13.5px;
  position: relative;
  transition: background .15s;
}
.nav-item:hover { background: var(--el-fill-color-light); }
.nav-item.on {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--el-color-primary);
}
.ni-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ni-meta {
  flex: none;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}
.nav-item.on .ni-meta { color: var(--el-color-primary); }
.ni-del {
  flex: none;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
  opacity: 0;
  transition: opacity .15s, color .15s;
  border-radius: 4px;
}
.nav-item:hover .ni-del { opacity: 1; }
.ni-del:hover { color: var(--el-color-danger); }
.nav-none { font-size: 12px; color: var(--el-text-color-placeholder); padding: 6px 9px; }
.nav-add { display: flex; gap: 6px; margin-top: 8px; }
.nav-add .el-select { flex: 1; }

/* —— 右侧主区 —— */
.main {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
  padding: 18px 20px;
  min-height: 420px;
  min-width: 0;
}
.main-head {
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 14px;
  margin-bottom: 16px;
}
.mh-left { display: flex; align-items: center; gap: 10px; }
.mh-title { font-size: 17px; font-weight: 700; color: var(--el-text-color-primary); }
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

@media (max-width: 1280px) {
  .main-grid { grid-template-columns: 1fr; }
  .preview-col { border-left: none; padding-left: 0; border-top: 1px dashed var(--el-border-color); padding-top: 16px; }
  .pv-sticky { position: static; }
}
@media (max-width: 880px) {
  .workbench { grid-template-columns: 1fr; }
  .nav { position: static; max-height: none; }
}
</style>
