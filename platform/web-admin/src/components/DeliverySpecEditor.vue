<template>
  <div class="ed">
    <!-- 填写字段 -->
    <div class="ed-sec">
      <div class="ed-sec-head">
        <span class="ed-sec-title">填写字段<em>{{ spec.fields.length }}</em></span>
        <el-button link size="small" class="adv-toggle" @click="showAdv = !showAdv">
          {{ showAdv ? '收起高级设置' : '高级设置' }}
        </el-button>
      </div>

      <div v-if="!spec.fields.length" class="ed-empty">还没有填写字段{{ readonly ? '' : '，点下方「添加字段」开始' }}</div>

      <div v-for="(f, i) in spec.fields" :key="'f' + i" class="card">
        <div class="card-row">
          <span class="ord">{{ i + 1 }}</span>
          <el-input v-model="f.label" :disabled="readonly" placeholder="字段名称，如 成果说明" class="c-label" />
          <el-select v-model="f.type" :disabled="readonly" class="c-type">
            <el-option v-for="t in FIELD_TYPES" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
          <label class="c-req"><el-switch v-model="f.required" :disabled="readonly" size="small" /><span>必填</span></label>
          <div v-if="!readonly" class="c-ord">
            <el-button link :icon="ArrowUp" :disabled="i === 0" title="上移" @click="move(spec.fields, i, -1)" />
            <el-button link :icon="ArrowDown" :disabled="i === spec.fields.length - 1" title="下移" @click="move(spec.fields, i, 1)" />
            <el-button link type="danger" :icon="Delete" title="删除" @click="removeAt(spec.fields, i)" />
          </div>
        </div>

        <div v-if="f.type === 'select'" class="card-sub">
          <span class="sub-k">选项</span>
          <el-input
            :model-value="(f.options || []).join('，')"
            :disabled="readonly"
            size="small"
            placeholder="用逗号分隔，如 已确认，未确认"
            @update:model-value="v => setOptions(f, v)"
          />
        </div>

        <div v-if="showAdv" class="card-adv">
          <div class="adv-item"><span>标识</span><el-input v-model="f.key" :disabled="readonly" size="small" placeholder="自动生成" /></div>
          <template v-if="['text', 'textarea', 'url', 'tel'].includes(f.type)">
            <div class="adv-item"><span>最大长度</span><el-input-number v-model="f.max" :disabled="readonly" :min="0" size="small" controls-position="right" /></div>
            <div class="adv-item wide"><span>占位提示</span><el-input v-model="f.placeholder" :disabled="readonly" size="small" placeholder="灰字提示，如 网盘/云文档链接" /></div>
          </template>
          <template v-else-if="f.type === 'number'">
            <div class="adv-item"><span>单位</span><el-input v-model="f.unit" :disabled="readonly" size="small" placeholder="如 单/件/小时" style="width: 96px" /></div>
            <div class="adv-item"><span>最小值</span><el-input-number v-model="f.min" :disabled="readonly" size="small" controls-position="right" /></div>
          </template>
        </div>
      </div>

      <el-button v-if="!readonly" class="add-btn" :icon="Plus" @click="addField">添加字段</el-button>
    </div>

    <!-- 上传材料 -->
    <div class="ed-sec">
      <div class="ed-sec-head">
        <span class="ed-sec-title">上传材料<em>{{ spec.uploads.length }}</em></span>
      </div>

      <div v-if="!spec.uploads.length" class="ed-empty">还没有上传材料{{ readonly ? '' : '，点下方「添加上传项」开始' }}</div>

      <div v-for="(u, i) in spec.uploads" :key="'u' + i" class="card">
        <div class="card-row">
          <span class="ord">{{ i + 1 }}</span>
          <el-input v-model="u.label" :disabled="readonly" placeholder="材料名称，如 成果预览图" class="c-label" />
          <el-select v-model="u.accept" :disabled="readonly" class="c-type narrow">
            <el-option v-for="a in UPLOAD_ACCEPTS" :key="a.value" :label="a.label" :value="a.value" />
          </el-select>
          <label class="c-req"><el-switch v-model="u.required" :disabled="readonly" size="small" /><span>必传</span></label>
          <div class="c-num">
            <span>数量</span>
            <el-input-number v-model="u.min" :disabled="readonly" :min="0" size="small" controls-position="right" />
            <i>–</i>
            <el-input-number v-model="u.max" :disabled="readonly" :min="1" size="small" controls-position="right" />
          </div>
          <div v-if="!readonly" class="c-ord">
            <el-button link :icon="ArrowUp" :disabled="i === 0" title="上移" @click="move(spec.uploads, i, -1)" />
            <el-button link :icon="ArrowDown" :disabled="i === spec.uploads.length - 1" title="下移" @click="move(spec.uploads, i, 1)" />
            <el-button link type="danger" :icon="Delete" title="删除" @click="removeAt(spec.uploads, i)" />
          </div>
        </div>
        <div class="card-sub">
          <span class="sub-k">提示</span>
          <el-input v-model="u.hint" :disabled="readonly" size="small" placeholder="给零工的提示，如 PSD/AI 源文件（可空）" />
        </div>
        <div v-if="showAdv" class="card-adv">
          <div class="adv-item"><span>标识</span><el-input v-model="u.key" :disabled="readonly" size="small" placeholder="自动生成" /></div>
        </div>
      </div>

      <el-button v-if="!readonly" class="add-btn" :icon="Plus" @click="addUpload">添加上传项</el-button>
    </div>
  </div>
</template>

<script setup>
/* eslint-disable vue/no-mutating-props */
// 说明：spec 是父组件 model 的同一引用（model.byCategory[x] / byTrade[x] / default），
// 编辑器按设计就地修改该对象，父组件据此做 dirty 比对与保存——所有变更集中在下方方法里。
import { ref } from 'vue'
import { Delete, Plus, ArrowUp, ArrowDown } from '@element-plus/icons-vue'

const props = defineProps({
  spec: { type: Object, required: true },
  readonly: { type: Boolean, default: false }
})

const showAdv = ref(false)

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

// 自动生成稳定且唯一的标识，运营无需关心
function nextKey(arr, prefix) {
  let n = 1
  while (arr.some(x => x.key === prefix + n)) n++
  return prefix + n
}
function move(arr, i, d) {
  const j = i + d
  if (j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}
function addField() {
  props.spec.fields.push({ key: nextKey(props.spec.fields, 'field'), label: '', type: 'text', required: false })
}
function addUpload() {
  props.spec.uploads.push({ key: nextKey(props.spec.uploads, 'file'), label: '', accept: 'image', required: false, min: 0, max: 3 })
}
function removeAt(arr, i) {
  arr.splice(i, 1)
}
function setOptions(f, v) {
  f.options = splitOpts(v)
}
</script>

<style scoped>
.ed-sec {
  margin-bottom: 22px;
}
.ed-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.ed-sec-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.ed-sec-title em {
  font-style: normal;
  margin-left: 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 10px;
  padding: 1px 8px;
}
.adv-toggle { font-size: 12.5px; }
.ed-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 18px;
  text-align: center;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
}

.card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 11px;
  padding: 12px 12px 12px 10px;
  margin-bottom: 10px;
  background: var(--el-bg-color);
  transition: border-color .2s, box-shadow .2s;
}
.card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 6px 18px -12px var(--el-color-primary);
}
.card-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
}
.ord {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  display: grid;
  place-items: center;
  font-weight: 600;
}
.c-label { flex: 1 1 auto; min-width: 120px; }
.c-type { flex: 0 0 122px; }
.c-type.narrow { flex-basis: 96px; }
.c-req {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  user-select: none;
}
.c-num {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--el-text-color-regular);
}
.c-num i { color: var(--el-text-color-secondary); font-style: normal; }
.c-num :deep(.el-input-number) { width: 86px; }
.c-ord { flex: none; display: inline-flex; align-items: center; margin-left: auto; }
.card-adv :deep(.el-input-number) { width: 110px; }
.c-ord .el-button { margin-left: 2px; padding: 4px; }

.card-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  padding-left: 32px;
}
.sub-k {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  width: 30px;
}
.card-adv {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
  padding: 10px 0 2px 32px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.adv-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.adv-item.wide { flex: 1 1 240px; }
.adv-item.wide :deep(.el-input) { flex: 1; }
.add-btn {
  width: 100%;
  border-style: dashed;
  margin-top: 2px;
}
.add-btn:hover { color: var(--el-color-primary); border-color: var(--el-color-primary); }

@media (max-width: 900px) {
  .card-row { flex-wrap: wrap; }
  .c-label { flex-basis: 100%; }
}
</style>
