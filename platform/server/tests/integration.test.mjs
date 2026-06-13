// 端到端集成测试：独立临时数据库,进程内启动服务,覆盖四端全部业务流、权限体系与安全负向校验
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDb = path.join(os.tmpdir(), `gigwork-test-${Date.now()}.db`)
process.env.DB_PATH = tmpDb
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default
const { _testHooks } = await import('../src/integrations/index.js')
const { runSettlementRetry } = await import('../src/jobs/settlementRetry.js')
const { runWithdrawals } = await import('../src/jobs/withdrawals.js')
const { runAutoAccept, runTimeoutReminders } = await import('../src/jobs/taskTimeout.js')
const { runDailyRecon } = await import('../src/jobs/dailyRecon.js')
const { runHousekeeping } = await import('../src/jobs/housekeeping.js')

// 种子超级管理员
const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', '13800000001', ?, '平台运营', ?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log(`  ✓ ${name}`)
}

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text()
  return { status: res.status, data }
}

async function uploadFile(token, name, content, mime = 'text/plain') {
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: mime }), name)
  const res = await fetch(BASE + '/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd
  })
  return { status: res.status, data: await res.json() }
}

const PW = 'Test@123456'

try {
  console.log('— 认证与密码策略 —')
  let r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000001', password: 'short1A', name: '弱密码', agree: true } })
  ok('弱密码注册被拒（400）', r.status === 400)
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000001', password: 'abcdefghijk', name: '无数字', agree: true } })
  ok('纯字母密码被拒（400）', r.status === 400)
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000005', password: PW, name: '������ϵ��', agree: true } })
  ok('疑似乱码姓名注册被拒（400）', r.status === 400 && r.data.error.message.includes('疑似乱码'))
  r = await api('POST', '/auth/register', {
    body: { role: 'company', phone: '13900000006', password: PW, name: '赵经理', companyName: '���Թ���Ƽ����޹�˾', licenseNo: '91330106MA2BADCODE', industry: '软件信息服务', agree: true }
  })
  ok('疑似乱码企业名称注册被拒（400）', r.status === 400 && r.data.error.message.includes('疑似乱码'))

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000001', password: PW, name: '李师傅', agree: true } })
  ok('零工注册', r.status === 201 && r.data.token)
  let workerToken = r.data.token
  const workerId = r.data.user.id

  r = await api('POST', '/auth/register', {
    body: { role: 'company', phone: '13900000002', password: PW, name: '王经理', companyName: '杭州某电商科技有限公司', licenseNo: '91330106MA2XXXXX0K', industry: '软件信息服务', agree: true }
  })
  ok('企业注册（待审核）', r.status === 201)
  const companyToken = r.data.token

  r = await api('POST', '/auth/register', {
    body: { role: 'company', phone: '13900000003', password: PW, name: '张老板', companyName: '某建筑劳务有限公司', licenseNo: '91110000XXXXXXXX01', industry: '建筑劳务分包', agree: true }
  })
  ok('负面清单行业企业注册', r.status === 201)

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000001', password: PW, name: '重复', agree: true } })
  ok('重复手机号被拒（409）', r.status === 409)

  r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  ok('管理员登录', r.status === 200)
  const adminToken = r.data.token

  r = await api('GET', '/auth/me', { token: adminToken })
  ok('管理员 me 含全量权限', r.data.permissions?.includes('*') && r.data.roleName === '超级管理员')

  r = await api('GET', '/auth/me', { token: companyToken })
  ok('企业 me 含成员角色 owner', r.data.memberRole === 'owner')

  r = await api('GET', '/admin/dashboard', { token: workerToken })
  ok('角色越权被拒（403）', r.status === 403)

  console.log('— 修改密码 —')
  r = await api('POST', '/auth/change-password', { token: workerToken, body: { oldPassword: 'wrong', newPassword: 'NewPass12345' } })
  ok('原密码错误被拒（400）', r.status === 400)
  r = await api('POST', '/auth/change-password', { token: workerToken, body: { oldPassword: PW, newPassword: 'weak' } })
  ok('新密码过弱被拒（400）', r.status === 400)
  r = await api('POST', '/auth/change-password', { token: workerToken, body: { oldPassword: PW, newPassword: 'NewPass12345' } })
  ok('修改密码成功', r.status === 200)
  r = await api('POST', '/auth/login', { body: { phone: '13900000001', password: 'NewPass12345' } })
  ok('新密码可登录', r.status === 200)
  workerToken = r.data.token

  console.log('— 登录防爆破 —')
  await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000099', password: PW, name: '锁定测试', agree: true } })
  for (let i = 0; i < 5; i++) {
    await api('POST', '/auth/login', { body: { phone: '13900000099', password: 'WrongPass99' } })
  }
  r = await api('POST', '/auth/login', { body: { phone: '13900000099', password: PW } })
  ok('连续失败后正确密码也被锁定（423）', r.status === 423)

  console.log('— 企业准入 —')
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '测试', category: '设计', payMethod: '按成果', price: 100, deadline: '2099-07-01', description: '测试描述内容' } })
  ok('未准入企业发单被拒（403）', r.status === 403)

  r = await api('GET', '/admin/companies', { token: adminToken })
  ok('行业负面清单自动标高风险', r.data.list.find(c => c.industry === '建筑劳务分包').riskLevel === '高')
  const goodCompanyId = r.data.list.find(c => c.industry === '软件信息服务').id
  const badCompanyId = r.data.list.find(c => c.industry === '建筑劳务分包').id

  r = await api('POST', `/admin/companies/${goodCompanyId}/review`, { token: adminToken, body: { pass: true, note: '资质齐全' } })
  ok('准入通过并签署总承揽合同', r.status === 200 && r.data.masterContractNo?.startsWith('ZCL'))
  r = await api('POST', `/admin/companies/${badCompanyId}/review`, { token: adminToken, body: { pass: false, note: '命中行业负面清单' } })
  ok('高风险企业拒绝准入', r.status === 200 && r.data.status === 'rejected')

  r = await api('GET', '/me/notifications', { token: companyToken })
  ok('企业收到审核通过通知', r.data.unread > 0 && r.data.list.some(n => n.type === 'review'))

  console.log('— 资金与发单 —')
  r = await api('POST', '/company/recharge', { token: companyToken, body: { amount: 200000 } })
  ok('存管户充值', r.status === 200 && r.data.balance === 200000)

  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '客服月薪结算', category: '其他', payMethod: '按成果', price: 5000, deadline: '2099-07-01', description: '每日打卡上班' } })
  ok('违禁词（打卡/月薪）发单被阻断', r.status === 400)
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '正常任务', category: '设计', payMethod: '按月计酬', price: 5000, deadline: '2099-07-01', description: '正常的设计任务描述' } })
  ok('非法计酬方式被阻断', r.status === 400)
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '超额任务', category: '设计', payMethod: '按成果', price: 999999, deadline: '2099-07-01', description: '超出余额的任务' } })
  ok('可用余额不足被阻断', r.status === 400)
  r = await api('GET', '/admin/risk/alerts', { token: adminToken })
  ok('违禁词发单产生风控预警', r.data.list.some(a => a.type === '伪劳务特征'))

  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '品牌视觉设计（大单）', category: '设计', payMethod: '按成果', price: 50000, deadline: '2099-07-10', description: '品牌全套视觉设计,交付源文件', standard: '通过验收后结算' } })
  ok('正常发单成功并生成任务工单', r.status === 201 && r.data.workOrderNo.startsWith('GD'))
  const taskId = r.data.id

  r = await api('GET', '/company/profile', { token: companyToken })
  ok('发单后资金冻结 5万', r.data.account.frozen === 50000 && r.data.account.available === 150000)

  console.log('— 任务取消与资金解冻 —')
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '将被取消的任务', category: '文案', payMethod: '按件', price: 3000, deadline: '2099-07-05', description: '用于验证取消解冻流程' } })
  const cancelTaskId = r.data.id
  r = await api('GET', '/company/profile', { token: companyToken })
  ok('取消前冻结 5.3万', r.data.account.frozen === 53000)
  r = await api('POST', `/company/tasks/${cancelTaskId}/cancel`, { token: companyToken })
  ok('取消任务成功并解冻', r.status === 200 && r.data.unfrozen === 3000)
  r = await api('GET', '/company/profile', { token: companyToken })
  ok('取消后冻结回到 5万', r.data.account.frozen === 50000)
  r = await api('POST', `/company/tasks/${cancelTaskId}/cancel`, { token: companyToken })
  ok('重复取消被拒（409）', r.status === 409)

  console.log('— 零工实名与接单 —')
  r = await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  ok('未实名报名被拒（400）', r.status === 400)
  r = await api('POST', '/worker/verify', { token: workerToken, body: { idCard: '330106199001011235', realName: '�����㹤', bankCard: '6217000000006217' } })
  ok('疑似乱码实名信息被拒（400）', r.status === 400 && r.data.error.message.includes('疑似乱码'))
  r = await api('POST', '/worker/verify', { token: workerToken, body: { idCard: '330106199001011235', realName: '李建国', bankCard: '6217000000006217' } })
  ok('实名认证并签署分包协议', r.status === 200 && r.data.frameContractNo.startsWith('FBK'))

  r = await api('GET', '/worker/tasks', { token: workerToken })
  ok('任务大厅可见发布的任务', r.data.list.some(t => t.id === taskId))
  r = await api('GET', `/worker/tasks/${taskId}`, { token: workerToken })
  ok('任务详情含收入预估', r.data.estimate && r.data.estimate.net > 0)

  r = await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  ok('报名成功', r.status === 201)
  r = await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  ok('重复报名被拒（409）', r.status === 409)
  r = await api('POST', `/worker/tasks/${taskId}/withdraw-apply`, { token: workerToken })
  ok('取消报名成功', r.status === 200)
  r = await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  ok('取消后可重新报名', r.status === 201)

  // 过期任务
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '已过期任务', category: '设计', payMethod: '按成果', price: 1000, deadline: '2020-01-01', description: '过期任务报名测试' } })
  const expiredTaskId = r.data.id
  r = await api('POST', `/worker/tasks/${expiredTaskId}/apply`, { token: workerToken })
  ok('过期任务报名被拒（409）', r.status === 409)
  await api('POST', `/company/tasks/${expiredTaskId}/cancel`, { token: companyToken })

  console.log('— 录用、四流校验与结算 —')
  r = await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken })
  ok('无分包工单不可结算（四流校验）', r.status === 400 && r.data.error.code === 'NO_WORK_ORDER')
  r = await api('POST', `/company/tasks/${taskId}/hire`, { token: companyToken, body: { workerId } })
  ok('录用：生成分包工单+按单保单', r.data.workOrderNo.startsWith('FB') && r.data.policyNo.startsWith('INS'))

  r = await api('GET', '/me/notifications', { token: workerToken })
  ok('零工收到录用通知', r.data.list.some(n => n.type === 'hired'))

  r = await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken })
  ok('无交付物不可验收（四流校验）', r.status === 400 && r.data.error.code === 'NO_DELIVERABLE')

  // 交付（带附件）
  const up = await uploadFile(workerToken, '设计稿.txt', '设计稿全套内容', 'text/plain')
  ok('上传交付附件成功', up.status === 201 && up.data.id)
  r = await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '设计稿全套+源文件链接', attachmentIds: [up.data.id] } })
  ok('零工上传交付物', r.status === 200)

  r = await api('GET', `/company/tasks/${taskId}`, { token: companyToken })
  ok('企业端可见交付附件', r.data.attachments.length === 1 && r.data.attachments[0].url.includes('/files/'))

  const fileRes = await fetch(BASE + r.data.attachments[0].url.replace('/api/v1', ''), { headers: { authorization: `Bearer ${companyToken}` } })
  ok('附件可鉴权下载', fileRes.status === 200 && (await fileRes.text()) === '设计稿全套内容')

  r = await api('POST', `/company/tasks/${taskId}/reject`, { token: companyToken, body: { reason: '主视觉需调整' } })
  ok('企业驳回交付（成果不合格不计酬）', r.status === 200 && r.data.status === 'working')
  r = await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '修改后第二版全套源文件' } })
  ok('零工重新交付', r.status === 200)

  r = await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken })
  ok('验收结算成功', r.status === 200 && r.data.confirmNo.startsWith('QR'))
  ok('累计预扣个税精确（¥954）', r.data.settlement.tax === 954)
  ok('月销售额低于10万免增值税', r.data.settlement.vat === 0)
  ok('实发 = 分包价 - 税', r.data.settlement.workerNet === 46000 - 954)
  ok('平台服务费 = 8%', r.data.settlement.platformFee === 4000)
  ok('全额开具6%发票', r.data.invoice.amount === 50000 && r.data.invoice.taxRate === '6%')
  r = await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken })
  ok('重复结算被拒（409）', r.status === 409)

  r = await api('GET', '/me/notifications', { token: workerToken })
  ok('零工收到结算到账通知', r.data.list.some(n => n.type === 'settle'))

  console.log('— 资金与税务核对 —')
  r = await api('GET', '/company/profile', { token: companyToken })
  ok('企业账户：余额15万、冻结归零', r.data.account.balance === 150000 && r.data.account.frozen === 0)
  r = await api('GET', '/worker/income', { token: workerToken })
  ok('零工到账 ¥45046', r.data.account.balance === 45046)
  ok('税务摘要正确', r.data.taxSummary.yearTax === 954 && r.data.taxSummary.vatFree === true)
  // 连续性劳务（16号公告）：连续接单月份与累计减除费用
  ok('连续接单月份数随结算累计', r.data.taxSummary.consecutiveMonths >= 1)
  ok('累计减除费用=5000×连续月份', r.data.taxSummary.cumulativeDeduction === r.data.taxSummary.consecutiveMonths * 5000)
  ok('税务说明含连续性劳务口径', /累计预扣/.test(r.data.taxSummary.taxNote))
  r = await api('GET', '/worker/tax/voucher?year=2026', { token: workerToken })
  ok('年度凭证标注劳务报酬+累计预扣法', r.data.incomeItem === '劳务报酬所得' && r.data.taxMethod === '累计预扣法')
  ok('凭证明细标注连续性劳务', r.data.items.some(i => i.incomeType.includes('连续性劳务')))
  r = await api('POST', '/worker/withdraw', { token: workerToken, body: { amount: 99999999 } })
  ok('超额提现被拒（400）', r.status === 400)

  // 提现状态机：申请冻结 → Job 出金 → 到账
  r = await api('POST', '/worker/withdraw', { token: workerToken, body: { amount: 10000 } })
  ok('提现申请创建并冻结', r.status === 201 && r.data.status === 'applied' && r.data.balance === 35046)
  r = await api('GET', '/worker/profile', { token: workerToken })
  ok('申请后可用余额减少、冻结增加', r.data.account.balance === 35046 && r.data.account.frozen === 10000)
  let jr = await runWithdrawals()
  ok('提现 Job 出金成功', jr.done === 1 && jr.failed === 0)
  r = await api('GET', '/worker/withdrawals', { token: workerToken })
  ok('提现单已到账（done）', r.data.list[0].status === 'done' && r.data.list[0].amount === 10000)
  r = await api('GET', '/worker/profile', { token: workerToken })
  ok('到账后余额实扣、冻结归零', r.data.account.balance === 35046 && r.data.account.frozen === 0)

  // 提现失败：银行通道异常 → 解冻退回
  await api('POST', '/worker/withdraw', { token: workerToken, body: { amount: 5000 } })
  _testHooks.failNext.escrow = 1
  jr = await runWithdrawals()
  ok('银行异常时提现失败', jr.failed === 1)
  r = await api('GET', '/worker/withdrawals', { token: workerToken })
  ok('失败单据留痕', r.data.list[0].status === 'failed' && r.data.list[0].failReason)
  r = await api('GET', '/worker/profile', { token: workerToken })
  ok('失败后金额解冻退回', r.data.account.balance === 35046 && r.data.account.frozen === 0)
  r = await api('GET', '/me/notifications', { token: workerToken })
  ok('提现到账与失败均有通知', r.data.list.filter(n => n.title.includes('提现')).length >= 2)

  console.log('— 第二单：累进税率与增值税 —')
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '全案视觉升级（特大单）', category: '设计', payMethod: '按成果', price: 80000, deadline: '2099-07-20', description: '品牌全案升级设计项目' } })
  const task2 = r.data.id
  await api('POST', `/worker/tasks/${task2}/apply`, { token: workerToken })
  await api('POST', `/company/tasks/${task2}/hire`, { token: companyToken, body: { workerId } })
  await api('POST', `/worker/orders/${task2}/deliver`, { token: workerToken, body: { note: '全案交付包' } })
  r = await api('POST', `/company/tasks/${task2}/accept`, { token: companyToken })
  ok('第二单累计预扣跳档（¥5594）', r.data.settlement.tax === 5594)
  ok('超10万部分代办增值税（¥196）', r.data.settlement.vat === 196)

  r = await api('GET', '/admin/risk/alerts', { token: adminToken })
  ok('集中度100%触发高风险预警', r.data.list.some(a => a.type === '集中度超标' && a.status === 'open'))
  ok('月收入超10万触发个体户引导', r.data.list.some(a => a.type === '个体户引导'))

  console.log('— 通知中心 —')
  r = await api('GET', '/me/notifications', { token: workerToken })
  const unreadBefore = r.data.unread
  ok('通知未读数 > 0', unreadBefore > 0)
  r = await api('POST', '/me/notifications/read', { token: workerToken, body: { ids: 'all' } })
  ok('全部标记已读', r.status === 200)
  r = await api('GET', '/me/notifications', { token: workerToken })
  ok('已读后未读数归零', r.data.unread === 0)

  console.log('— 用户设置 —')
  r = await api('PATCH', '/me/settings', { token: workerToken, body: { theme: 'dark' } })
  ok('保存主题偏好', r.status === 200 && r.data.theme === 'dark')
  r = await api('GET', '/me/settings', { token: workerToken })
  ok('读取主题偏好', r.data.theme === 'dark')

  console.log('— 企业成员与权限 —')
  r = await api('POST', '/company/members', { token: companyToken, body: { phone: '13700000088', name: '小财务', memberRole: 'finance' } })
  ok('owner 创建财务成员', r.status === 201 && r.data.tempPassword)
  const finLogin = await api('POST', '/auth/login', { body: { phone: '13700000088', password: r.data.tempPassword } })
  const financeToken = finLogin.data.token
  ok('财务成员可登录', finLogin.status === 200)
  r = await api('GET', '/company/profile', { token: financeToken })
  ok('财务成员可查看企业档案', r.status === 200 && r.data.memberRole === 'finance')
  r = await api('POST', '/company/tasks', { token: financeToken, body: { title: '财务试图发单', category: '设计', payMethod: '按成果', price: 100, deadline: '2099-08-01', description: '财务不应有发单权限' } })
  ok('财务成员发单被拒（403）', r.status === 403)
  r = await api('POST', '/company/recharge', { token: financeToken, body: { amount: 1000 } })
  ok('财务成员可充值', r.status === 200)
  r = await api('POST', '/company/members', { token: financeToken, body: { phone: '13700000089', name: '越权建号', memberRole: 'operator' } })
  ok('非 owner 管理成员被拒（403）', r.status === 403)

  console.log('— 运营端 RBAC —')
  r = await api('GET', '/admin/roles', { token: adminToken })
  ok('预置6个角色（含客服）', r.data.list.length === 6 && r.data.list.some(x => x.name === '客服'))
  const reviewerRole = r.data.list.find(x => x.name === '审核专员')
  r = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13800000002', name: '审核小王', roleId: reviewerRole.id } })
  ok('创建审核专员账号', r.status === 201)
  const revLogin = await api('POST', '/auth/login', { body: { phone: '13800000002', password: r.data.tempPassword } })
  const reviewerToken = revLogin.data.token
  r = await api('GET', '/auth/me', { token: reviewerToken })
  ok('审核专员权限正确返回', r.data.roleName === '审核专员' && r.data.permissions.includes('company:review') && !r.data.permissions.includes('*'))
  r = await api('GET', '/admin/companies', { token: reviewerToken })
  ok('审核专员可查企业', r.status === 200)
  r = await api('POST', '/admin/tax/declare', { token: reviewerToken, body: { period: '2030-01' } })
  ok('审核专员调税务申报被拒（403）', r.status === 403)
  r = await api('GET', '/admin/configs', { token: reviewerToken })
  ok('审核专员读配置被拒（403）', r.status === 403)

  console.log('— B线个体户与发票硬校验 —')
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000004', password: PW, name: '周个体', agree: true } })
  const w2Token = r.data.token, w2Id = r.data.user.id
  await api('POST', '/worker/verify', { token: w2Token, body: { idCard: '330106199503033457', realName: '周个体', bankCard: '6228000000001111' } })
  r = await api('POST', '/worker/soletrader', { token: w2Token, body: { licenseNo: '92330106MA2K1234X1' } })
  ok('个体户登记转入B线', r.status === 200 && r.data.subjectType === 'soletrader')

  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '仓储系统接口开发', category: '技术', payMethod: '按成果', price: 20000, deadline: '2099-07-30', description: '对接WMS系统的接口开发与联调' } })
  const task3 = r.data.id
  await api('POST', `/worker/tasks/${task3}/apply`, { token: w2Token })
  await api('POST', `/company/tasks/${task3}/hire`, { token: companyToken, body: { workerId: w2Id } })
  await api('POST', `/worker/orders/${task3}/deliver`, { token: w2Token, body: { note: '接口代码+联调记录' } })

  r = await api('POST', `/company/tasks/${task3}/accept`, { token: companyToken })
  ok('B线未上传发票结算被阻断（四流发票流）', r.status === 400 && r.data.error.code === 'NO_INPUT_INVOICE')

  const invUp = await uploadFile(w2Token, '发票.pdf', '%PDF-1.4 fake invoice', 'application/pdf')
  r = await api('POST', `/worker/orders/${task3}/invoice`, { token: w2Token, body: { uploadId: invUp.data.id } })
  ok('B线上传进项发票', r.status === 201)
  r = await api('POST', `/company/tasks/${task3}/accept`, { token: companyToken })
  ok('B线结算不代扣个税/增值税', r.data.settlement.tax === 0 && r.data.settlement.vat === 0)
  ok('B线实发 = 分包价（¥18400）', r.data.settlement.workerNet === 18400)

  console.log('— 配置在线联动 —')
  r = await api('PATCH', '/admin/configs/platformMarginRate', { token: adminToken, body: { value: 0.1 } })
  ok('修改平台毛利率为10%', r.status === 200 && r.data.value === 0.1)
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '配置联动验证单', category: '技术', payMethod: '按成果', price: 10000, deadline: '2099-08-30', description: '验证毛利率配置实时生效' } })
  const task4 = r.data.id
  await api('POST', `/worker/tasks/${task4}/apply`, { token: w2Token })
  await api('POST', `/company/tasks/${task4}/hire`, { token: companyToken, body: { workerId: w2Id } })
  await api('POST', `/worker/orders/${task4}/deliver`, { token: w2Token, body: { note: '交付' } })
  const invUp2 = await uploadFile(w2Token, '发票2.pdf', '%PDF-1.4 fake invoice 2', 'application/pdf')
  await api('POST', `/worker/orders/${task4}/invoice`, { token: w2Token, body: { uploadId: invUp2.data.id } })
  r = await api('POST', `/company/tasks/${task4}/accept`, { token: companyToken })
  ok('新毛利率实时生效（服务费=10%）', r.data.settlement.platformFee === 1000 && r.data.settlement.workerNet === 9000)
  r = await api('PATCH', '/admin/configs/platformMarginRate', { token: adminToken, body: { value: '不是数字' } })
  ok('配置类型不匹配被拒（400）', r.status === 400)

  console.log('— IDOR 越权防护 —')
  r = await api('POST', `/worker/orders/${taskId}/deliver`, { token: w2Token, body: { note: '越权交付他人工单' } })
  ok('零工操作他人工单被拒（404）', r.status === 404)

  console.log('— 用户禁用 —')
  r = await api('POST', `/admin/users/${w2Id}/disable`, { token: adminToken })
  ok('运营禁用零工账号', r.status === 200)
  r = await api('GET', '/worker/profile', { token: w2Token })
  ok('禁用后调用被拒（403）', r.status === 403)
  r = await api('POST', '/auth/login', { body: { phone: '13900000004', password: PW } })
  ok('禁用后登录被拒（423）', r.status === 423)
  r = await api('POST', `/admin/users/${w2Id}/enable`, { token: adminToken })
  ok('恢复账号', r.status === 200)
  r = await api('GET', '/worker/profile', { token: w2Token })
  ok('恢复后正常访问', r.status === 200)

  console.log('— 运营端 —')
  r = await api('GET', '/admin/dashboard', { token: adminToken })
  ok('看板数据正确', r.data.totals.settledAmount === 160000 && r.data.openAlerts > 0)
  r = await api('GET', '/admin/stats/trend', { token: adminToken })
  ok('统计趋势接口', r.status === 200 && r.data.trend.length > 0 && r.data.statusDist.length > 0)

  r = await api('GET', '/admin/archives', { token: adminToken })
  const arch = r.data.list.find(a => a.taskId === taskId)
  ok('四流证据链完整', arch.flows.contract.length === 4 && arch.flows.business.confirmNo && arch.flows.fund.length >= 4 && arch.flows.invoice.no && arch.evidenceHash.startsWith('sha256:'))

  const alertId = (await api('GET', '/admin/risk/alerts', { token: adminToken })).data.list.find(a => a.status === 'open').id
  r = await api('POST', `/admin/risk/alerts/${alertId}/resolve`, { token: adminToken, body: { note: '已电话回访确认真实' } })
  ok('风控预警处理', r.status === 200)

  const period = new Date().toISOString().slice(0, 7)
  r = await api('POST', '/admin/tax/declare', { token: adminToken, body: { period } })
  ok('当期税款批量申报', r.status === 200 && r.data.receiptNo.startsWith('TX'))
  r = await api('POST', '/admin/tax/declare', { token: adminToken, body: { period } })
  ok('重复申报被拒（409）', r.status === 409)

  const quarter = `${new Date().getFullYear()}Q${Math.ceil((new Date().getMonth() + 1) / 3)}`
  r = await api('POST', '/admin/tax/quarter-report', { token: adminToken, body: { period: quarter } })
  ok('季度涉税信息报送', r.status === 200 && r.data.workers === 2)

  r = await api('GET', '/admin/integrations', { token: adminToken })
  ok('外部接口7项全部在线（含短信）', r.data.length === 7 && r.data.every(s => s.status === 'up'))

  console.log('— 结算悬挂治理（两阶段+重试） —')
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '通道异常演练单', category: '设计', payMethod: '按成果', price: 6000, deadline: '2099-09-30', description: '验证银行通道异常时的两阶段结算与自动重试' } })
  const task5 = r.data.id
  await api('POST', `/worker/tasks/${task5}/apply`, { token: workerToken })
  await api('POST', `/company/tasks/${task5}/hire`, { token: companyToken, body: { workerId } })
  await api('POST', `/worker/orders/${task5}/deliver`, { token: workerToken, body: { note: '交付内容' } })

  _testHooks.failNext.escrow = 2 // 前两腿分账失败
  r = await api('POST', `/company/tasks/${task5}/accept`, { token: companyToken })
  ok('通道异常时返回 502 已受理', r.status === 502 && r.data.error.code === 'SETTLE_PENDING')
  r = await api('GET', '/admin/settlements?status=pending', { token: adminToken })
  ok('结算单据停留 pending', r.data.list.some(s => s.taskId === task5 && s.attempts === 1))
  r = await api('POST', `/company/tasks/${task5}/accept`, { token: companyToken })
  ok('结算中重复验收被拒（409）', r.status === 409 && r.data.error.code === 'SETTLING')

  jr = await runSettlementRetry()
  ok('第一次重试仍失败（通道未恢复）', jr.failed === 1)
  r = await api('GET', '/admin/settlements?status=pending', { token: adminToken })
  ok('失败次数累计为2', r.data.list.find(s => s.taskId === task5)?.attempts === 2)

  jr = await runSettlementRetry()
  ok('通道恢复后重试补齐并完成', jr.done === 1)
  r = await api('GET', '/admin/settlements?status=done', { token: adminToken })
  const s5 = r.data.list.find(s => s.taskId === task5)
  ok('单据完成且四腿齐全', s5 && s5.legsDone.length === 4)
  r = await api('GET', '/company/tasks/' + task5, { token: companyToken })
  ok('任务最终结算成功', r.data.status === 'settled')

  console.log('— 任务超时治理 —')
  // 构造超期交付：发单→录用→交付,然后把 delivered_at 改老
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '超期未验收演练单', category: '文案', payMethod: '按件', price: 2000, deadline: '2099-10-31', description: '验证超期自动验收兜底机制' } })
  const task6 = r.data.id
  await api('POST', `/worker/tasks/${task6}/apply`, { token: workerToken })
  await api('POST', `/company/tasks/${task6}/hire`, { token: companyToken, body: { workerId } })
  await api('POST', `/worker/orders/${task6}/deliver`, { token: workerToken, body: { note: '交付物' } })

  db.prepare(`UPDATE tasks SET delivered_at = datetime('now','localtime','-7 days') WHERE id = ?`).run(task6)
  jr = runTimeoutReminders()
  ok('第7天触发验收提醒', jr.reminders >= 1)
  r = await api('GET', '/me/notifications', { token: companyToken })
  ok('企业收到验收提醒通知', r.data.list.some(n => n.title === '验收提醒'))

  db.prepare(`UPDATE tasks SET delivered_at = datetime('now','localtime','-15 days') WHERE id = ?`).run(task6)
  jr = await runAutoAccept()
  ok('超14天自动验收结算', jr.settled === 1)
  r = await api('GET', '/company/tasks/' + task6, { token: companyToken })
  ok('超期任务已自动结算', r.data.status === 'settled')
  r = await api('GET', '/me/notifications', { token: companyToken })
  ok('企业收到自动验收告知', r.data.list.some(n => n.title === '任务已超期自动验收'))

  console.log('— T+1 按日对账 —')
  const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
  jr = runDailyRecon(todayStr)
  ok('当日对账平衡', jr.status === 'balanced' && jr.diff === 0)
  r = await api('GET', '/admin/reconciliation', { token: adminToken })
  ok('对账接口含按日明细', r.data.daily.length >= 1 && r.data.daily[0].day === todayStr && r.data.mismatchDays.length === 0)

  console.log('— 文件归属鉴权与数据治理 —')
  const aliceFile = await uploadFile(workerToken, '私密文件.txt', '仅本人与相关方可见')
  const fr1 = await fetch(BASE + `/files/${aliceFile.data.id}`, { headers: { authorization: `Bearer ${w2Token}` } })
  ok('无关用户下载他人文件被拒（403）', fr1.status === 403)
  const fr2 = await fetch(BASE + `/files/${aliceFile.data.id}`, { headers: { authorization: `Bearer ${workerToken}` } })
  ok('上传者本人可下载', fr2.status === 200)

  db.prepare(`UPDATE uploads SET created_at = datetime('now','localtime','-8 days') WHERE id = ?`).run(aliceFile.data.id)
  jr = runHousekeeping()
  ok('孤儿文件被清理', jr.orphansDeleted >= 1)
  const fr3 = await fetch(BASE + `/files/${aliceFile.data.id}`, { headers: { authorization: `Bearer ${workerToken}` } })
  ok('清理后文件不存在（404）', fr3.status === 404)

  r = await api('GET', '/admin/reconciliation', { token: adminToken })
  ok('银行存管自动对账平衡', r.data.balanced === true && r.data.diff === 0)

  r = await api('GET', '/admin/flows/export', { token: adminToken })
  ok('资金流水 CSV 导出', r.status === 200 && String(r.data).includes('流水ID'))
  r = await api('GET', '/admin/workers/export', { token: adminToken })
  ok('零工名册 CSV 导出', r.status === 200 && String(r.data).includes('姓名'))
  r = await api('GET', `/admin/tax/export?period=${period}`, { token: adminToken })
  ok('税务明细 CSV 导出', r.status === 200 && String(r.data).includes('完税凭证号'))

  r = await api('GET', '/admin/audit-logs', { token: adminToken })
  ok('审计日志可分页查询', r.data.total > 10)
  r = await api('GET', '/admin/audit-logs?action=config_update', { token: adminToken })
  ok('审计覆盖配置变更', r.data.total >= 1)
  r = await api('GET', '/admin/audit-logs?action=task_cancel', { token: adminToken })
  ok('审计覆盖任务取消', r.data.total >= 1)

  // 累计口径：50000单954 + 80000单5594 + 演练单5400→432 + 演练单1800→144 = 7124
  r = await api('GET', '/worker/tax/voucher?year=' + new Date().getFullYear(), { token: workerToken })
  ok('年度扣缴凭证汇总正确（含演练单累计预扣）', r.data.totalTax === 7124)

  console.log('— JWT 刷新与登出 —')
  r = await api('POST', '/auth/login', { body: { phone: '13900000001', password: 'NewPass12345' } })
  ok('登录返回刷新令牌', r.status === 200 && r.data.refreshToken?.length === 64)
  const rt1 = r.data.refreshToken
  r = await api('POST', '/auth/refresh', { body: { refreshToken: rt1 } })
  ok('刷新成功并轮换令牌', r.status === 200 && r.data.token && r.data.refreshToken !== rt1)
  const rt2 = r.data.refreshToken
  r = await api('POST', '/auth/refresh', { body: { refreshToken: rt1 } })
  ok('旧刷新令牌已吊销（401）', r.status === 401)
  r = await api('POST', '/auth/logout', { token: workerToken })
  ok('登出成功', r.status === 200)
  r = await api('POST', '/auth/refresh', { body: { refreshToken: rt2 } })
  ok('登出后全部刷新令牌失效（401）', r.status === 401)

  console.log('— 微信登录 —')
  r = await api('POST', '/auth/wechat', { body: { code: 'mock-code-abc123' } })
  ok('未绑定微信提示注册（404 NEED_BIND）', r.status === 404 && r.data.error.code === 'NEED_BIND')
  r = await api('POST', '/auth/wechat', { body: { code: 'mock-code-garbled', phone: '13900000078', name: '�����㹤', agree: true } })
  ok('微信首登疑似乱码姓名被拒（400）', r.status === 400 && r.data.error.message.includes('疑似乱码'))
  r = await api('POST', '/auth/wechat', { body: { code: 'mock-code-abc123', phone: '13900000077', name: '微信用户', agree: true } })
  ok('微信首登注册并发放会话', r.status === 200 && r.data.token && r.data.user.role === 'worker')
  r = await api('POST', '/auth/wechat', { body: { code: 'mock-code-abc123' } })
  ok('同一微信再次免密登录', r.status === 200 && r.data.user.phone === '13900000077')

  console.log('— R2 运营完整性 —')
  r = await api('GET', '/company/meta', { token: companyToken })
  ok('发布元数据动态读配置', r.data.categories.includes('设计') && r.data.payMethods.includes('按成果'))

  const finUserId = (await api('GET', '/company/members', { token: companyToken })).data.list.find(m => m.memberRole === 'finance').userId
  r = await api('PATCH', `/company/members/${finUserId}`, { token: companyToken, body: { memberRole: 'operator' } })
  ok('owner 修改成员角色', r.status === 200 && r.data.memberRole === 'operator')
  r = await api('PATCH', `/company/members/${finUserId}`, { token: financeToken, body: { memberRole: 'finance' } })
  ok('非 owner 改角色被拒（403）', r.status === 403)

  r = await api('GET', `/admin/companies/${goodCompanyId}/detail`, { token: adminToken })
  ok('企业全貌：任务统计+成员+流水', r.data.taskStats.length > 0 && r.data.members.length >= 2 && r.data.recentFlows.length > 0)
  r = await api('GET', `/admin/workers/${workerId}/detail`, { token: adminToken })
  ok('零工全貌：接单+收入+合同+预警', r.data.orderStats.length > 0 && r.data.recentIncome.length > 0 && r.data.alerts.length > 0)

  r = await api('GET', '/admin/risk/alerts', { token: adminToken })
  ok('风控预警带涉事对象引用', r.data.list.some(a => a.refType === 'worker' && a.refId === workerId))

  r = await api('GET', `/admin/companies/${goodCompanyId}/evidence-pack`, { token: adminToken })
  ok('业务真实性证明包（四要素齐备）', r.data.realnameVerifications.length > 0 && r.data.transactions.every(t => t.confirmNo) && r.data.payments.length > 0)

  console.log('— R3 任务发现与收入汇总 —')
  r = await api('GET', '/worker/tasks?sort=price_desc', { token: w2Token })
  const prices = r.data.list.map(t => t.price)
  ok('按报酬降序排序', prices.every((p, i) => i === 0 || p <= prices[i - 1]))
  r = await api('GET', '/worker/tasks?minPrice=5000', { token: w2Token })
  ok('价格区间筛选', r.data.list.every(t => t.price >= 5000))
  r = await api('GET', '/worker/income/monthly', { token: w2Token })
  ok('月度收入汇总', r.data.list.length >= 1 && r.data.list[0].orders >= 1)

  console.log('— 注册协议与留痕 —')
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000055', password: PW, name: '未同意' } })
  ok('未勾选协议注册被拒（400）', r.status === 400)
  r = await api('GET', '/auth/legal/tos')
  ok('服务协议公开可读', r.status === 200 && r.data.content.includes('承揽后分包'))
  r = await api('GET', '/auth/legal/privacy')
  ok('隐私政策公开可读', r.status === 200 && r.data.version >= 1)
  const agreeRows = db.prepare(`SELECT COUNT(*) AS n FROM agreements WHERE user_id = ?`).get(workerId).n
  ok('注册协议同意已留痕（含版本）', agreeRows === 2)

  console.log('— 全节点合同正文 —')
  r = await api('GET', '/company/contracts', { token: companyToken })
  ok('企业合同均有正文快照', r.data.list.length >= 4 && r.data.list.every(x => x.hasContent))
  const masterC = r.data.list.find(x => x.type === 'master')
  r = await api('GET', `/company/contracts/${masterC.id}`, { token: companyToken })
  ok('总承揽合同正文已渲染甲方与编号', r.data.content.includes('杭州某电商科技有限公司') && r.data.content.includes(masterC.no))
  r = await api('GET', '/worker/contracts', { token: workerToken })
  ok('零工可见框架协议与分包工单', r.data.list.some(x => x.type === 'frame_sub') && r.data.list.some(x => x.type === 'sub_order'))
  const subC = r.data.list.find(x => x.type === 'sub_order')
  r = await api('GET', `/worker/contracts/${subC.id}`, { token: workerToken })
  ok('分包工单正文含承揽条款', r.data.content.includes('成果不合格不计酬'))
  r = await api('GET', `/worker/contracts/${masterC.id}`, { token: workerToken })
  ok('零工不能读他人合同（404）', r.status === 404)

  console.log('— 自定义角色管理 —')
  r = await api('GET', '/admin/permissions', { token: adminToken })
  ok('权限点清单（28项含中文名）', r.data.list.length === 28 && r.data.list.every(p => p.label))
  r = await api('POST', '/admin/roles', { token: adminToken, body: { name: '客服专员', permissions: ['dashboard:read', 'worker:read', 'risk:read'] } })
  ok('创建自定义角色', r.status === 201)
  const customRoleId = r.data.id
  r = await api('POST', '/admin/roles', { token: adminToken, body: { name: '��ʱ���Խ�ɫ', permissions: ['dashboard:read'] } })
  ok('疑似乱码角色名被拒（400）', r.status === 400 && r.data.error.message.includes('疑似乱码'))
  r = await api('POST', '/admin/roles', { token: adminToken, body: { name: '坏角色', permissions: ['hack:all'] } })
  ok('未知权限点被拒（400）', r.status === 400)
  r = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13800000003', name: '客服小李', roleId: customRoleId } })
  const csLogin = await api('POST', '/auth/login', { body: { phone: '13800000003', password: r.data.tempPassword } })
  r = await api('GET', '/admin/workers', { token: csLogin.data.token })
  ok('自定义角色权限生效（可读零工）', r.status === 200)
  r = await api('GET', '/admin/configs', { token: csLogin.data.token })
  ok('自定义角色越权被拒（403）', r.status === 403)
  r = await api('DELETE', `/admin/roles/${customRoleId}`, { token: adminToken })
  ok('使用中的角色不可删（409）', r.status === 409)
  const superR = (await api('GET', '/admin/roles', { token: adminToken })).data.list.find(x => x.name === '超级管理员')
  r = await api('DELETE', `/admin/roles/${superR.id}`, { token: adminToken })
  ok('预置角色不可删（400）', r.status === 400)

  console.log('— 文书管理与配置防御 —')
  r = await api('PATCH', '/admin/legal/tos', { token: adminToken, body: { content: '第一条 本平台采用承揽后分包模式（v2修订版,内容不少于二十个字以通过校验）。' } })
  ok('协议修订版本自增', r.status === 200 && r.data.version === 2)
  r = await api('PATCH', '/admin/configs/platformMarginRate', { token: adminToken, body: { value: -0.5 } })
  ok('负数比率配置被拒（400）', r.status === 400)
  r = await api('PATCH', '/admin/configs/platformMarginRate', { token: adminToken, body: { value: 1.5 } })
  ok('比率超1配置被拒（400）', r.status === 400)

  console.log('— 按单税负测算与安全线 —')
  r = await api('GET', '/company/estimate?price=10000&category=设计', { token: companyToken })
  ok('发布前测算（分包/服务费/税费/保险）', r.data.subPrice === 9000 && r.data.platformFee === 1000 && r.data.insurance === 3 && r.data.safe === true)
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '超低价测算预警单', category: '设计', payMethod: '按成果', price: 60, deadline: '2099-12-01', description: '验证税负安全线预警机制' } })
  const lowTaskId = r.data.id
  r = await api('GET', '/admin/risk/alerts', { token: adminToken })
  ok('低于安全线发单产生预警', r.data.list.some(a => a.type === '税负安全线'))
  await api('POST', `/company/tasks/${lowTaskId}/cancel`, { token: companyToken })

  console.log('— 防员转零 —')
  r = await api('POST', `/admin/companies/${goodCompanyId}/payroll`, { token: adminToken, body: { names: ['李建国', '王某某'] } })
  ok('上传历史发薪名单', r.status === 200 && r.data.added === 2)
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '员转零比对演练单', category: '设计', payMethod: '按成果', price: 1000, deadline: '2099-12-31', description: '验证防员转零比对机制' } })
  const ptTaskId = r.data.id
  await api('POST', `/worker/tasks/${ptTaskId}/apply`, { token: workerToken })
  await api('POST', `/company/tasks/${ptTaskId}/hire`, { token: companyToken, body: { workerId } })
  r = await api('GET', '/admin/risk/alerts', { token: adminToken })
  ok('录用名单内零工触发防员转零预警', r.data.list.some(a => a.type === '防员转零' && a.refId === goodCompanyId))

  console.log('— 抽查回访工作台 —')
  r = await api('POST', '/admin/callbacks/sample', { token: adminToken })
  ok('按比例抽取回访名单', r.status === 200 && r.data.sampled >= 1)
  r = await api('GET', '/admin/callbacks?status=pending', { token: adminToken })
  const cbId = r.data.list[0].id
  ok('回访列表含零工联系方式', r.data.list[0].workerPhone?.startsWith('1'))
  r = await api('POST', `/admin/callbacks/${cbId}/resolve`, { token: adminToken, body: { confirmed: false, note: '�绰�ط��㹤���ˣ�ȷ��' } })
  ok('疑似乱码回访备注被拒（400）', r.status === 400 && r.data.error.message.includes('疑似乱码'))
  r = await api('POST', `/admin/callbacks/${cbId}/resolve`, { token: adminToken, body: { confirmed: false, note: '零工称未参与该任务' } })
  ok('回访异常处理', r.status === 200 && r.data.status === 'abnormal')
  r = await api('GET', '/admin/risk/alerts', { token: adminToken })
  ok('回访异常触发虚构交易预警', r.data.list.some(a => a.type === '回访异常'))

  console.log('— 保险理赔 —')
  r = await api('POST', '/worker/claims', { token: workerToken, body: { taskId: ptTaskId, description: '搬运设备时手部受伤，已就医' } })
  ok('零工一键报案', r.status === 201 && r.data.policyNo.startsWith('INS'))
  const claimId = r.data.id
  r = await api('GET', '/admin/claims', { token: adminToken })
  ok('运营可见理赔工单', r.data.list.some(x => x.id === claimId))
  r = await api('POST', `/admin/claims/${claimId}/process`, { token: adminToken, body: { status: 'closed', result: '保险公司已赔付 ¥800' } })
  ok('理赔办结并通知零工', r.status === 200)
  r = await api('GET', '/worker/claims', { token: workerToken })
  ok('零工可查理赔结果', r.data.list[0].status === 'closed' && r.data.list[0].result.includes('800'))

  console.log('— 发票红冲与进项看板 —')
  r = await api('GET', '/admin/invoices', { token: adminToken })
  const invId = r.data.list[0].id
  ok('运营发票列表', r.data.total >= 4)
  r = await api('POST', `/admin/invoices/${invId}/void`, { token: adminToken, body: { reason: '开票信息有误，红冲重开' } })
  ok('发票红冲', r.status === 200 && r.data.status === 'voided')
  r = await api('GET', '/admin/tax/input-overview', { token: adminToken })
  ok('进项优化看板', r.data.soletraderCount >= 1 && r.data.monthly.length >= 1 && r.data.suggestion)

  console.log('— 平台初始报送与IP关联 —')
  r = await api('POST', '/admin/tax/platform-report', { token: adminToken })
  ok('平台基本信息报送', r.status === 200 && r.data.fileNo.startsWith('RP'))
  r = await api('POST', '/admin/tax/platform-report', { token: adminToken })
  ok('重复报送被拒（409）', r.status === 409)
  r = await api('GET', '/admin/risk/ip-graph', { token: adminToken })
  ok('同IP多账号关联检出（测试同源登录）', r.data.total >= 1 && r.data.list[0].userCount >= 3)

  console.log('— 连续性劳务申报与报送（16/15号公告）—')
  r = await api('GET', '/admin/tax/quarter-summary?quarter=2026Q2', { token: adminToken })
  ok('季度报送按所得类型分类汇总', r.status === 200 && r.data.byType.some(t => t.incomeType === 'labor_continuous' && Number(t.gross) > 0))
  ok('汇总含经营所得（B线个体户）', r.data.byType.some(t => t.incomeType === 'business'))
  r = await api('GET', '/admin/tax/declare-file?period=2026-06', { token: adminToken })
  ok('扣缴申报底稿含累计预扣法列', typeof r.data === 'string' && r.data.includes('累计预扣法') && r.data.includes('连续取得月份数'))

  console.log('— 派单（定向派单）—')
  // workerId（顾）已多次与该企业合作，是合法派单候选
  r = await api('GET', '/company/dispatch/candidates', { token: companyToken })
  ok('候选零工含历史合作零工', r.status === 200 && r.data.list.some(w => w.workerId === workerId))
  // 全新零工从未与该企业合作 → 不可被派单
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13911112233', password: PW, name: '陌生零工', agree: true } })
  const strangerId = r.data.user.id, strangerToken = r.data.token
  await api('POST', '/worker/verify', { token: strangerToken, body: { idCard: '330106199607075432', realName: '陌生零工', bankCard: '6228000000007777' } })

  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '派单专属设计稿', category: '设计', payMethod: '按成果', price: 5000, deadline: '2099-09-01', description: '定向派单给老搭档的设计任务' } })
  const dispatchTaskId = r.data.id
  r = await api('POST', `/company/tasks/${dispatchTaskId}/dispatch`, { token: companyToken, body: { workerId: strangerId } })
  ok('向未合作零工派单被拒（NOT_CANDIDATE）', r.status === 400 && r.data.error.code === 'NOT_CANDIDATE')
  r = await api('POST', `/company/tasks/${dispatchTaskId}/dispatch`, { token: companyToken, body: { workerId, note: '老搭档帮个忙' } })
  ok('向合作零工派单成功', r.status === 201 && r.data.dispatched === true)
  r = await api('POST', `/company/tasks/${dispatchTaskId}/dispatch`, { token: companyToken, body: { workerId } })
  ok('重复派单被拒（409）', r.status === 409)

  r = await api('GET', '/me/notifications', { token: workerToken })
  ok('零工收到派单通知', r.data.list.some(n => n.type === 'dispatch'))
  r = await api('GET', '/worker/dispatches', { token: workerToken })
  const myDispatch = r.data.list.find(d => d.taskId === dispatchTaskId)
  ok('零工可见派单邀约（含收入预估）', myDispatch && myDispatch.status === 'invited' && myDispatch.estimate.net > 0)

  r = await api('POST', `/worker/dispatches/${myDispatch.id}/accept`, { token: workerToken })
  ok('零工接受派单：签分包工单+保单', r.status === 200 && r.data.workOrderNo.startsWith('FB') && r.data.policyNo.startsWith('INS'))
  r = await api('GET', `/company/tasks/${dispatchTaskId}`, { token: companyToken })
  ok('派单任务转为进行中', r.data.status === 'working')
  ok('任务详情记录派单已接受', r.data.dispatches.some(d => d.workerId === workerId && d.status === 'accepted'))
  r = await api('POST', `/worker/dispatches/${myDispatch.id}/accept`, { token: workerToken })
  ok('重复接受已处理派单被拒（409）', r.status === 409)

  // 拒绝路径：另一任务派单后零工拒绝，任务保持报名中
  r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '派单可被拒绝单', category: '设计', payMethod: '按成果', price: 5000, deadline: '2099-09-02', description: '验证零工拒绝派单后任务回到招募' } })
  const dispatchTask2 = r.data.id
  await api('POST', `/company/tasks/${dispatchTask2}/dispatch`, { token: companyToken, body: { workerId } })
  r = await api('GET', '/worker/dispatches', { token: workerToken })
  const d2 = r.data.list.find(d => d.taskId === dispatchTask2)
  r = await api('POST', `/worker/dispatches/${d2.id}/reject`, { token: workerToken, body: { reason: '近期档期已满' } })
  ok('零工拒绝派单成功', r.status === 200 && r.data.rejected === true)
  r = await api('GET', `/company/tasks/${dispatchTask2}`, { token: companyToken })
  ok('被拒后任务仍为招募中', r.data.status === 'recruiting' && r.data.dispatches[0].status === 'rejected')

  console.log(`\n✅ 全部 ${passed} 项断言通过`)
} catch (err) {
  console.error('\n❌ 测试失败：', err.message)
  process.exitCode = 1
} finally {
  server.close()
  db.close()
  try {
    fs.rmSync(tmpDb, { force: true })
    fs.rmSync(tmpDb + '-wal', { force: true })
    fs.rmSync(tmpDb + '-shm', { force: true })
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true })
  } catch {}
}
