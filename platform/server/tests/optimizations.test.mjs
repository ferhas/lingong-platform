// 本轮验收优化回归：
//  - 争议举证附件当事方可下载（修复"对方当事人看得到时间线URL却 403"），无关方仍 403
//  - 企业端发票/合同列表分页（无界列表收口）
// 独立临时库、进程内启动。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-opt-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-opt-up-${Date.now()}`)
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
async function upload(token, name, content) {
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: 'text/plain' }), name)
  const res = await fetch(BASE + '/files', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd })
  return (await res.json()).id
}
const download = async (token, id) => (await fetch(BASE + `/files/${id}`, { headers: { authorization: `Bearer ${token}` } })).status
async function uploadRaw(token, name, bytes, mime) {
  const fd = new FormData()
  fd.append('file', new Blob([bytes], { type: mime }), name)
  const res = await fetch(BASE + '/files', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd })
  return { status: res.status, data: await res.json().catch(() => null) }
}

const PW = 'Test@123456'
try {
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  const adminToken = r.data.token

  r = await api('POST', '/auth/register', { body: { role: 'company', phone: '13900000010', password: PW, name: '李总', companyName: '测试视觉科技有限公司', licenseNo: '91330106MA2OPT001', industry: '软件信息服务', agree: true } })
  const companyToken = r.data.token
  const companyId = db.prepare(`SELECT id FROM companies WHERE license_no='91330106MA2OPT001'`).get().id
  await api('POST', `/admin/companies/${companyId}/review`, { token: adminToken, body: { pass: true, note: '准入' } })
  await api('POST', '/company/recharge', { token: companyToken, body: { amount: 100000 } })

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000011', password: PW, name: '陈工', agree: true } })
  const workerToken = r.data.token, workerId = r.data.user.id
  await api('POST', '/worker/verify', { token: workerToken, body: { idCard: '330106199001011235', realName: '陈工', bankCard: '6217000000006217' } })

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000012', password: PW, name: '路人', agree: true } })
  const strangerToken = r.data.token
  await api('POST', '/worker/verify', { token: strangerToken, body: { idCard: '330106199001011251', realName: '路人', bankCard: '6217000000006218' } })

  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '争议附件测试单', category: '设计', payMethod: '按成果', price: 10000, deadline: '2099-12-01', description: '用于验证争议举证附件鉴权' } })
  const taskId = r.data.id
  await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  await api('POST', `/company/tasks/${taskId}/hire`, { token: companyToken, body: { workerId } })
  await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '交付内容' } })

  console.log('— 争议举证附件鉴权 —')
  const fileW = await upload(workerToken, '零工证据.txt', '零工举证内容')
  r = await api('POST', `/worker/orders/${taskId}/dispute`, { token: workerToken, body: { type: 'other', claim: '对验收结果有异议，提交举证材料', attachmentIds: [fileW] } })
  ok('零工发起争议（带举证附件）', r.status === 201 && r.data.no)
  const disputeId = r.data.id

  r = await api('GET', `/me/disputes/${disputeId}`, { token: companyToken })
  ok('企业可见争议时间线含零工附件URL', r.status === 200 && r.data.timeline.some(e => e.attachments.some(a => a.id === fileW)))
  ok('企业（对方当事人）可下载零工举证附件（200，修复前为403）', (await download(companyToken, fileW)) === 200)
  ok('上传者本人仍可下载', (await download(workerToken, fileW)) === 200)
  ok('无关零工下载争议附件被拒（403，作用域未放宽）', (await download(strangerToken, fileW)) === 403)

  const fileC = await upload(companyToken, '企业证据.txt', '企业举证内容')
  r = await api('POST', `/me/disputes/${disputeId}/events`, { token: companyToken, body: { content: '企业补充举证材料', attachmentIds: [fileC] } })
  ok('企业提交举证留言', r.status === 201)
  ok('零工（对方当事人）可下载企业举证附件（200）', (await download(workerToken, fileC)) === 200)
  ok('无关零工下载企业证据被拒（403）', (await download(strangerToken, fileC)) === 403)

  console.log('— 企业端列表分页 —')
  r = await api('GET', '/company/contracts?page=1&pageSize=1', { token: companyToken })
  ok('企业合同分页：返回 total 且单页受限', r.status === 200 && r.data.total >= 2 && r.data.list.length <= 1)
  r = await api('GET', '/company/contracts?page=2&pageSize=1', { token: companyToken })
  ok('企业合同第2页可翻页', r.status === 200 && r.data.list.length <= 1)
  r = await api('GET', '/company/invoices?page=1&pageSize=5', { token: companyToken })
  ok('企业发票分页返回 total 与受限列表', r.status === 200 && typeof r.data.total === 'number' && r.data.list.length <= 5)

  console.log('— 上传 magic number 校验（伪造 MIME 拦截）—')
  let u = await uploadRaw(workerToken, 'fake.png', '<html><script>alert(1)</script></html>', 'image/png')
  ok('伪造 image/png（实为HTML）被拒（400 MIME_MISMATCH）', u.status === 400 && u.data?.error?.code === 'MIME_MISMATCH')
  u = await uploadRaw(workerToken, 'fake.pdf', 'not a pdf at all', 'application/pdf')
  ok('伪造 application/pdf 被拒（400 MIME_MISMATCH）', u.status === 400 && u.data?.error?.code === 'MIME_MISMATCH')
  u = await uploadRaw(workerToken, 'real.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 'image/png')
  ok('真实 PNG（magic 命中）上传成功（201）', u.status === 201 && !!u.data?.id)
  u = await uploadRaw(workerToken, 'plain.txt', '纯文本无需 magic 校验', 'text/plain')
  ok('text/plain 不强制 magic，正常上传（201）', u.status === 201 && !!u.data?.id)

  console.log('— 敏感操作强制 2FA（adminStepUpRequired，生产 fail-closed）—')
  const reviewerRoleId = db.prepare(`SELECT id FROM admin_roles WHERE name='审核专员'`).get().id
  let c = await api('PATCH', '/admin/configs/adminStepUpRequired', { token: adminToken, body: { value: 1 } })
  ok('开启 adminStepUpRequired', c.status === 200 && c.data.value === 1)
  c = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13900000019', name: '新运营', roleId: reviewerRoleId } })
  ok('未绑2FA 运营执行敏感操作被拒（403，强制先绑动态码）', c.status === 403)
  await api('PATCH', '/admin/configs/adminStepUpRequired', { token: adminToken, body: { value: 0 } })
  c = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13900000019', name: '新运营', roleId: reviewerRoleId } })
  ok('关闭后未绑2FA 仍可执行（201，与现有契约一致）', c.status === 201)

  console.log(`\n✅ 本轮优化回归 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message)
  server.close()
  process.exit(1)
}
