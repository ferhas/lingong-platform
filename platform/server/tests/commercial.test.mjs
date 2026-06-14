// v5 商用化模块集成测试：充值单收银台/webhook回调/绑卡/短信验证码/争议仲裁/客服工单/
// 评价信用/财务报表/导出审批/2FA/消息模板/帮助中心/技能认证/进项台账/应急开关/metrics
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const tmpDb = path.join(os.tmpdir(), `gigwork-comm-${Date.now()}.db`)
process.env.DB_PATH = tmpDb
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-comm-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.WEBHOOK_SECRET = 'test-webhook-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default
const { runDisputeTimeouts, runTicketSla, runWebhookRetry, runRechargeExpire } = await import('../src/jobs/housekeeping2.js')
const { runWithdrawals } = await import('../src/jobs/withdrawals.js')
const { totpCode } = await import('../src/utils/totp.js')

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', '13800000001', ?, '平台运营', ?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}/api/v1`

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log(`  ✓ ${name}`)
}

async function api(method, url, { token, body, headers } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text()
  return { status: res.status, data }
}

async function webhook(provider, payload, { badSign = false } = {}) {
  const raw = JSON.stringify(payload)
  const sig = badSign ? 'deadbeef' : crypto.createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex')
  const res = await fetch(BASE + `/webhooks/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': sig },
    body: raw
  })
  return { status: res.status, data: await res.json() }
}

const PW = 'Test@123456'

try {
  // ===== 基础账号 =====
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  const adminToken = r.data.token

  r = await api('POST', '/auth/register', {
    body: { role: 'company', phone: '13600000001', password: PW, name: '王总', companyName: '云上视觉传媒有限公司', licenseNo: '91330106MA2COMM01', industry: '内容制作', agree: true }
  })
  let companyToken = r.data.token
  const companyId = db.prepare(`SELECT id FROM companies WHERE license_no = '91330106MA2COMM01'`).get().id
  await api('POST', `/admin/companies/${companyId}/review`, { token: adminToken, body: { pass: true, note: '准入' } })

  console.log('— 短信验证码 —')
  r = await api('POST', '/auth/sms-code', { body: { phone: '13600000099', scene: 'register' } })
  ok('注册验证码下发（开发态回显）', r.status === 200 && r.data.devCode?.length === 6)
  const devCode = r.data.devCode
  r = await api('POST', '/auth/sms-code', { body: { phone: '13600000099', scene: 'register' } })
  ok('60秒内重发被频控（400）', r.status === 400 && r.data.error.code === 'SMS_TOO_FREQUENT')
  r = await api('POST', '/auth/register', {
    body: { role: 'worker', phone: '13600000099', password: PW, name: '验证码注册', agree: true, smsCode: '000000' }
  })
  ok('错误验证码注册被拒（400）', r.status === 400)
  r = await api('POST', '/auth/register', {
    body: { role: 'worker', phone: '13600000099', password: PW, name: '验证码注册', agree: true, smsCode: devCode }
  })
  ok('正确验证码注册成功', r.status === 201)
  ok('短信外发已落日志', db.prepare(`SELECT COUNT(*) AS n FROM message_logs WHERE channel = 'sms' AND status = 'sent'`).get().n >= 1)

  console.log('— 充值单收银台与入金回调 —')
  r = await api('POST', '/company/recharge-orders', { token: companyToken, body: { amount: 100000 } })
  ok('创建充值单返回专属入金账户', r.status === 201 && r.data.orderNo && r.data.payAccount)
  const orderNo = r.data.orderNo
  r = await webhook('escrow', { eventId: `evt-${orderNo}`, eventType: 'recharge.success', data: { orderNo, amount: 10000000 } }, { badSign: true })
  ok('伪造签名回调被拒（400）', r.status === 400)
  r = await webhook('escrow', { eventId: `evt-${orderNo}`, eventType: 'recharge.success', data: { orderNo, amount: 10000000 } })
  ok('入金回调处理成功', r.status === 200 && r.data.code === 'SUCCESS')
  r = await webhook('escrow', { eventId: `evt-${orderNo}`, eventType: 'recharge.success', data: { orderNo, amount: 10000000 } })
  ok('重复回调幂等（duplicated）', r.data.duplicated === true || r.data.code === 'SUCCESS')
  r = await api('GET', '/company/profile', { token: companyToken })
  ok('回调驱动入账：余额10万', r.data.account.balance === 100000)
  r = await api('GET', '/company/recharge-orders', { token: companyToken })
  ok('充值单状态 paid', r.data.list[0].status === 'paid')

  console.log('— 零工实名/绑卡/带验证码提现 —')
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13600000002', password: PW, name: '小陈', agree: true } })
  let workerToken = r.data.token
  const workerId = db.prepare(`SELECT id FROM users WHERE phone = '13600000002'`).get().id
  r = await api('POST', '/worker/verify', {
    token: workerToken,
    body: { idCard: '330102199501011234', realName: '陈小工', bankCard: '6222020200112233445', consents: ['idcard', 'face', 'bankcard'] }
  })
  ok('实名通过（含PIPL单独同意留痕）', r.status === 200 && r.data.verified)
  ok('单独同意已留痕', db.prepare(`SELECT COUNT(*) AS n FROM agreements WHERE user_id = ? AND doc_type LIKE 'consent_%'`).get(workerId).n === 3)
  ok('身份证号密文入库（非明文）', (() => {
    const s = db.prepare(`SELECT * FROM worker_secrets WHERE user_id = ?`).get(workerId)
    return s && !s.id_card_cipher.includes('330102') && s.id_card_hmac.length === 64
  })())
  ok('实名即开立存管子账户', !!db.prepare(`SELECT 1 FROM escrow_members WHERE owner_type = 'worker' AND owner_id = ?`).get(workerId))

  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13600000003', password: PW, name: '冒名者', agree: true } })
  const worker2Token = r.data.token
  r = await api('POST', '/worker/verify', {
    token: worker2Token, body: { idCard: '330102199501011234', realName: '陈小工', bankCard: '6222020200112233446' }
  })
  ok('同一身份证号二次绑定被拒（409）', r.status === 409 && r.data.error.code === 'IDCARD_EXISTS')

  r = await api('POST', '/worker/bank-card', { token: workerToken, body: { bankCard: '6222020200112233445', phone: '13600000002' } })
  ok('四要素核验+绑卡成功（协议号出金）', r.status === 200 && r.data.cardBound)
  ok('绑卡协议号已存储', !!db.prepare(`SELECT bind_card_token FROM escrow_members WHERE owner_id = ?`).get(workerId).bind_card_token)

  console.log('— 任务全流程（批量发单 → 录用 → 交付 → 争议 → 裁决部分结算）—')
  r = await api('POST', '/company/tasks/batch', {
    token: companyToken,
    body: {
      items: [
        { title: '商品主图设计10张', category: '设计', payMethod: '按成果', price: 2000, deadline: '2099-12-31', description: '电商主图设计，每张输出PSD+JPG' },
        { title: '违禁任务月薪打卡', category: '设计', payMethod: '按成果', price: 1000, deadline: '2099-12-31', description: '每天打卡上班月薪结算' },
        { title: '短视频剪辑5条', category: '视频', payMethod: '按件', price: 1500, deadline: '2099-12-31', description: '产品宣传短视频剪辑，30-60秒' }
      ]
    }
  })
  ok('批量发单：2成功1违禁被拒', r.status === 201 && r.data.success === 2 && r.data.failed === 1 && !r.data.results[1].ok)
  const taskId = r.data.results[0].id

  await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  r = await api('GET', `/company/tasks/${taskId}`, { token: companyToken })
  ok('报名列表携带信用画像', r.data.applications[0].credit && r.data.applications[0].credit.creditScore === 600)
  await api('POST', `/company/tasks/${taskId}/hire`, { token: companyToken, body: { workerId } })
  await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '已完成10张主图，源文件见链接' } })
  r = await api('POST', `/company/tasks/${taskId}/reject`, { token: companyToken, body: { reason: '第3张构图不符合要求' } })
  await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '第3张已重做，请再次验收' } })

  // 零工对二次驳回不服 → 发起验收争议
  await api('POST', `/company/tasks/${taskId}/reject`, { token: companyToken, body: { reason: '仍不满意' } })
  await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '第三次交付' } })
  r = await api('POST', `/worker/orders/${taskId}/dispute`, {
    token: workerToken,
    body: { type: 'acceptance', claim: '已按交付标准完成全部10张主图并两次按企业意见修改，企业仍拒绝验收', claimAmount: 1840 }
  })
  ok('零工发起验收争议', r.status === 201 && r.data.no.startsWith('DSP'))
  const disputeId = r.data.id

  r = await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken })
  ok('争议锁阻断结算（409 DISPUTE_LOCKED）', r.status === 409 && r.data.error.code === 'DISPUTE_LOCKED')

  r = await api('GET', `/me/disputes/${disputeId}`, { token: companyToken })
  ok('企业可见争议详情与时间线', r.status === 200 && r.data.timeline.length >= 1)
  r = await api('POST', `/me/disputes/${disputeId}/events`, { token: companyToken, body: { content: '交付物多处与需求不符，已留存对比截图' } })
  ok('企业举证留言', r.status === 201)

  r = await api('POST', `/admin/disputes/${disputeId}/accept`, { token: adminToken })
  ok('平台受理转仲裁', r.status === 200 && r.data.status === 'arbitrating')
  r = await api('POST', `/admin/disputes/${disputeId}/rule`, {
    token: adminToken,
    body: { rulingType: 'partial_pay', rulingAmount: 1200, rulingNote: '交付物大部分符合标准，部分瑕疵酌减报酬，按65%结算' }
  })
  ok('裁决：部分结算', r.status === 200 && r.data.status === 'ruled')
  r = await api('POST', `/admin/disputes/${disputeId}/execute`, { token: adminToken })
  ok('裁决执行', r.status === 200 && r.data.status === 'executed')

  const settlement = db.prepare(`SELECT * FROM settlements WHERE task_id = ?`).get(taskId)
  ok('按裁决金额结算（ruled_gross=120000分）', settlement.status === 'done' && settlement.ruled_gross === 120000)
  r = await api('GET', '/company/profile', { token: companyToken })
  const bal = r.data.account
  ok('剩余冻结已解冻退回（仅另一在招任务冻结1500）', bal.frozen === 1500)
  r = await api('GET', '/company/invoices', { token: companyToken })
  ok('发票按企业实际承担额开具', r.data.list.length === 1 && r.data.list[0].amount < 2000)

  console.log('— 评价与信用 —')
  r = await api('POST', `/company/tasks/${taskId}/review`, { token: companyToken, body: { score: 3, tags: ['按时交付'], comment: '有瑕疵但态度好' } })
  ok('企业评价零工', r.status === 201)
  r = await api('GET', `/worker/orders/${taskId}/reviews`, { token: workerToken })
  ok('互盲：仅一方评价时对方不可见', r.data.visible === false && r.data.reviews.length === 0)
  r = await api('POST', `/worker/orders/${taskId}/review`, { token: workerToken, body: { score: 4, tags: ['验收爽快'] } })
  ok('零工评价企业', r.status === 201)
  r = await api('GET', `/worker/orders/${taskId}/reviews`, { token: workerToken })
  ok('双方评完互相可见', r.data.visible === true && r.data.reviews.length === 2)
  const credit = db.prepare(`SELECT credit_score FROM worker_profiles WHERE user_id = ?`).get(workerId).credit_score
  ok('信用分已重算（完单+评分+争议部分败诉）', credit !== 600)

  console.log('— 提现（出金走绑卡协议号）—')
  r = await api('POST', '/worker/withdraw', { token: workerToken, body: { amount: 500 } })
  ok('提现申请（含 member_no）', r.status === 201)
  const wd = db.prepare(`SELECT * FROM withdrawals ORDER BY id DESC LIMIT 1`).get()
  ok('提现单关联存管会员号', !!wd.member_no)
  await runWithdrawals()
  ok('出金完成', db.prepare(`SELECT status FROM withdrawals WHERE id = ?`).get(wd.id).status === 'done')

  console.log('— 应急开关 —')
  r = await api('POST', '/admin/fund-switches', { token: adminToken, body: { settlementPaused: true, withdrawalPaused: true } })
  ok('开启全局结算/提现暂停', r.data.settlementPaused && r.data.withdrawalPaused)
  r = await api('POST', '/worker/withdraw', { token: workerToken, body: { amount: 100 } })
  ok('暂停期提现被拒（409）', r.status === 409 && r.data.error.code === 'WITHDRAWAL_PAUSED')
  await api('POST', '/admin/fund-switches', { token: adminToken, body: { settlementPaused: false, withdrawalPaused: false } })
  r = await api('GET', '/admin/system-health', { token: adminToken })
  ok('系统健康页：开关已恢复+集成在线', r.data.switches.settlementPaused === false && r.data.integrations.length === 8)

  console.log('— 客服工单 —')
  r = await api('POST', '/me/tickets', {
    token: workerToken,
    body: { category: 'withdraw', title: '提现未到账咨询', content: '昨天的提现显示成功但银行卡没收到', refType: 'withdrawal', refId: wd.id }
  })
  ok('资损类工单自动紧急', r.status === 201 && r.data.priority === 'urgent')
  const ticketId = r.data.id
  r = await api('POST', `/admin/tickets/${ticketId}/reply`, { token: adminToken, body: { content: '已核实银行回单，T+1到账，请今日内留意' } })
  ok('客服回复', r.status === 201)
  r = await api('GET', `/me/tickets/${ticketId}`, { token: workerToken })
  ok('用户可见客服回复', r.data.messages.some(m => m.sender === 'agent'))
  await api('POST', `/admin/tickets/${ticketId}/resolve`, { token: adminToken, body: { note: '已到账确认' } })
  r = await api('POST', `/me/tickets/${ticketId}/rate`, { token: workerToken, body: { satisfaction: 5 } })
  ok('办结后满意度评价', r.status === 200)
  r = await api('POST', '/me/tickets', {
    token: companyToken,
    body: { category: 'complaint', title: '举报虚假任务', content: '发现平台上有任务疑似刷单走账，请核查处理' }
  })
  ok('投诉举报联动风控预警', r.status === 201 &&
    db.prepare(`SELECT COUNT(*) AS n FROM risk_alerts WHERE type = '用户投诉举报'`).get().n === 1)

  console.log('— 财务报表中心 —')
  const period = new Date().toISOString().slice(0, 7)
  r = await api('GET', `/admin/finance/monthly?period=${period}`, { token: adminToken })
  ok('经营月报：收入=成本+毛利', r.status === 200 &&
    Math.abs(r.data.operating.revenue - (r.data.operating.subContractCost + r.data.operating.grossMargin)) < 0.01)
  ok('税款备付金勾稽', r.data.taxReserve.due.total >= 0 && typeof r.data.taxReserve.reserveBalance === 'number')
  r = await api('GET', `/admin/finance/settlement-detail?period=${period}`, { token: adminToken })
  ok('结算明细（含裁决标记）', r.data.list.length === 1 && r.data.list[0].ruled === true)
  r = await api('GET', `/company/statement?period=${period}`, { token: companyToken })
  ok('企业月结单（充值/消耗/发票/期末余额）', r.data.summary.rechargeTotal === 100000 && r.data.settlements.length === 1)

  console.log('— 个人信息导出审批 —')
  r = await api('GET', '/admin/workers', { token: adminToken })
  ok('超管可见完整手机号（user:read_pii 经 * 通配）', r.data.list.some(w => /^1\d{10}$/.test(w.phone)))
  r = await api('POST', '/admin/exports', { token: adminToken, body: { scope: '全量零工名册（含手机号）', reason: '季度涉税信息报送底稿核对' } })
  const exportId = r.data.id
  r = await api('POST', `/admin/exports/${exportId}/approve`, { token: adminToken, body: { pass: true } })
  ok('不能审批自己的申请（400）', r.status === 400 && r.data.error.code === 'SELF_FORBIDDEN')
  // 第二个审批人
  const approverRow = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
  db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', '13800000002', ?, '财务负责人', ?)`)
    .run(bcrypt.hashSync('Admin@123456', 10), approverRow.id)
  r = await api('POST', '/auth/login', { body: { phone: '13800000002', password: 'Admin@123456' } })
  const approverToken = r.data.token
  r = await api('POST', `/admin/exports/${exportId}/approve`, { token: approverToken, body: { pass: true, note: '事由合规' } })
  ok('审批通过', r.status === 200 && r.data.status === 'approved')
  const dl = await fetch(`${BASE}/admin/exports/${exportId}/download`, { headers: { authorization: `Bearer ${adminToken}` } })
  const csv = await dl.text()
  ok('限时下载（含水印列）', dl.status === 200 && csv.includes(`EXPORT-${exportId}`))

  console.log('— 运营端 2FA —')
  r = await api('POST', '/admin/2fa/setup', { token: adminToken })
  ok('获取绑定密钥与 otpauth', r.status === 200 && r.data.secret && r.data.otpauthUrl.startsWith('otpauth://'))
  const secret = r.data.secret
  r = await api('POST', '/admin/2fa/enable', { token: adminToken, body: { code: totpCode(secret) } })
  ok('动态码校验通过启用 2FA', r.status === 200 && r.data.enabled)
  r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  ok('2FA 账号登录返回二段验证', r.data.needTotp === true && r.data.tmpToken)
  let totpLogin = await api('POST', '/auth/totp', { body: { tmpToken: r.data.tmpToken, code: '000000' } })
  ok('错误动态码被拒（401）', totpLogin.status === 401)
  totpLogin = await api('POST', '/auth/totp', { body: { tmpToken: r.data.tmpToken, code: totpCode(secret) } })
  ok('正确动态码换取会话', totpLogin.status === 200 && totpLogin.data.token)
  const admin2faToken = totpLogin.data.token
  r = await api('POST', '/admin/fund-switches', { token: admin2faToken, body: { settlementPaused: false } })
  ok('敏感操作缺动态码被 step-up 拦截（403）', r.status === 403)
  r = await api('POST', '/admin/fund-switches', {
    token: admin2faToken, body: { settlementPaused: false }, headers: { 'x-totp-code': totpCode(secret) }
  })
  ok('携带动态码 step-up 通过', r.status === 200)

  console.log('— 消息模板 / 帮助中心 / 技能 / 进项台账 / 事件监控 —')
  r = await api('GET', '/admin/message-templates', { token: adminToken })
  ok('消息模板列表（含验证码/结算模板）', r.data.list.some(t => t.code === 'sms_verify_code') && r.data.list.some(t => t.code === 'sms_settled'))
  r = await api('PATCH', '/admin/message-templates/sms_settled', { token: adminToken, body: { enabled: false } })
  ok('运营停用模板', r.status === 200)
  r = await api('GET', '/admin/message-logs', { token: adminToken })
  ok('外发日志含触达率', r.status === 200 && r.data.deliveryRate)

  r = await api('GET', '/me/help', { token: workerToken })
  ok('帮助中心（零工侧文章）', r.status === 200 && r.data.list.length >= 5)
  r = await api('GET', `/me/help/${r.data.list[0].id}`, { token: workerToken })
  ok('文章详情', r.status === 200 && r.data.content.length > 10)
  r = await api('POST', '/admin/help-articles', {
    token: adminToken, body: { audience: 'all', category: '公告', title: '平台对外公示信息', content: '客服电话 400-000-0000；ICP备案号 浙ICP备XXXX号；可向12315/12333/12321投诉举报。' }
  })
  ok('运营新增公示文章', r.status === 201)

  r = await api('POST', '/worker/skills', { token: workerToken, body: { skill: 'UI设计', level: '中级' } })
  ok('零工提交技能认证', r.status === 201)
  const skillId = r.data.id
  r = await api('POST', `/admin/skills/${skillId}/review`, { token: adminToken, body: { pass: true } })
  ok('运营审核技能通过', r.data.status === 'verified')
  r = await api('GET', '/worker/profile', { token: workerToken })
  ok('个人中心展示信用与认证技能', r.data.credit.verifiedSkills.length === 1)

  r = await api('GET', '/admin/webhook-events', { token: adminToken })
  ok('回调事件监控（processed）', r.data.list.length >= 1 && r.data.list.every(e => e.status === 'processed'))
  r = await api('GET', '/admin/integration-calls', { token: adminToken })
  ok('出站调用日志', r.data.total > 0)

  console.log('— 治理 Job —')
  // 充值单过期
  db.prepare(`INSERT INTO recharge_orders (no, company_id, amount, pay_account, created_at) VALUES ('CZEXPIRE01', ?, 100, 'x', datetime('now','localtime','-1 day'))`).run(companyId)
  let jr = runRechargeExpire()
  ok('过期充值单关闭', jr.expiredOrders >= 1)
  // 争议超时流转（构造一条协商期已过的争议）
  db.prepare(`UPDATE disputes SET status = 'negotiating', stage_deadline = datetime('now','-1 hour') WHERE id = ?`).run(disputeId)
  db.prepare(`UPDATE tasks SET dispute_id = ? WHERE id = ?`).run(disputeId, taskId)
  jr = await runDisputeTimeouts()
  ok('协商期满自动转仲裁', jr.toArbitrating >= 1)
  db.prepare(`UPDATE disputes SET status = 'executed', closed_at = datetime('now','localtime','-2 day') WHERE id = ?`).run(disputeId)
  db.prepare(`UPDATE tasks SET dispute_id = NULL WHERE id = ?`).run(taskId)
  jr = await runDisputeTimeouts()
  ok('执行满24h自动归档关闭', jr.closed >= 1)
  // 工单 SLA
  db.prepare(`UPDATE tickets SET first_reply_at = NULL, escalated = 0, status = 'open', created_at = datetime('now','localtime','-3 hour') WHERE id = ?`).run(ticketId)
  jr = runTicketSla()
  ok('紧急工单超时升级', jr.escalated >= 1)
  jr = runWebhookRetry()
  ok('回调补单 Job 可运行', typeof jr.scanned === 'number')

  console.log('— /metrics —')
  const m = await fetch(`http://127.0.0.1:${PORT}/metrics`)
  const metricsText = await m.text()
  ok('业务指标暴露（结算/对账/Job）', m.status === 200 &&
    metricsText.includes('settlement_pending_total') &&
    metricsText.includes('recon_daily_diff_cents') &&
    metricsText.includes('account_negative_balance_total'))

  console.log('— 协议版本重新同意 —')
  r = await api('GET', '/me/agreements/status', { token: workerToken })
  ok('协议版本状态（无需重签）', r.status === 200 && r.data.needReAgree === false)
  db.prepare(`UPDATE legal_docs SET version = version + 1 WHERE type = 'privacy'`).run()
  r = await api('GET', '/me/agreements/status', { token: workerToken })
  ok('隐私政策升版后提示重新同意', r.data.needReAgree === true)
  await api('POST', '/me/agreements/re-agree', { token: workerToken })
  r = await api('GET', '/me/agreements/status', { token: workerToken })
  ok('重新同意后恢复', r.data.needReAgree === false)

  console.log('— 邀请码 —')
  r = await api('GET', '/company/invite-code', { token: companyToken })
  ok('企业获取邀请码', r.status === 200 && r.data.inviteCode.startsWith('INV'))
  const invite = r.data.inviteCode
  r = await api('POST', '/auth/register', {
    body: { role: 'worker', phone: '13600000077', password: PW, name: '受邀零工', agree: true, inviteCode: invite }
  })
  ok('邀请码注册绑定来源企业', r.status === 201 &&
    db.prepare(`SELECT invited_by_company_id FROM worker_profiles wp JOIN users u ON u.id = wp.user_id WHERE u.phone = '13600000077'`).get().invited_by_company_id === companyId)
  r = await api('POST', '/auth/register', {
    body: { role: 'worker', phone: '13600000078', password: PW, name: '错码零工', agree: true, inviteCode: 'INVBAD' }
  })
  ok('无效邀请码被拒（400）', r.status === 400 && r.data.error.code === 'BAD_INVITE_CODE')

  console.log('— 开放 API（HMAC 签名）—')
  // 该管理员已启用 2FA：敏感操作携带动态码（step-up）
  r = await api('POST', '/admin/api-credentials', {
    token: adminToken, body: { companyId }, headers: { 'x-totp-code': totpCode(secret) }
  })
  ok('创建 API 凭据（secret 仅返回一次）', r.status === 201 && r.data.appKey && r.data.appSecret)
  const { appKey, appSecret } = r.data
  const signKey = crypto.createHash('sha256').update(appSecret).digest('hex')
  const openCall = async (method, url, body) => {
    const ts = String(Date.now())
    const payload = `${ts}.${JSON.stringify(body ?? {})}`
    const sig = crypto.createHmac('sha256', signKey).update(payload).digest('hex')
    const res = await fetch(`http://127.0.0.1:${PORT}/api/open/v1${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-app-key': appKey, 'x-timestamp': ts, 'x-signature': sig },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, data: await res.json() }
  }
  r = await openCall('POST', '/tasks', {
    title: 'API直连发单测试', category: '技术', payMethod: '按成果', price: 800,
    deadline: '2099-12-31', description: '通过开放API创建的任务，校验合规链生效'
  })
  ok('开放API发单（走标准合规链）', r.status === 201 && r.data.id)
  r = await openCall('GET', `/tasks/${r.data.id}`)
  ok('开放API任务查询', r.status === 200 && r.data.status === 'recruiting')
  const badRes = await fetch(`http://127.0.0.1:${PORT}/api/open/v1/tasks/1`, {
    headers: { 'x-app-key': appKey, 'x-timestamp': String(Date.now()), 'x-signature': 'bad' }
  })
  ok('错误签名被拒（401）', badRes.status === 401)

  console.log(`\n✅ 商用化模块全部 ${passed} 项断言通过`)
} catch (err) {
  console.error('\n❌ 测试失败：', err.message)
  process.exitCode = 1
} finally {
  server.close()
  db.close()
}
