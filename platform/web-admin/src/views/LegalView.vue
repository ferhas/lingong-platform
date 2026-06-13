<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">协议/合同模板</h2>
        <p class="page-sub">
          维护注册协议和合同模板的正文。保存即发布新版本:新注册、新签合同用新版,已签的不受影响
          <el-tag v-if="!canWrite" size="small" type="info" effect="plain" style="margin-left: 8px">只读</el-tag>
        </p>
      </div>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <div class="panel">
      <el-tabs v-model="activeType">
        <el-tab-pane v-for="doc in docs" :key="doc.type" :name="doc.type">
          <template #label>
            {{ doc.title }}
            <el-badge v-if="isDirty(doc)" is-dot class="dirty-dot" />
          </template>
        </el-tab-pane>
      </el-tabs>

      <el-empty v-if="!loading && docs.length === 0" description="暂无文书数据" :image-size="90" />

      <template v-if="activeDoc">
        <div class="doc-meta">
          <el-tag type="primary" effect="plain">当前版本 v{{ activeDoc.version }}</el-tag>
          <el-tag size="small" :type="activeDoc.kind === 'template' ? 'warning' : 'info'" effect="plain">
            {{ activeDoc.kind === 'template' ? '合同模板' : '注册协议' }}
          </el-tag>
          <span class="doc-updated">最近更新:{{ fmtTime(activeDoc.updatedAt) }}</span>
        </div>

        <el-alert
          v-if="activeDoc.placeholders.length"
          type="warning"
          :closable="false"
          show-icon
          class="ph-alert"
        >
          <template #title>本模板可用占位符(签署时系统自动替换为真实数据,请不要改动写法)</template>
          <div class="ph-list">
            <span v-for="ph in activeDoc.placeholders" :key="ph.key" class="ph-item">
              <code class="mono">{{ phToken(ph.key) }}</code>
              <span class="ph-desc">{{ ph.desc }}</span>
            </span>
          </div>
        </el-alert>
        <el-alert v-else type="info" :closable="false" show-icon class="ph-alert">
          本文书为纯文本协议,注册页「查看协议」会展示这里的内容,无占位符。
        </el-alert>

        <el-input
          v-model="activeDoc.draft"
          type="textarea"
          class="doc-editor"
          :readonly="!canWrite"
          :autosize="false"
          resize="vertical"
          placeholder="文书正文"
        />

        <div class="doc-footer">
          <span v-if="isDirty(activeDoc)" class="dirty-tip">内容已修改,尚未保存</span>
          <el-button v-if="isDirty(activeDoc)" @click="activeDoc.draft = activeDoc.content">还 原</el-button>
          <el-tooltip
            :content="canWrite ? '' : '需要「修改业务参数和协议模板」权限(config:write)'"
            :disabled="canWrite"
            placement="top"
          >
            <span>
              <el-button
                type="primary"
                :disabled="!canWrite || !isDirty(activeDoc)"
                :loading="activeDoc.saving"
                @click="save(activeDoc)"
              >
                保存并发布新版本
              </el-button>
            </span>
          </el-tooltip>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getLegalDocs, updateLegalDoc } from '../api/admin'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canWrite = computed(() => auth.can('config:write'))

// 6 份文书的展示顺序与占位符说明(kind: agreement 纯协议 / template 合同模板)
const DOC_META = {
  tos: { order: 1, kind: 'agreement', placeholders: [] },
  privacy: { order: 2, kind: 'agreement', placeholders: [] },
  master: {
    order: 3,
    kind: 'template',
    placeholders: [
      { key: 'partyA', desc: '企业名称(甲方)' },
      { key: 'licenseNo', desc: '统一社会信用代码' },
      { key: 'contractNo', desc: '合同编号' },
      { key: 'date', desc: '签署日期' },
      { key: 'hash', desc: '电子签内容哈希' }
    ]
  },
  frame_sub: {
    order: 4,
    kind: 'template',
    placeholders: [
      { key: 'partyB', desc: '零工实名姓名(乙方)' },
      { key: 'contractNo', desc: '合同编号' },
      { key: 'date', desc: '签署日期' },
      { key: 'hash', desc: '电子签内容哈希' }
    ]
  },
  work_order: {
    order: 5,
    kind: 'template',
    placeholders: [
      { key: 'partyA', desc: '企业名称(甲方)' },
      { key: 'contractNo', desc: '工单编号' },
      { key: 'date', desc: '签署日期' },
      { key: 'taskTitle', desc: '任务标题' },
      { key: 'category', desc: '任务类目' },
      { key: 'payMethod', desc: '计酬方式' },
      { key: 'price', desc: '发单价(元)' },
      { key: 'deadline', desc: '交付截止日' },
      { key: 'standard', desc: '验收标准' },
      { key: 'hash', desc: '电子签内容哈希' }
    ]
  },
  sub_order: {
    order: 6,
    kind: 'template',
    placeholders: [
      { key: 'partyB', desc: '零工实名姓名(乙方)' },
      { key: 'contractNo', desc: '工单编号' },
      { key: 'date', desc: '签署日期' },
      { key: 'taskTitle', desc: '任务标题' },
      { key: 'payMethod', desc: '计酬方式' },
      { key: 'subPrice', desc: '分包价(元,零工税前所得)' },
      { key: 'policyNo', desc: '保险保单号' },
      { key: 'hash', desc: '电子签内容哈希' }
    ]
  }
}

const loading = ref(false)
const docs = ref([])
const activeType = ref('')

const activeDoc = computed(() => docs.value.find(d => d.type === activeType.value))

function isDirty(doc) {
  return doc.draft !== doc.content
}

// 占位符展示:不能在模板里直接写双花括号字面量,会被 Vue 当作插值
function phToken(key) {
  return `{{${key}}}`
}

async function load() {
  loading.value = true
  try {
    const data = await getLegalDocs()
    docs.value = (data.list || [])
      .map(d => {
        const meta = DOC_META[d.type] || { order: 99, kind: 'agreement', placeholders: [] }
        return {
          type: d.type,
          title: d.title,
          version: d.version,
          content: d.content,
          draft: d.content,
          updatedAt: d.updated_at || d.updatedAt,
          kind: meta.kind,
          placeholders: meta.placeholders,
          order: meta.order,
          saving: false
        }
      })
      .sort((a, b) => a.order - b.order)
    if (!docs.value.some(d => d.type === activeType.value)) {
      activeType.value = docs.value[0]?.type || ''
    }
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

async function save(doc) {
  if (doc.draft.trim().length < 20) {
    ElMessage.warning('正文过短(至少 20 字),请完善后保存')
    return
  }
  try {
    await ElMessageBox.confirm(
      `保存后将生成 v${doc.version + 1} 版本,新签合同将使用新模板,已签合同不受影响。确定发布吗?`,
      `发布「${doc.title}」新版本`,
      { type: 'warning', confirmButtonText: '确认发布', cancelButtonText: '再检查一下' }
    )
  } catch {
    return
  }
  doc.saving = true
  try {
    const res = await updateLegalDoc(doc.type, doc.draft)
    doc.version = res.version
    doc.content = doc.draft
    doc.updatedAt = new Date().toISOString()
    ElMessage.success(`「${doc.title}」已发布 v${res.version} 版本`)
  } catch {
    /* 错误已统一提示 */
  } finally {
    doc.saving = false
  }
}

onMounted(load)
</script>

<style scoped>
.dirty-dot {
  margin-left: 4px;
  vertical-align: super;
}

.doc-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.doc-updated {
  font-size: 12px;
  color: var(--text-3);
}

.ph-alert {
  margin-bottom: 12px;
}

.ph-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin-top: 6px;
}

.ph-item {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ph-item code {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--accent);
}

.ph-desc {
  color: var(--text-2);
}

.doc-editor :deep(.el-textarea__inner) {
  height: 400px;
  font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.8;
}

.doc-footer {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.dirty-tip {
  font-size: 12px;
  color: var(--warning);
}
</style>
