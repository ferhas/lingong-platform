// 证据链强化回归：四环节（派单/抢单/单据管理/单据验收）操作留痕 + 终端证据 + 防篡改哈希链 + 证据链聚合端点。
//  - 抢单(apply)/取消报名(withdraw)/交付(deliver) 现已进审计日志（修复前三动作无留痕，证据链断档）
//  - 全量审计自动捕获 IP / User-Agent / 地理位置（X-Forwarded-For / X-Geo）
//  - audit_logs 防篡改哈希链：改任意一行 → verifyChain 检出
//  - GET /company|admin/tasks/:id/evidence 返回操作时间轴 + 四流凭证 + 完整性结论（企业端 IP 脱敏）
// 独立临时库、进程内启动。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-ev-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-ev-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const { verifyChain } = await import('../src/services/audit.js')
const bcrypt = (await import('bcryptjs')).default

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin','13800000001',?,'平台运营',?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`
let passed = 0
const ok = (n, c) => { assert.ok(c, n); passed++; console.log(`  ✓ ${n}`) }

async function api(method, url, { token, body, headers } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const ct = res.headers.get('content-type') || ''
  return { status: res.status, data: ct.includes('json') ? await res.json().catch(() => null) : await res.text() }
}

const auditRow = (action, taskId) =>
  db.prepare(`SELECT * FROM audit_logs WHERE action=? AND json_extract(detail_json,'$.taskId')=? ORDER BY id DESC LIMIT 1`).get(action, taskId)

const PW = 'Test@123456'
const WORKER_GEO = '22.8170,108.3665'
try {
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  const adminToken = r.data.token

  r = await api('POST', '/auth/register', { body: { role: 'company', phone: '13900000010', password: PW, name: '李总', companyName: '证据链科技有限公司', licenseNo: '91330106MA2OEV001', industry: '软件信息服务', agree: true } })
  const companyToken = r.data.token
  const companyId = db.prepare(`SELECT id FROM companies WHERE license_no='91330106MA2OEV001'`).get().id
  await api('POST', `/admin/companies/${companyId}/review`, { token: adminToken, body: { pass: true, note: '准入' } })
  await api('POST', '/company/recharge', { token: companyToken, body: { amount: 100000 } })

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000011', password: PW, name: '陈工', agree: true } })
  const workerToken = r.data.token, workerId = r.data.user.id
  await api('POST', '/worker/verify', { token: workerToken, body: { idCard: '330106199001011235', realName: '陈工', bankCard: '6217000000006217' } })

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000012', password: PW, name: '退报名者', agree: true } })
  const quitterToken = r.data.token
  await api('POST', '/worker/verify', { token: quitterToken, body: { idCard: '330106199001011251', realName: '退报名者', bankCard: '6217000000006218' } })

  // —— 全生命周期，每步带终端证据头 ——
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '证据链全流程单', category: '设计', payMethod: '按成果', price: 10000, deadline: '2099-12-01', description: '验证四环节证据链留痕' }, headers: { 'x-forwarded-for': '203.0.113.10' } })
  const taskId = r.data.id

  console.log('— 抢单/取消报名/交付 现已进审计（修复前断档）—')
  await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken, headers: { 'x-forwarded-for': '198.51.100.22', 'x-geo': WORKER_GEO } })
  const applyAudit = auditRow('task_apply', taskId)
  ok('抢单(apply)已留痕 task_apply', !!applyAudit)
  ok('抢单留痕带 IP（终端证据）', applyAudit.ip === '198.51.100.22')
  ok('抢单留痕带地理位置（现场佐证）', applyAudit.geo === WORKER_GEO)

  await api('POST', `/worker/tasks/${taskId}/apply`, { token: quitterToken })
  await api('POST', `/worker/tasks/${taskId}/withdraw-apply`, { token: quitterToken })
  ok('取消报名(withdraw)已留痕 task_withdraw_apply', !!auditRow('task_withdraw_apply', taskId))

  await api('POST', `/company/tasks/${taskId}/hire`, { token: companyToken, body: { workerId }, headers: { 'x-forwarded-for': '203.0.113.10' } })
  ok('录用已留痕 task_hire（含分包工单号）', JSON.parse(auditRow('task_hire', taskId).detail_json).workOrderNo?.startsWith('FB'))

  await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '设计稿交付' }, headers: { 'x-forwarded-for': '198.51.100.22', 'x-geo': WORKER_GEO } })
  const deliverAudit = auditRow('task_deliver', taskId)
  ok('交付(deliver)已留痕 task_deliver', !!deliverAudit)
  ok('交付留痕带现场地理位置', deliverAudit.geo === WORKER_GEO)

  await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken, headers: { 'x-forwarded-for': '203.0.113.10' } })
  ok('验收已留痕 task_accept（含确认单号）', JSON.parse(auditRow('task_accept', taskId).detail_json).confirmNo?.startsWith('QR'))

  console.log('— 防篡改哈希链 —')
  ok('全链初始完整（verifyChain ok）', verifyChain().ok === true)
  let v = await api('GET', '/admin/audit-logs/verify', { token: adminToken })
  ok('运营端哈希链自检端点返回 ok', v.status === 200 && v.data.ok === true && v.data.count > 0)

  console.log('— 单笔工单证据链聚合（企业端，IP 脱敏）—')
  r = await api('GET', `/company/tasks/${taskId}/evidence`, { token: companyToken })
  ok('企业端证据链端点 200', r.status === 200)
  ok('证据链含操作留痕时间轴（含 apply/deliver/accept）', ['task_apply', 'task_deliver', 'task_accept'].every(a => r.data.timeline.some(e => e.action === a)))
  ok('时间轴每个节点带防篡改 hash', r.data.timeline.every(e => typeof e.hash === 'string' && e.hash.startsWith('sha256:')))
  ok('企业端 IP 已脱敏（198.51.*.*，不暴露零工完整 IP）', r.data.timeline.find(e => e.action === 'task_apply').ip === '198.51.*.*')
  ok('合同流四流凭证含分包工单(sub_order)电子签哈希', r.data.contract.some(c => c.type === 'sub_order' && c.contentHash))
  ok('业务流含交付物附件 SHA256', r.data.business.attachments.every(a => typeof a.sha256 === 'string' && a.sha256.length > 0))
  ok('票据流含发票号', !!r.data.invoice.no)
  ok('四流完整性结论 allFour=true（已结算单）', r.data.completeness.allFour === true)
  ok('证据链附带链完整性结论', r.data.chain && r.data.chain.ok === true)

  console.log('— 运营端证据链（IP 不脱敏）—')
  r = await api('GET', `/admin/tasks/${taskId}/evidence`, { token: adminToken })
  ok('运营端证据链端点 200', r.status === 200)
  ok('运营端 IP 不脱敏（取证可见完整 IP）', r.data.timeline.find(e => e.action === 'task_apply').ip === '198.51.100.22')

  console.log('— 审计列表回显终端证据 —')
  r = await api('GET', '/admin/audit-logs?action=task_deliver', { token: adminToken })
  ok('审计列表回显 ip/geo/hash 字段', r.status === 200 && r.data.list[0].ip && r.data.list[0].geo === WORKER_GEO && r.data.list[0].hash)

  console.log('— 篡改检出（改任意一行，链断裂）—')
  const victim = auditRow('task_apply', taskId)
  db.prepare(`UPDATE audit_logs SET detail = '已被恶意篡改' WHERE id = ?`).run(victim.id)
  const after = verifyChain()
  ok('改动单行后 verifyChain 检出篡改（ok=false）', after.ok === false && after.brokenAt === victim.id)
  v = await api('GET', '/admin/audit-logs/verify', { token: adminToken })
  ok('运营端自检端点同步报告链已损坏', v.data.ok === false)

  console.log(`\n✅ 证据链强化回归 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message, err.stack)
  server.close()
  process.exit(1)
}
