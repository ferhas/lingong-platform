// 第三轮审计修复回归（双轴审计后修复项的契约化保护）：
//  - RBAC 最小权限/职责分离：新增「合规专员」(export:approve+user:read_pii)；dispute:rule 由一线客服移交风控
//  - PII 导出收口：自动批准的小批量下载按申报行数物理截断，杜绝借小额申报套取全量名册（P1）
//  - 强制登记阈值锁：个体户(B线)不被锁（修复 risk.js/housekeeping.js 双站点判定不一致，个体户无自助解锁路径）
//  - 任务详情作用域：零工不可枚举他企业非招募中任务（防信息枚举）
// 独立临时库、进程内启动。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-af3-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-af3-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default
const { postSettlementChecks } = await import('../src/services/risk.js')
const { currentPeriod } = await import('../src/utils/ids.js')

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
const login = async (phone) => (await api('POST', '/auth/login', { body: { phone, password: PW } })).data.token
const PW = 'Test@123456'

try {
  const adminToken = (await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })).data.token
  const perms = name => JSON.parse(db.prepare(`SELECT permissions FROM admin_roles WHERE name=?`).get(name).permissions)

  console.log('— RBAC 最小权限与职责分离 —')
  ok('新增合规专员，持 export:approve + user:read_pii（PIPL 审批职责分离）',
    perms('合规专员').includes('export:approve') && perms('合规专员').includes('user:read_pii'))
  ok('客服不再持 dispute:rule（裁决动用冻结资金，一线客服最小权限）', !perms('客服').includes('dispute:rule'))
  ok('争议裁决权移交风控专员', perms('风控专员').includes('dispute:rule'))
  const r0 = await api('GET', '/admin/roles', { token: adminToken })
  ok('预置角色含合规专员（共 7 个）', r0.data.list.length === 7 && r0.data.list.some(x => x.name === '合规专员'))

  console.log('— PII 导出：小额申报自动批准但下载按额度物理截断 —')
  await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900001001', password: PW, name: '甲', agree: true } })
  await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900001002', password: PW, name: '乙', agree: true } })
  ok('已注册 2 个零工', db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='worker'`).get().n === 2)

  let r = await api('POST', '/admin/exports', { token: adminToken, body: { scope: '抽样核对', reason: '抽样核对个别零工信息', rowEstimate: 1 } })
  ok('小额(1<50)自动批准', r.data.status === 'approved')
  const dl = await fetch(`${BASE}/admin/exports/${r.data.id}/download`, { headers: { authorization: `Bearer ${adminToken}` } })
  const csv = (await dl.text()).trim()
  const dataRows = csv.split('\r\n').slice(1).filter(Boolean)
  ok('下载行数被申报额度(1)物理截断，未导出全部 2 名零工（杜绝借小额套取全量名册）',
    dl.status === 200 && dataRows.length === 1)
  ok('截断时产生「导出越权风险」高危预警', !!db.prepare(`SELECT 1 FROM risk_alerts WHERE type='导出越权风险' AND level='高'`).get())

  console.log('— 强制登记阈值锁：个体户(B线)不被锁 / 自然人(A线)仍被锁 —')
  await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900001003', password: PW, name: '丙', agree: true } })
  const wId = db.prepare(`SELECT id FROM users WHERE phone='13900001003'`).get().id
  await api('POST', '/auth/register', { body: { role: 'company', phone: '13900001004', password: PW, name: '丁', companyName: '某科技有限公司', licenseNo: '91330106MA2AF30001', industry: '软件信息服务', agree: true } })
  const cId = db.prepare(`SELECT id FROM companies WHERE license_no='91330106MA2AF30001'`).get().id
  const tId = db.prepare(`INSERT INTO tasks (company_id,title,category,pay_method,price,sub_price,deadline) VALUES (?,?,?,?,?,?,?)`)
    .run(cId, '阈值锁回归任务', '设计', '按成果', 100, 92, '2099-12-31').lastInsertRowid
  const period = currentPeriod()
  const threshold = 4800000 * 100 // forceRegisterRolling12m 默认 4800000 元，达此值触发强制登记锁
  db.prepare(`INSERT INTO tax_records (worker_id, task_id, company_id, gross, tax, vat, net, method, income_type, consecutive_months, period)
    VALUES (?, ?, ?, ?, 0, 0, ?, 'cumulative', 'labor_continuous', 1, ?)`).run(wId, tId, cId, threshold, threshold, period)

  db.prepare(`UPDATE worker_profiles SET subject_type='soletrader', locked=0, lock_reason=NULL WHERE user_id=?`).run(wId)
  postSettlementChecks({ workerId: wId, workerName: '丙', companyId: cId, companyName: '某科技', period })
  ok('个体户达阈值不被强制登记锁（修复双站点不一致；其无自助解锁路径，误锁即卡死接单）',
    db.prepare(`SELECT locked FROM worker_profiles WHERE user_id=?`).get(wId).locked === 0)

  db.prepare(`UPDATE worker_profiles SET subject_type='person', locked=0, lock_reason=NULL WHERE user_id=?`).run(wId)
  postSettlementChecks({ workerId: wId, workerName: '丙', companyId: cId, companyName: '某科技', period })
  const after = db.prepare(`SELECT locked, lock_reason FROM worker_profiles WHERE user_id=?`).get(wId)
  ok('自然人达阈值仍被强制登记锁 threshold（既有合规行为保留）', after.locked === 1 && after.lock_reason === 'threshold')

  console.log('— 任务详情作用域：零工不可枚举他企业非招募中任务 —')
  const jiaToken = await login('13900001001')
  r = await api('GET', `/worker/tasks/${tId}`, { token: jiaToken })
  ok('招募中任务对任意零工可见', r.status === 200)
  db.prepare(`UPDATE tasks SET status='settled' WHERE id=?`).run(tId)
  r = await api('GET', `/worker/tasks/${tId}`, { token: jiaToken })
  ok('非招募中且无关联的任务对零工返回 404（防枚举他企业已结算/已下线任务）', r.status === 404)

  console.log(`\n✅ 第三轮审计修复回归测试 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message)
  server.close()
  process.exit(1)
}
