// 审计修复回归测试：分包价透出、主体类型路由的收入预估、导出行数阈值自动批准、
// 零工/资金流水筛选、/auth/me 的 totpEnabled、审计动作字典。独立临时库、进程内启动。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-af-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-af-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', '13800000001', ?, '平台运营', ?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`

let passed = 0
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`) }

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

try {
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  const adminToken = r.data.token

  console.log('— /auth/me 暴露 totpEnabled —')
  r = await api('GET', '/auth/me', { token: adminToken })
  ok('admin /auth/me 返回 totpEnabled=false（未绑定）', r.data.role === 'admin' && r.data.totpEnabled === false)

  console.log('— 审计动作字典 —')
  r = await api('GET', '/admin/audit-logs/actions', { token: adminToken })
  ok('审计动作字典返回去重动作清单（含 login）', Array.isArray(r.data.actions) && r.data.actions.includes('login'))

  console.log('— 准备企业与任务 —')
  r = await api('POST', '/auth/register', { body: { role: 'company', phone: '13900000002', password: PW, name: '王经理', companyName: '杭州某电商科技有限公司', licenseNo: '91330106MA2XXXXX0K', industry: '软件信息服务', agree: true } })
  const companyToken = r.data.token
  ok('企业注册会话即下发 memberRole=owner', r.data.user && r.data.user.memberRole === 'owner')
  // 刷新令牌响应同样携带 memberRole（修复静默刷新后前端角色门禁失准）
  let rs = await api('POST', '/auth/refresh', { body: { refreshToken: r.data.refreshToken } })
  ok('刷新令牌响应携带 memberRole=owner', rs.data.user && rs.data.user.memberRole === 'owner')
  rs = await api('POST', '/auth/login', { body: { phone: '13900000002', password: PW } })
  ok('企业登录响应携带 memberRole=owner', rs.data.user && rs.data.user.memberRole === 'owner')
  r = await api('GET', '/admin/companies', { token: adminToken })
  const companyId = r.data.list.find(c => c.companyName.includes('电商科技')).id
  await api('POST', `/admin/companies/${companyId}/review`, { token: adminToken, body: { pass: true, note: '资质齐全' } })
  await api('POST', '/company/recharge', { token: companyToken, body: { amount: 200000 } })

  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '电商主图设计', category: '设计', trade: 'UI设计', city: '南宁', payMethod: '按成果', price: 2000, deadline: '2099-07-01', description: '电商主图设计10张交付源文件', standard: '提供源文件+可商用授权' } })
  const taskA = r.data.id

  console.log('— 分包价透出（承揽价 2000 → 分包价 1840）—')
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000001', password: PW, name: '李师傅', agree: true } })
  const workerToken = r.data.token
  await api('POST', '/worker/verify', { token: workerToken, body: { realName: '李师傅', idCard: '110101199003078316', bankCard: '6222021234567890123', consents: ['idcard', 'face', 'bankcard'] } })

  r = await api('GET', '/worker/tasks', { token: workerToken })
  const cardA = r.data.list.find(t => t.id === taskA)
  ok('任务大厅返回 subPrice 且小于承揽价', cardA.subPrice === 1840 && cardA.subPrice < cardA.price)

  r = await api('GET', `/worker/tasks/${taskA}`, { token: workerToken })
  ok('任务详情返回 subPrice 与 estimate.subjectType=person', r.data.subPrice === 1840 && r.data.estimate.subjectType === 'person')
  ok('自然人收入预估含预扣个税（tax>=0、net<=gross）', r.data.estimate.tax >= 0 && r.data.estimate.net <= r.data.estimate.gross)

  console.log('— 个体户（B线）收入预估不代扣 —')
  await api('POST', '/worker/soletrader', { token: workerToken, body: { licenseNo: '92330106MA2K1234X1' } })
  r = await api('GET', `/worker/tasks/${taskA}`, { token: workerToken })
  ok('个体户预估 subjectType=soletrader 且不代扣（tax=0/vat=0/net=gross）',
    r.data.estimate.subjectType === 'soletrader' && r.data.estimate.tax === 0 && r.data.estimate.vat === 0 && r.data.estimate.net === r.data.estimate.gross)

  console.log('— 零工管理筛选（subjectType/status）—')
  r = await api('GET', '/admin/workers?subjectType=soletrader', { token: adminToken })
  ok('按主体类型筛选：仅个体户', r.data.list.length >= 1 && r.data.list.every(w => w.subjectType === 'soletrader'))
  r = await api('GET', '/admin/workers?subjectType=person', { token: adminToken })
  ok('按主体类型筛选：自然人不含已转个体户者', r.data.list.every(w => w.subjectType === 'person'))
  r = await api('GET', '/admin/workers?status=disabled', { token: adminToken })
  ok('按状态筛选 disabled：当前无停用零工', r.data.total === 0)

  console.log('— 资金流水筛选（type/ownerType）—')
  r = await api('GET', '/admin/flows?type=recharge', { token: adminToken })
  ok('按类型筛选：仅充值流水', r.data.list.length >= 1 && r.data.list.every(f => f.type === 'recharge'))
  r = await api('GET', '/admin/flows?ownerType=company', { token: adminToken })
  ok('按账户类型筛选：仅企业户流水', r.data.list.every(f => f.ownerType === 'company'))
  r = await api('GET', '/admin/flows?type=withdraw', { token: adminToken })
  ok('按类型筛选 withdraw：当前无提现流水', r.data.total === 0)

  console.log('— 个人信息导出：行数阈值自动批准 —')
  r = await api('POST', '/admin/exports', { token: adminToken, body: { scope: '小批量零工名册', reason: '客服核对个别零工信息', rowEstimate: 10 } })
  ok('预计行数低于阈值(50)自动批准', r.status === 201 && r.data.status === 'approved')
  const smallExportId = r.data.id
  r = await api('POST', '/admin/exports', { token: adminToken, body: { scope: '全量零工名册', reason: '季度涉税报送底稿核对', rowEstimate: 9999 } })
  ok('预计行数超过阈值进入待审批', r.status === 201 && r.data.status === 'pending')
  r = await api('POST', '/admin/exports', { token: adminToken, body: { scope: '全量零工名册', reason: '未填行数默认进入审批' } })
  ok('未填预计行数进入待审批', r.status === 201 && r.data.status === 'pending')
  // 自动批准的小批量导出可由申请人直接下载
  const dl = await fetch(`${BASE}/admin/exports/${smallExportId}/download`, { headers: { authorization: `Bearer ${adminToken}` } })
  ok('自动批准的导出可直接下载（200 CSV）', dl.status === 200)

  console.log('— 企业详情成员手机号脱敏（PIPL）—')
  r = await api('GET', `/admin/companies/${companyId}/detail`, { token: adminToken })
  // 超管持 user:read_pii，应看到完整号；脱敏逻辑由 phoneFor 统一处理（与零工列表一致）
  ok('企业详情返回成员（含手机号字段）', Array.isArray(r.data.members) && r.data.members.length >= 1 && !!r.data.members[0].phone)

  console.log('— 零工税务说明随每月减除费用配置动态生成 —')
  await api('PATCH', '/admin/configs/monthlyDeduction', { token: adminToken, body: { value: 6000 } })
  r = await api('GET', '/worker/income', { token: workerToken })
  ok('taxNote 反映配置的每月减除费用（6000元/月，非写死5000）',
    typeof r.data.taxSummary.taxNote === 'string' && r.data.taxSummary.taxNote.includes('6000元/月') && !r.data.taxSummary.taxNote.includes('5000元/月'))

  console.log(`\n✅ 审计修复回归测试 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message)
  server.close()
  process.exit(1)
}
