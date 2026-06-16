// 按工种结构化交付（交付物模板）回归：
//  - 模板解析优先级：工种覆盖 byTrade > 大类 byCategory > 默认 default
//  - 结构化交付：必填字段/必填上传/select 取值校验；快照入库；摘要写回 deliverable（四流兼容）
//  - 企业端可见结构化 deliverableData；驳回清空 deliverable_data
//  - 旧版「说明+附件」入参仍可用（向后兼容）
//  - 运营端保存模板：非法结构被拒(BAD_CONFIG)、合法结构生效
// 独立临时库、进程内启动。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-deliv-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-deliv-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin','13800000001',?,'平台运营',?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`
let passed = 0
const ok = (n, c) => { assert.ok(c, n); passed++; console.log(`  ✓ ${n}`) }
async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const ct = res.headers.get('content-type') || ''
  return { status: res.status, data: ct.includes('json') ? await res.json().catch(() => null) : await res.text() }
}
const PW = 'Test@123456'
const login = async phone => (await api('POST', '/auth/login', { body: { phone, password: PW } })).data.token

// 造一个 owner_id=wId 的假附件，返回其 upload id（绕过 multipart，仅测交付编排）
function fakeUpload(wId, name = 'f.jpg', mime = 'image/jpeg') {
  const id = randomUUID()
  db.prepare(`INSERT INTO uploads (id, owner_id, original_name, mime, size, path, sha256) VALUES (?,?,?,?,?,?,?)`)
    .run(id, wId, name, mime, 100, '/tmp/' + id, 'hash' + id.slice(0, 8))
  return id
}
function makeTask(cId, wId, category, trade) {
  return db.prepare(`INSERT INTO tasks (company_id,title,category,trade,pay_method,price,sub_price,deadline,status,worker_id,sub_order_no)
    VALUES (?,?,?,?,?,?,?,?, 'working', ?, ?)`)
    .run(cId, `${category}任务`, category, trade ?? null, '按成果', 10000, 9200, '2099-12-31', wId, 'SUB-' + randomUUID().slice(0, 8)).lastInsertRowid
}

try {
  const adminToken = (await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })).data.token
  await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900002001', password: PW, name: '小工', agree: true } })
  const wId = db.prepare(`SELECT id FROM users WHERE phone='13900002001'`).get().id
  const workerToken = await login('13900002001')
  await api('POST', '/auth/register', { body: { role: 'company', phone: '13900002002', password: PW, name: '老板', companyName: '结构化交付测试公司', licenseNo: '91330106MA2AF40001', industry: '软件信息服务', agree: true } })
  const cId = db.prepare(`SELECT id FROM companies WHERE license_no='91330106MA2AF40001'`).get().id
  const companyToken = await login('13900002002')

  const tHome = makeTask(cId, wId, '家政服务', null)
  const tVidTrade = makeTask(cId, wId, '视频', '短视频剪辑')
  const tVid = makeTask(cId, wId, '视频', null)
  const tOther = makeTask(cId, wId, '其他', null)

  console.log('— 模板解析优先级（byTrade > byCategory > default）—')
  let r = await api('GET', `/worker/orders/${tVidTrade}/deliver-spec`, { token: workerToken })
  ok('工种覆盖：短视频剪辑模板含「成片时长」字段(duration)', r.status === 200 && r.data.spec.fields.some(f => f.key === 'duration'))
  r = await api('GET', `/worker/orders/${tVid}/deliver-spec`, { token: workerToken })
  ok('大类基础：视频(无工种覆盖) 不含 duration', r.data.spec.fields.every(f => f.key !== 'duration') && r.data.spec.fields.some(f => f.key === 'videoUrl'))
  r = await api('GET', `/worker/orders/${tOther}/deliver-spec`, { token: workerToken })
  ok('默认兜底：未登记类目(其他) 命中 default 模板(note)', r.data.spec.fields.length === 1 && r.data.spec.fields[0].key === 'note')
  ok('deliver-spec 返回交付标准 standard 字段', typeof r.data.standard === 'string')
  const tAnno = makeTask(cId, wId, '数据标注', null)
  r = await api('GET', `/worker/orders/${tAnno}/deliver-spec`, { token: workerToken })
  ok('新增定制：数据标注含「标注数量」字段与必传「标注成果文件」', r.status === 200 && r.data.spec.fields.some(f => f.key === 'count') && r.data.spec.uploads.some(u => u.key === 'result' && u.required))

  console.log('— 结构化交付校验（家政服务）—')
  const before = fakeUpload(wId), after = fakeUpload(wId)
  r = await api('POST', `/worker/orders/${tHome}/deliver`, { token: workerToken, body: { fields: { confirm: '已确认' }, uploads: { before: [before], after: [after] } } })
  ok('缺必填字段(服务时长) → 400 DELIVER_FIELD_REQUIRED', r.status === 400 && r.data.error.code === 'DELIVER_FIELD_REQUIRED')
  r = await api('POST', `/worker/orders/${tHome}/deliver`, { token: workerToken, body: { fields: { hours: 2, confirm: '已确认' }, uploads: { after: [after] } } })
  ok('缺必填上传(服务前照片) → 400 DELIVER_UPLOAD_REQUIRED', r.status === 400 && r.data.error.code === 'DELIVER_UPLOAD_REQUIRED')
  r = await api('POST', `/worker/orders/${tHome}/deliver`, { token: workerToken, body: { fields: { hours: 2, confirm: '瞎填' }, uploads: { before: [before], after: [after] } } })
  ok('select 取值非法 → 400 DELIVER_FIELD_INVALID', r.status === 400 && r.data.error.code === 'DELIVER_FIELD_INVALID')
  r = await api('POST', `/worker/orders/${tHome}/deliver`, { token: workerToken, body: { fields: { hours: 2, confirm: '已确认' }, uploads: { before: [before], after: [after] } } })
  ok('结构化交付成功 → 200 delivered', r.status === 200 && r.data.status === 'delivered')

  const row = db.prepare(`SELECT deliverable, deliverable_data FROM tasks WHERE id=?`).get(tHome)
  const snap = JSON.parse(row.deliverable_data)
  ok('deliverable_data 快照含字段(服务时长/客户确认)', snap.fields.some(f => f.label === '服务时长') && snap.fields.some(f => f.key === 'confirm'))
  ok('deliverable_data 快照含上传分组(服务前/后照片)', snap.uploads.length === 2 && snap.uploads.every(u => u.uploadIds.length === 1))
  ok('deliverable 摘要非空且含「服务时长」（四流兼容）', !!row.deliverable && row.deliverable.includes('服务时长'))
  ok('交付附件已关联 task_attachments(kind=deliverable) 共 2 个',
    db.prepare(`SELECT COUNT(*) AS n FROM task_attachments WHERE task_id=? AND kind='deliverable'`).get(tHome).n === 2)

  console.log('— 企业端结构化验收与驳回 —')
  r = await api('GET', `/company/tasks/${tHome}`, { token: companyToken })
  ok('企业详情返回结构化 deliverableData', r.status === 200 && r.data.deliverableData && r.data.deliverableData.fields.some(f => f.label === '服务时长'))
  r = await api('POST', `/company/tasks/${tHome}/reject`, { token: companyToken, body: { reason: '照片不清晰，请重拍' } })
  ok('驳回 → 200 working', r.status === 200 && r.data.status === 'working')
  const afterReject = db.prepare(`SELECT status, deliverable, deliverable_data FROM tasks WHERE id=?`).get(tHome)
  ok('驳回清空 deliverable_data 与 deliverable', afterReject.deliverable_data === null && afterReject.deliverable === null)
  ok('驳回删除交付附件', db.prepare(`SELECT COUNT(*) AS n FROM task_attachments WHERE task_id=? AND kind='deliverable'`).get(tHome).n === 0)

  console.log('— 向后兼容：旧版「说明+附件」入参 —')
  const legacyFile = fakeUpload(wId)
  r = await api('POST', `/worker/orders/${tOther}/deliver`, { token: workerToken, body: { note: '成稿链接见附件', attachmentIds: [legacyFile] } })
  ok('旧版交付仍 200 delivered', r.status === 200 && r.data.status === 'delivered')
  const legacyRow = db.prepare(`SELECT deliverable, deliverable_data FROM tasks WHERE id=?`).get(tOther)
  ok('旧版交付 deliverable_data 为 NULL、deliverable=note', legacyRow.deliverable_data === null && legacyRow.deliverable === '成稿链接见附件')

  console.log('— 运营端保存模板：结构校验 —')
  r = await api('PATCH', '/admin/configs/deliverySpecs', { token: adminToken, body: { value: { byCategory: {} } } })
  ok('缺 default → 400 BAD_CONFIG', r.status === 400 && r.data.error.code === 'BAD_CONFIG')
  r = await api('PATCH', '/admin/configs/deliverySpecs', { token: adminToken, body: { value: { default: { fields: [{ key: 'x', label: 'X', type: 'bogus' }], uploads: [] } } } })
  ok('字段类型非法 → 400 BAD_CONFIG', r.status === 400 && r.data.error.code === 'BAD_CONFIG')
  r = await api('PATCH', '/admin/configs/deliverySpecs', { token: adminToken, body: { value: { default: { fields: [{ key: 'note', label: '交付说明改', type: 'textarea', required: true }], uploads: [] }, byCategory: {}, byTrade: {} } } })
  ok('合法模板保存 → 200', r.status === 200)
  r = await api('GET', `/worker/orders/${tVid}/deliver-spec`, { token: workerToken })
  ok('保存后即时生效：视频任务回落到新 default(交付说明改)', r.data.spec.fields[0].label === '交付说明改')

  console.log(`\n✅ 结构化交付回归测试 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message, err.stack)
  server.close()
  process.exit(1)
}
