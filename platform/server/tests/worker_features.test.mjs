// 零工端新增能力冒烟测试：基础数据字典(/worker/meta)、任务地点/工种/技能筛选、
// 保险分级展示、任务收藏、保单与进项台账、个体户引导。独立临时库、进程内启动。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-wf-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-wf-up-${Date.now()}`)
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
  console.log('— 准备：企业准入 + 充值 + 发单（含地点/工种）—')
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  const adminToken = r.data.token

  r = await api('POST', '/auth/register', { body: { role: 'company', phone: '13900000002', password: PW, name: '王经理', companyName: '杭州某电商科技有限公司', licenseNo: '91330106MA2XXXXX0K', industry: '软件信息服务', agree: true } })
  const companyToken = r.data.token
  r = await api('GET', '/admin/companies', { token: adminToken })
  const companyId = r.data.list.find(c => c.companyName.includes('电商科技')).id
  await api('POST', `/admin/companies/${companyId}/review`, { token: adminToken, body: { pass: true, note: '资质齐全' } })
  await api('POST', '/company/recharge', { token: companyToken, body: { amount: 200000 } })

  // 任务A：线上设计（基础保额），城市南宁，工种UI设计
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '电商主图设计', category: '设计', trade: 'UI设计', city: '南宁', payMethod: '按成果', price: 2000, deadline: '2099-07-01', description: '电商主图设计10张交付源文件' } })
  ok('发单携带工种/地点成功', r.status === 201)
  const taskA = r.data.id
  // 任务B：线下安装（高保额），城市柳州
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '家电安装上门', category: '安装', city: '柳州', payMethod: '按单', price: 1500, deadline: '2099-07-01', description: '家电上门安装服务按单结算' } })
  const taskB = r.data.id
  // 校验非法地点被拒
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '非法地点任务', category: '设计', city: '火星', payMethod: '按成果', price: 100, deadline: '2099-07-01', description: '用于校验地点白名单' } })
  ok('非法任务地点被拒（400 BAD_CITY）', r.status === 400 && r.data.error.code === 'BAD_CITY')

  console.log('— 零工实名 —')
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000001', password: PW, name: '李师傅', agree: true } })
  const workerToken = r.data.token
  await api('POST', '/worker/verify', { token: workerToken, body: { realName: '李师傅', idCard: '110101199003078316', bankCard: '6222021234567890123', consents: ['idcard', 'face', 'bankcard'] } })

  console.log('— 基础数据字典 /worker/meta —')
  r = await api('GET', '/worker/meta', { token: workerToken })
  ok('meta 返回类目/计酬/地点/工种/订阅模板', Array.isArray(r.data.categories) && Array.isArray(r.data.payMethods) && r.data.cities.includes('南宁') && r.data.trades.includes('UI设计') && Array.isArray(r.data.subscribeTmplIds))

  console.log('— 任务大厅：地点/工种/技能筛选 —')
  r = await api('GET', '/worker/tasks', { token: workerToken })
  ok('任务列表返回 city/trade 字段', r.data.list.every(t => t.city) && r.data.list.find(t => t.id === taskA).trade === 'UI设计')
  r = await api('GET', '/worker/tasks?city=南宁', { token: workerToken })
  ok('按城市筛选：仅南宁任务', r.data.list.some(t => t.id === taskA) && !r.data.list.some(t => t.id === taskB))
  r = await api('GET', '/worker/tasks?trade=UI设计', { token: workerToken })
  ok('按工种筛选：仅UI设计任务', r.data.list.some(t => t.id === taskA) && !r.data.list.some(t => t.id === taskB))
  r = await api('GET', '/worker/tasks?matchSkills=1', { token: workerToken })
  ok('技能匹配（无已认证技能时忽略，不报错）', r.status === 200 && Array.isArray(r.data.list))

  console.log('— 任务详情：保险分级 + 收藏态 —')
  r = await api('GET', `/worker/tasks/${taskA}`, { token: workerToken })
  ok('线上设计任务=基础保额方案', r.data.insurance && r.data.insurance.plan === '基础方案' && r.data.favorited === false)
  ok('详情含 city/trade', r.data.city === '南宁' && r.data.trade === 'UI设计')
  r = await api('GET', `/worker/tasks/${taskB}`, { token: workerToken })
  ok('线下安装任务=高保额方案', r.data.insurance && r.data.insurance.plan === '高保额方案')

  console.log('— 任务收藏 —')
  r = await api('POST', `/worker/favorites/${taskA}`, { token: workerToken })
  ok('收藏任务（201）', r.status === 201 && r.data.favorited === true)
  r = await api('GET', '/worker/favorites', { token: workerToken })
  ok('收藏列表含该任务（带city/trade）', r.data.total === 1 && r.data.list[0].id === taskA && r.data.list[0].city === '南宁')
  r = await api('GET', `/worker/tasks/${taskA}`, { token: workerToken })
  ok('详情收藏态变为 true', r.data.favorited === true)
  await api('DELETE', `/worker/favorites/${taskA}`, { token: workerToken })
  r = await api('GET', '/worker/favorites', { token: workerToken })
  ok('取消收藏后列表为空', r.data.total === 0)

  console.log('— 录用后：保单查看 —')
  const workerId = db.prepare(`SELECT id FROM users WHERE phone = '13900000001'`).get().id
  await api('POST', `/worker/tasks/${taskA}/apply`, { token: workerToken })
  r = await api('POST', `/company/tasks/${taskA}/hire`, { token: companyToken, body: { workerId } })
  ok('企业录用生成保单', r.data.policyNo && r.data.policyNo.startsWith('INS'))
  r = await api('GET', '/worker/policies', { token: workerToken })
  ok('我的保单含该单（基础方案、生效中）', r.data.total === 1 && r.data.list[0].plan === '基础方案' && r.data.list[0].active === true && r.data.list[0].hasClaim === false)

  console.log('— 进项台账 + 个体户引导 —')
  r = await api('GET', '/worker/invoices', { token: workerToken })
  ok('进项发票台账可读（自然人为空）', r.status === 200 && r.data.total === 0)
  r = await api('GET', '/worker/income', { token: workerToken })
  ok('收入接口返回个体户引导与主体类型', r.data.subjectType === 'person' && r.data.soletraderGuide && typeof r.data.soletraderGuide.threshold === 'number' && r.data.soletraderGuide.suggest === false)

  console.log(`\n✅ 零工端新增能力 ${passed} 项断言通过`)
} catch (err) {
  console.error('\n❌ 测试失败：', err.message)
  process.exitCode = 1
} finally {
  server.close()
}
