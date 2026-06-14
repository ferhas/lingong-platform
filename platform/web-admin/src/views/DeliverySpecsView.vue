<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">交付物模板</h2>
        <p class="page-sub">按工种维护交付时「要填写的字段」与「要上传的材料」。解析优先级：工种覆盖 &gt; 大类基础 &gt; 默认兜底。保存即时生效（自动写入审计）。</p>
      </div>
      <div class="head-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button v-if="canWrite" type="primary" :loading="saving" @click="save">保存模板</el-button>
      </div>
    </div>

    <el-alert v-if="!canWrite" type="info" :closable="false" show-icon class="ro-tip" title="当前账号无 config:write 权限，仅可查看模板。" />

    <div v-loading="loading">
      <el-collapse v-if="model" v-model="active">
        <!-- 默认兜底 -->
        <el-collapse-item name="__default" title="默认兜底模板（未单独配置的工种使用）">
          <DeliverySpecEditor :spec="model.default" :readonly="!canWrite" />
        </el-collapse-item>
      </el-collapse>

      <template v-if="model">
        <div class="block-head">
          <span class="block-title">按大类（{{ categoryKeys.length }}）</span>
          <div v-if="canWrite" class="adder">
            <el-select v-model="newCategory" placeholder="选择类目" size="small" filterable style="width: 160px">
              <el-option v-for="c in addableCategories" :key="c" :label="c" :value="c" />
            </el-select>
            <el-button size="small" :disabled="!newCategory" @click="addCategory">+ 添加大类模板</el-button>
          </div>
        </div>
        <el-collapse v-model="active">
          <el-collapse-item v-for="c in categoryKeys" :key="'cat-' + c" :name="'cat-' + c">
            <template #title>
              <span class="ci-title">{{ c }}</span>
              <el-button v-if="canWrite" link type="danger" size="small" class="ci-del" @click.stop="removeCategory(c)">删除</el-button>
            </template>
            <DeliverySpecEditor :spec="model.byCategory[c]" :readonly="!canWrite" />
          </el-collapse-item>
        </el-collapse>

        <div class="block-head">
          <span class="block-title">按工种覆盖（{{ tradeKeys.length }}）</span>
          <div v-if="canWrite" class="adder">
            <el-select v-model="newTrade" placeholder="选择/输入工种" size="small" filterable allow-create default-first-option style="width: 180px">
              <el-option v-for="t in addableTrades" :key="t" :label="t" :value="t" />
            </el-select>
            <el-button size="small" :disabled="!newTrade" @click="addTrade">+ 添加工种模板</el-button>
          </div>
        </div>
        <el-collapse v-model="active">
          <el-collapse-item v-for="t in tradeKeys" :key="'trade-' + t" :name="'trade-' + t">
            <template #title>
              <span class="ci-title">{{ t }}</span>
              <el-button v-if="canWrite" link type="danger" size="small" class="ci-del" @click.stop="removeTrade(t)">删除</el-button>
            </template>
            <DeliverySpecEditor :spec="model.byTrade[t]" :readonly="!canWrite" />
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getConfigs, updateConfig } from '../api/admin'
import { useAuthStore } from '../stores/auth'
import DeliverySpecEditor from '../components/DeliverySpecEditor.vue'

const auth = useAuthStore()
const canWrite = computed(() => auth.can('config:write'))

const loading = ref(false)
const saving = ref(false)
const model = ref(null)
const categories = ref([])
const allTrades = ref([])
const active = ref(['__default'])
const newCategory = ref('')
const newTrade = ref('')

const emptySpec = () => ({ fields: [], uploads: [] })
const categoryKeys = computed(() => Object.keys(model.value?.byCategory || {}))
const tradeKeys = computed(() => Object.keys(model.value?.byTrade || {}))
const addableCategories = computed(() => categories.value.filter(c => !categoryKeys.value.includes(c)))
const addableTrades = computed(() => allTrades.value.filter(t => !tradeKeys.value.includes(t)))

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
    categories.value = list.find(c => c.key === 'categories')?.value || []
    // 工种全集：从已有模板键 + 类目（兜底）拼出可选项；运营也可自由输入新工种名
    allTrades.value = [...new Set([...tradeKeys.value])]
  } catch (e) {
    ElMessage.error('加载交付模板失败')
  } finally {
    loading.value = false
  }
}

function addCategory() {
  if (!newCategory.value || model.value.byCategory[newCategory.value]) return
  model.value.byCategory[newCategory.value] = emptySpec()
  active.value = [...active.value, 'cat-' + newCategory.value]
  newCategory.value = ''
}
function removeCategory(c) {
  delete model.value.byCategory[c]
}
function addTrade() {
  const t = String(newTrade.value).trim()
  if (!t || model.value.byTrade[t]) return
  model.value.byTrade[t] = emptySpec()
  active.value = [...active.value, 'trade-' + t]
  newTrade.value = ''
}
function removeTrade(t) {
  delete model.value.byTrade[t]
}

async function save() {
  try {
    await ElMessageBox.confirm('保存后将立即影响零工端交付表单与企业端验收展示，请确认无误。', '保存交付模板', {
      confirmButtonText: '确认保存', cancelButtonText: '取消', type: 'warning'
    })
  } catch {
    return
  }
  saving.value = true
  try {
    await updateConfig('deliverySpecs', model.value)
    ElMessage.success('交付模板已保存')
    load()
  } catch (e) {
    // 拦截器已弹出后端校验信息（如字段 key 重复 / 类型非法）
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.page {
  padding: 4px 2px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.page-title {
  font-size: 20px;
  font-weight: 700;
}
.page-sub {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 6px;
  max-width: 760px;
  line-height: 1.6;
}
.head-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.ro-tip {
  margin-bottom: 14px;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 22px 0 10px;
}
.block-title {
  font-size: 15px;
  font-weight: 700;
}
.adder {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ci-title {
  font-weight: 600;
}
.ci-del {
  margin-left: 12px;
}
</style>
