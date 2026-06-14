<template>
  <div class="spec-editor">
    <div class="se-sub">填写字段</div>
    <el-table :data="spec.fields" size="small" border empty-text="暂无字段">
      <el-table-column label="标识 key" width="140">
        <template #default="{ row }"><el-input v-model="row.key" size="small" :disabled="readonly" placeholder="如 note" /></template>
      </el-table-column>
      <el-table-column label="名称" width="150">
        <template #default="{ row }"><el-input v-model="row.label" size="small" :disabled="readonly" placeholder="如 交付说明" /></template>
      </el-table-column>
      <el-table-column label="类型" width="130">
        <template #default="{ row }">
          <el-select v-model="row.type" size="small" :disabled="readonly">
            <el-option v-for="t in FIELD_TYPES" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="必填" width="64" align="center">
        <template #default="{ row }"><el-switch v-model="row.required" :disabled="readonly" /></template>
      </el-table-column>
      <el-table-column label="最大长度" width="110" align="center">
        <template #default="{ row }"><el-input-number v-model="row.max" size="small" :min="0" controls-position="right" :disabled="readonly" style="width: 92px" /></template>
      </el-table-column>
      <el-table-column label="选项（逗号分隔，select 用）" min-width="180">
        <template #default="{ row }">
          <el-input
            v-if="row.type === 'select'"
            :model-value="(row.options || []).join(',')"
            size="small"
            :disabled="readonly"
            placeholder="如 已确认,未确认"
            @update:model-value="v => (row.options = splitOpts(v))"
          />
          <span v-else class="dim">—</span>
        </template>
      </el-table-column>
      <el-table-column v-if="!readonly" label="" width="56" align="center">
        <template #default="{ $index }"><el-button link type="danger" size="small" @click="spec.fields.splice($index, 1)">删</el-button></template>
      </el-table-column>
    </el-table>
    <el-button v-if="!readonly" size="small" plain class="se-add" @click="addField">+ 添加字段</el-button>

    <div class="se-sub">上传材料</div>
    <el-table :data="spec.uploads" size="small" border empty-text="暂无上传项">
      <el-table-column label="标识 key" width="140">
        <template #default="{ row }"><el-input v-model="row.key" size="small" :disabled="readonly" placeholder="如 preview" /></template>
      </el-table-column>
      <el-table-column label="名称" width="150">
        <template #default="{ row }"><el-input v-model="row.label" size="small" :disabled="readonly" placeholder="如 成果预览图" /></template>
      </el-table-column>
      <el-table-column label="材料类型" width="120">
        <template #default="{ row }">
          <el-select v-model="row.accept" size="small" :disabled="readonly">
            <el-option v-for="a in UPLOAD_ACCEPTS" :key="a.value" :label="a.label" :value="a.value" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="必填" width="64" align="center">
        <template #default="{ row }"><el-switch v-model="row.required" :disabled="readonly" /></template>
      </el-table-column>
      <el-table-column label="数量下限" width="100" align="center">
        <template #default="{ row }"><el-input-number v-model="row.min" size="small" :min="0" controls-position="right" :disabled="readonly" style="width: 84px" /></template>
      </el-table-column>
      <el-table-column label="数量上限" width="100" align="center">
        <template #default="{ row }"><el-input-number v-model="row.max" size="small" :min="1" controls-position="right" :disabled="readonly" style="width: 84px" /></template>
      </el-table-column>
      <el-table-column label="提示文案" min-width="160">
        <template #default="{ row }"><el-input v-model="row.hint" size="small" :disabled="readonly" placeholder="如 PSD/AI 等源文件" /></template>
      </el-table-column>
      <el-table-column v-if="!readonly" label="" width="56" align="center">
        <template #default="{ $index }"><el-button link type="danger" size="small" @click="spec.uploads.splice($index, 1)">删</el-button></template>
      </el-table-column>
    </el-table>
    <el-button v-if="!readonly" size="small" plain class="se-add" @click="addUpload">+ 添加上传项</el-button>
  </div>
</template>

<script setup>
const props = defineProps({
  spec: { type: Object, required: true },
  readonly: { type: Boolean, default: false }
})

const FIELD_TYPES = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行说明' },
  { value: 'number', label: '数字' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期时间' },
  { value: 'url', label: '链接' },
  { value: 'tel', label: '电话' },
  { value: 'select', label: '单选' }
]
const UPLOAD_ACCEPTS = [
  { value: 'image', label: '图片' },
  { value: 'file', label: '文件' },
  { value: 'video', label: '视频' }
]

const splitOpts = v => String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean)

function addField() {
  props.spec.fields.push({ key: '', label: '', type: 'text', required: false })
}
function addUpload() {
  props.spec.uploads.push({ key: '', label: '', accept: 'image', required: false, min: 0, max: 3 })
}
</script>

<style scoped>
.spec-editor {
  padding: 4px 0;
}
.se-sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin: 14px 0 8px;
}
.se-add {
  margin-top: 8px;
}
.dim {
  color: var(--el-text-color-placeholder);
}
</style>
