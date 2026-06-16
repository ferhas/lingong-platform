<template>
  <div class="pv">
    <div class="pv-frame">
      <div class="pv-notch"></div>
      <div class="pv-screen">
        <div class="pv-appbar">交付物 · 零工端预览</div>
        <div class="pv-body">
          <div v-if="!fields.length && !uploads.length" class="pv-empty">
            该模板还没有任何字段或上传项<br />在左侧添加后，这里实时预览零工看到的样子
          </div>

          <template v-else>
            <div v-for="(f, i) in fields" :key="'f' + i" class="pv-field">
              <div class="pv-label">
                {{ f.label || '未命名字段' }}
                <span v-if="f.required" class="pv-req">*</span>
              </div>
              <div v-if="f.type === 'textarea'" class="pv-input pv-area">{{ f.placeholder || '请输入' }}</div>
              <div v-else-if="f.type === 'select'" class="pv-input pv-select">
                <span>{{ (f.options && f.options[0]) || '请选择' }}</span><i>▾</i>
              </div>
              <div v-else class="pv-input">
                <span class="pv-ph">{{ phFor(f) }}</span>
                <span v-if="f.type === 'number' && f.unit" class="pv-unit">{{ f.unit }}</span>
                <i v-if="f.type === 'date' || f.type === 'datetime'" class="pv-cal">📅</i>
              </div>
            </div>

            <div v-for="(u, i) in uploads" :key="'u' + i" class="pv-upload-wrap">
              <div class="pv-label">
                {{ u.label || '未命名材料' }}
                <span v-if="u.required" class="pv-req">*</span>
                <span class="pv-count">{{ countText(u) }}</span>
              </div>
              <div class="pv-uploads">
                <div class="pv-up-box"><span class="pv-plus">＋</span><span class="pv-up-t">{{ acceptText(u.accept) }}</span></div>
              </div>
              <div v-if="u.hint" class="pv-hint">{{ u.hint }}</div>
            </div>
          </template>
        </div>
        <div class="pv-submit">提交交付</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ spec: { type: Object, required: true } })
const fields = computed(() => props.spec?.fields || [])
const uploads = computed(() => props.spec?.uploads || [])

const PH = { text: '请输入', url: '粘贴链接', tel: '请输入电话', number: '请输入数字', date: '选择日期', datetime: '选择日期时间' }
const phFor = f => f.placeholder || PH[f.type] || '请输入'
const acceptText = a => ({ image: '上传图片', file: '上传文件', video: '上传视频' }[a] || '上传')
function countText(u) {
  const min = u.required ? Math.max(1, u.min || 0) : (u.min || 0)
  const max = u.max || ''
  if (max && min) return `${min}–${max} 个`
  if (max) return `最多 ${max} 个`
  if (min) return `至少 ${min} 个`
  return ''
}
</script>

<style scoped>
.pv {
  display: flex;
  justify-content: center;
  padding: 6px 0;
}
.pv-frame {
  width: 300px;
  border-radius: 30px;
  background: var(--el-bg-color-page, #f2f3f5);
  border: 8px solid var(--el-border-color, #dcdfe6);
  box-shadow: 0 18px 40px -20px rgba(0, 0, 0, .5);
  padding: 0;
  position: relative;
  overflow: hidden;
}
.pv-notch {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 110px;
  height: 18px;
  background: var(--el-border-color, #dcdfe6);
  border-radius: 0 0 12px 12px;
  z-index: 2;
}
.pv-screen {
  background: var(--el-bg-color, #fff);
  border-radius: 22px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 560px;
}
.pv-appbar {
  background: linear-gradient(120deg, var(--el-color-primary), var(--el-color-primary-light-3));
  color: #fff;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  padding: 22px 0 12px;
}
.pv-body {
  padding: 16px 16px 8px;
  overflow-y: auto;
  flex: 1;
}
.pv-empty {
  color: var(--el-text-color-secondary);
  font-size: 12.5px;
  text-align: center;
  line-height: 1.9;
  padding: 40px 8px;
}
.pv-field, .pv-upload-wrap {
  margin-bottom: 16px;
}
.pv-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.pv-req {
  color: var(--el-color-danger);
  font-weight: 700;
}
.pv-count {
  margin-left: auto;
  font-weight: 400;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.pv-input {
  min-height: 38px;
  border: 1px solid var(--el-border-color);
  border-radius: 9px;
  background: var(--el-fill-color-blank, var(--el-bg-color));
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
  gap: 6px;
}
.pv-ph { flex: 1; }
.pv-unit, .pv-cal { color: var(--el-text-color-secondary); font-size: 12px; }
.pv-area { min-height: 64px; align-items: flex-start; padding-top: 10px; }
.pv-select { justify-content: space-between; }
.pv-select i { color: var(--el-text-color-secondary); font-style: normal; }
.pv-uploads { display: flex; gap: 10px; }
.pv-up-box {
  width: 76px;
  height: 76px;
  border: 1.5px dashed var(--el-border-color);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}
.pv-plus { font-size: 22px; line-height: 1; }
.pv-up-t { font-size: 11px; }
.pv-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.pv-submit {
  margin: 4px 16px 18px;
  background: var(--el-color-primary);
  color: #fff;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  padding: 11px 0;
  border-radius: 10px;
}
</style>
