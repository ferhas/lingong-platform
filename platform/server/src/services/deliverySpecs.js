// 按工种结构化交付模板：解析、校验、快照与摘要。
// 模板存于 system_configs.deliverySpecs（运营端可在线编辑），解析优先级 byTrade > byCategory > default。
import { getConfig } from './configStore.js'
import { badRequest } from '../utils/errors.js'

export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'datetime', 'url', 'tel', 'select']
export const UPLOAD_ACCEPTS = ['image', 'file', 'video']

/** 取某工单（类目/工种）适用的交付模板 */
export function resolveSpec(category, trade) {
  const specs = getConfig('deliverySpecs')
  return (trade && specs.byTrade?.[trade]) || specs.byCategory?.[category] || specs.default
}

const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/**
 * 按模板校验零工提交的结构化交付内容，并产出可入库的快照。
 * @param spec        resolveSpec 得到的模板
 * @param payload     { fields:{key:value}, uploads:{key:[uploadId]} }
 * @param ownsUpload  (uploadId) => boolean，校验附件归属当前零工
 * @param ref         { category, trade }，写入快照便于回看
 * @returns { snapshot, uploadIds }  snapshot 写 tasks.deliverable_data；uploadIds 去重后入 task_attachments
 */
export function validateAndSnapshot(spec, payload, ownsUpload, ref = {}) {
  const inFields = (payload && payload.fields) || {}
  const inUploads = (payload && payload.uploads) || {}
  const snapFields = []
  const snapUploads = []
  const uploadIds = []

  for (const f of spec.fields || []) {
    let v = inFields[f.key]
    if (isBlank(v)) {
      if (f.required) throw badRequest('DELIVER_FIELD_REQUIRED', `请填写「${f.label}」`)
      continue
    }
    if (f.type === 'number') {
      v = Number(v)
      if (!Number.isFinite(v)) throw badRequest('DELIVER_FIELD_INVALID', `「${f.label}」须为数字`)
      if (typeof f.min === 'number' && v < f.min) throw badRequest('DELIVER_FIELD_INVALID', `「${f.label}」不能小于 ${f.min}`)
    } else {
      v = String(v).trim()
      if (typeof f.max === 'number' && v.length > f.max) throw badRequest('DELIVER_FIELD_INVALID', `「${f.label}」最多 ${f.max} 字`)
      if (f.type === 'select' && Array.isArray(f.options) && !f.options.includes(v)) {
        throw badRequest('DELIVER_FIELD_INVALID', `「${f.label}」取值非法`)
      }
    }
    snapFields.push({ key: f.key, label: f.label, type: f.type, value: v })
  }

  for (const u of spec.uploads || []) {
    const raw = inUploads[u.key]
    const ids = Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x) : []
    const min = u.required ? Math.max(1, u.min || 0) : (u.min || 0)
    if (ids.length < min) throw badRequest('DELIVER_UPLOAD_REQUIRED', `请上传「${u.label}」${min > 1 ? `（至少 ${min} 个）` : ''}`)
    if (typeof u.max === 'number' && ids.length > u.max) throw badRequest('DELIVER_UPLOAD_INVALID', `「${u.label}」最多 ${u.max} 个文件`)
    for (const id of ids) {
      if (!ownsUpload(id)) throw badRequest('BAD_ATTACHMENT', '附件不存在或不属于当前用户')
    }
    if (ids.length) {
      snapUploads.push({ key: u.key, label: u.label, uploadIds: ids })
      uploadIds.push(...ids)
    }
  }

  const snapshot = {
    specRef: { category: ref.category ?? null, trade: ref.trade ?? null },
    fields: snapFields,
    uploads: snapUploads
  }
  return { snapshot, uploadIds: [...new Set(uploadIds)] }
}

/** 由快照生成人话摘要，写回 tasks.deliverable（保证非空以满足四流校验，并兼容旧展示） */
export function summarize(snapshot) {
  const lines = []
  for (const f of snapshot.fields || []) lines.push(`${f.label}：${f.value}`)
  for (const u of snapshot.uploads || []) lines.push(`${u.label}：${u.uploadIds.length} 个文件`)
  return lines.join('\n') || '已交付'
}

// ============ 模板结构校验（供 configStore.setConfig 调用，运营端保存模板时拦截非法结构）============

function checkOneSpec(name, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`配置 deliverySpecs：模板「${name}」格式非法`)
  const fields = spec.fields, uploads = spec.uploads
  if (!Array.isArray(fields) || !Array.isArray(uploads)) throw new Error(`配置 deliverySpecs：模板「${name}」须含 fields 与 uploads 数组`)
  const fKeys = new Set()
  for (const f of fields) {
    if (!f || typeof f.key !== 'string' || !f.key.trim()) throw new Error(`配置 deliverySpecs：模板「${name}」字段 key 不能为空`)
    if (fKeys.has(f.key)) throw new Error(`配置 deliverySpecs：模板「${name}」字段 key「${f.key}」重复`)
    fKeys.add(f.key)
    if (typeof f.label !== 'string' || !f.label.trim()) throw new Error(`配置 deliverySpecs：模板「${name}」字段「${f.key}」缺少名称`)
    if (!FIELD_TYPES.includes(f.type)) throw new Error(`配置 deliverySpecs：模板「${name}」字段「${f.key}」类型非法`)
    if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) throw new Error(`配置 deliverySpecs：模板「${name}」单选字段「${f.key}」须提供 options`)
  }
  const uKeys = new Set()
  for (const u of uploads) {
    if (!u || typeof u.key !== 'string' || !u.key.trim()) throw new Error(`配置 deliverySpecs：模板「${name}」上传项 key 不能为空`)
    if (uKeys.has(u.key)) throw new Error(`配置 deliverySpecs：模板「${name}」上传项 key「${u.key}」重复`)
    uKeys.add(u.key)
    if (typeof u.label !== 'string' || !u.label.trim()) throw new Error(`配置 deliverySpecs：模板「${name}」上传项「${u.key}」缺少名称`)
    if (!UPLOAD_ACCEPTS.includes(u.accept)) throw new Error(`配置 deliverySpecs：模板「${name}」上传项「${u.key}」accept 非法`)
    if (typeof u.min === 'number' && typeof u.max === 'number' && u.min > u.max) throw new Error(`配置 deliverySpecs：模板「${name}」上传项「${u.key}」数量下限大于上限`)
  }
}

/** 校验整份 deliverySpecs 配置结构（default 必填，byCategory/byTrade 可选） */
export function validateSpecConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置 deliverySpecs 必须为对象')
  if (!value.default) throw new Error('配置 deliverySpecs 必须包含 default 兜底模板')
  checkOneSpec('default', value.default)
  for (const [name, spec] of Object.entries(value.byCategory || {})) checkOneSpec(name, spec)
  for (const [name, spec] of Object.entries(value.byTrade || {})) checkOneSpec(name, spec)
}
