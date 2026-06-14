// 第二轮审计修复回归测试：争议永冻/二次执行资损/充值迟到入账/提现卡单恢复/webhook 死信熔断 等。
// 独立临时库、进程内启动；直接调用 Job 纯函数验证治理逻辑。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-af2-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-af2-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.WEBHOOK_SECRET = 'test-webhook-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default
const { runDisputeTimeouts, runWebhookRetry, runRechargeExpire } = await import('../src/jobs/housekeeping2.js')
const { runWithdrawals } = await import('../src/jobs/withdrawals.js')
const { runSettlementRetry } = await import('../src/jobs/settlementRetry.js')
const { processSettlement } = await import('../src/services/settlement.js')
const { _testHooks } = await import('../src/integrations/index.js')

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', '13800000001', ?, '平台运营', ?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`
const PW = 'Test@123456'

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
async function uploadText(token, name, text = 'evidence') {
  const form = new FormData()
  form.set('file', new Blob([text], { type: 'text/plain' }), name)
  const res = await fetch(BASE + '/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
  return { status: res.status, data: await res.json() }
}
async function webhook(provider, payload) {
  const raw = JSON.stringify(payload)
  const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex')
  const res = await fetch(BASE + `/webhooks/${provider}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': sig }, body: raw
  })
  return { status: res.status, data: await res.json() }
}

let adminToken, companyToken, companyId, workerToken, workerId
async function setupBase() {
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  adminToken = r.data.token
  r = await api('POST', '/auth/register', { body: { role: 'company', phone: '13600001001', password: PW, name: '王总', companyName: '审计修复测试公司', licenseNo: '91330106MA2AF2001', industry: '内容制作', agree: true } })
  companyToken = r.data.token
  companyId = db.prepare(`SELECT id FROM companies WHERE license_no = '91330106MA2AF2001'`).get().id
  await api('POST', `/admin/companies/${companyId}/review`, { token: adminToken, body: { pass: true, note: '准入' } })
  await api('POST', '/company/recharge', { token: companyToken, body: { amount: 500000 } })
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13600001002', password: PW, name: '小工', agree: true } })
  workerToken = r.data.token
  workerId = db.prepare(`SELECT id FROM users WHERE phone = '13600001002'`).get().id
  await api('POST', '/worker/verify', { token: workerToken, body: { idCard: '330106199001012333', realName: '小工', bankCard: '6217000000001234', consents: ['idcard', 'face', 'bankcard'] } })
}

// 发单→录用→（可选交付）→返回 taskId
async function makeHiredTask(price, { deliver = false } = {}) {
  let r = await api('POST', '/company/tasks', { token: companyToken, body: { title: '审计测试任务', category: '设计', payMethod: '按成果', price, deadline: '2099-12-31', description: '审计修复回归用任务描述足够长' } })
  const taskId = r.data.id
  await api('POST', `/worker/tasks/${taskId}/apply`, { token: workerToken })
  await api('POST', `/company/tasks/${taskId}/hire`, { token: companyToken, body: { workerId } })
  if (deliver) await api('POST', `/worker/orders/${taskId}/deliver`, { token: workerToken, body: { note: '已交付审计测试成果' } })
  return taskId
}

try {
  await setupBase()

  console.log('— D9：发起争议的初始附件必须属于发起人（修复初始证据 IDOR）—')
  {
    const taskId = await makeHiredTask(2000, { deliver: true })
    let r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13600001920', password: PW, name: '旁观零工', agree: true } })
    const otherToken = r.data.token
    r = await uploadText(otherToken, 'other-private.txt', 'other user private file')
    const otherUploadId = r.data.id
    r = await api('POST', `/worker/orders/${taskId}/dispute`, {
      token: workerToken,
      body: { type: 'acceptance', claim: '初始证据不能引用他人附件', claimAmount: 1000, attachmentIds: [otherUploadId] }
    })
    ok('引用他人附件发起争议被拒（400 BAD_ATTACHMENT）', r.status === 400 && r.data.error.code === 'BAD_ATTACHMENT')
    r = await uploadText(workerToken, 'own-evidence.txt', 'own evidence file')
    r = await api('POST', `/worker/orders/${taskId}/dispute`, {
      token: workerToken,
      body: { type: 'acceptance', claim: '本人附件可以作为初始争议证据', claimAmount: 1000, attachmentIds: [r.data.id] }
    })
    ok('引用本人附件发起争议仍可成功', r.status === 201 && !!r.data.id)
  }

  console.log('— A1：裁决公示期满，超时 Job 自动执行（修复"ruled 永冻结算"）—')
  {
    const taskId = await makeHiredTask(2000, { deliver: true })
    let r = await api('POST', `/worker/orders/${taskId}/dispute`, { token: workerToken, body: { type: 'acceptance', claim: '已按标准完成交付，企业拖延验收', claimAmount: 1840 } })
    const disputeId = r.data.id
    await api('POST', `/admin/disputes/${disputeId}/accept`, { token: adminToken })
    await api('POST', `/admin/disputes/${disputeId}/rule`, { token: adminToken, body: { rulingType: 'partial_pay', rulingAmount: 1000, rulingNote: '部分符合标准，酌减结算' } })
    const dRuled = db.prepare(`SELECT status FROM disputes WHERE id = ?`).get(disputeId)
    ok('裁决后处于 ruled 且任务结算被冻结', dRuled.status === 'ruled' && db.prepare(`SELECT dispute_id FROM tasks WHERE id = ?`).get(taskId).dispute_id === disputeId)
    // 公示期未到：Job 不动它
    let jr = await runDisputeTimeouts()
    ok('公示期未满不自动执行', db.prepare(`SELECT status FROM disputes WHERE id = ?`).get(disputeId).status === 'ruled')
    // 把公示截止改到过去 → Job 自动执行（stage_deadline 与 Job 的 now 均为 UTC ISO，与 deadlineAfterHours 一致）
    db.prepare(`UPDATE disputes SET stage_deadline = datetime('now','-2 hours') WHERE id = ?`).run(disputeId)
    jr = await runDisputeTimeouts()
    ok('公示期满自动执行裁决（executed>=1）', jr.executed >= 1)
    const dExec = db.prepare(`SELECT status FROM disputes WHERE id = ?`).get(disputeId)
    const task = db.prepare(`SELECT status, dispute_id FROM tasks WHERE id = ?`).get(taskId)
    ok('争议转 executed、任务已结算、争议锁已解除', dExec.status === 'executed' && task.status === 'settled' && task.dispute_id === null)
  }

  console.log('— E6：no_pay 执行后再 escalate 重复执行不二次解冻（修复资损）—')
  {
    const taskId = await makeHiredTask(3000)  // 仅录用（working），用零工失联争议
    let r = await api('POST', `/company/tasks/${taskId}/dispute`, { token: companyToken, body: { type: 'worker_missing', claim: '零工录用后失联，无法交付', claimAmount: 0 } })
    const disputeId = r.data.id
    await api('POST', `/admin/disputes/${disputeId}/accept`, { token: adminToken })
    await api('POST', `/admin/disputes/${disputeId}/rule`, { token: adminToken, body: { rulingType: 'no_pay', rulingNote: '零工失联，不予结算，冻结资金解冻退回企业' } })
    r = await api('POST', `/admin/disputes/${disputeId}/execute`, { token: adminToken })
    ok('no_pay 首次执行成功、任务取消', r.status === 200 && db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId).status === 'cancelled')
    const frozenAfter1 = db.prepare(`SELECT frozen FROM accounts WHERE owner_type='company' AND owner_id=?`).get(companyId).frozen
    // 当事方不服声明线下升级（executed → escalated）
    r = await api('POST', `/me/disputes/${disputeId}/escalate`, { token: companyToken })
    ok('已执行争议可声明线下升级', r.status === 200 && r.data.status === 'escalated')
    // 再次执行：必须幂等，不得二次解冻
    r = await api('POST', `/admin/disputes/${disputeId}/execute`, { token: adminToken })
    const frozenAfter2 = db.prepare(`SELECT frozen FROM accounts WHERE owner_type='company' AND owner_id=?`).get(companyId).frozen
    ok('escalated 再次执行成功返回（幂等）', r.status === 200)
    ok('二次执行未重复解冻（冻结额不变，无资损）', frozenAfter2 === frozenAfter1)
  }

  console.log('— A3：充值单超时过期后，银行迟到入金回调仍据实入账（修复资损）—')
  {
    let r = await api('POST', '/company/recharge-orders', { token: companyToken, body: { amount: 1000 } }) // 1000元 → 存 100000 分
    const orderNo = r.data.orderNo
    // 把创建时间改老 → 过期 Job 关闭
    db.prepare(`UPDATE recharge_orders SET created_at = datetime('now','localtime','-1 day') WHERE no = ?`).run(orderNo)
    const jr = runRechargeExpire()
    ok('超时充值单被置 expired', jr.expiredOrders >= 1 && db.prepare(`SELECT status FROM recharge_orders WHERE no = ?`).get(orderNo).status === 'expired')
    const balBefore = (await api('GET', '/company/profile', { token: companyToken })).data.account.balance
    // 银行迟到入金回调（data.amount 单位为分，与 order.amount 一致）
    r = await webhook('escrow', { eventId: `late-${orderNo}`, eventType: 'recharge.success', data: { orderNo, amount: 100000 } })
    ok('迟到回调被据实处理（SUCCESS，未死循环）', r.status === 200 && r.data.code === 'SUCCESS')
    const order = db.prepare(`SELECT status FROM recharge_orders WHERE no = ?`).get(orderNo)
    const balAfter = (await api('GET', '/company/profile', { token: companyToken })).data.account.balance
    ok('过期单复活为 paid 且余额据实入账（+1000元）', order.status === 'paid' && balAfter === balBefore + 1000)
  }

  console.log('— A4：提现卡在 processing（进程崩溃），Job 兜底恢复（修复永久冻结）—')
  {
    const r = await api('POST', '/worker/withdraw', { token: workerToken, body: { amount: 500 } })
    const wdId = r.data.id
    // 模拟"已置 processing 后进程崩溃、回调未达"
    db.prepare(`UPDATE withdrawals SET status = 'processing' WHERE id = ?`).run(wdId)
    const jr = await runWithdrawals()
    ok('Job 扫描到卡住的 processing 单', jr.scanned >= 1)
    ok('卡单被幂等重驱动至终态 done', db.prepare(`SELECT status FROM withdrawals WHERE id = ?`).get(wdId).status === 'done')
  }

  console.log('— A6：未注册事件类型连续失败转死信 ignored（修复毒丸无限重放）—')
  {
    // 合法签名但 eventType 未注册 → processEvent 抛错 → 失败计数
    let r = await webhook('escrow', { eventId: 'poison-1', eventType: 'unknown.poison', data: {} })
    ok('首次处理失败返回 RETRY_LATER', r.data.code === 'RETRY_LATER')
    const evId = db.prepare(`SELECT id FROM webhook_events WHERE event_id = 'poison-1'`).get().id
    ok('首次后状态 failed、attempts=1', (() => { const e = db.prepare(`SELECT status, attempts FROM webhook_events WHERE id = ?`).get(evId); return e.status === 'failed' && e.attempts === 1 })())
    // 补单 Job 有 2 分钟去抖窗口：把 received_at 改老使其可被重放
    db.prepare(`UPDATE webhook_events SET received_at = datetime('now','localtime','-10 minutes') WHERE id = ?`).run(evId)
    // 反复重放直到熔断（累计 5 次失败转 ignored）
    for (let i = 0; i < 6; i++) await runWebhookRetry()
    const e = db.prepare(`SELECT status, attempts FROM webhook_events WHERE id = ?`).get(evId)
    ok('达上限后转死信 ignored，停止无限重放', e.status === 'ignored' && e.attempts >= 5)
    // 死信事件被重复投递也不再处理（幂等短路）
    r = await webhook('escrow', { eventId: 'poison-1', eventType: 'unknown.poison', data: {} })
    ok('死信事件重复投递被幂等短路（不再处理）', r.data.duplicated === true)
    // 运营手工重放复活：重置重试预算
    r = await api('POST', `/admin/webhook-events/${evId}/replay`, { token: adminToken })
    ok('手工重放复活（attempts 重置后再次失败计为 1）', db.prepare(`SELECT attempts FROM webhook_events WHERE id = ?`).get(evId).attempts === 1)
  }

  console.log('— A1b：裁决自动执行遇结算通道异常，结算重试补齐后争议仍能收尾（不卡 ruled、不误标 executed）—')
  {
    const taskId = await makeHiredTask(2000, { deliver: true })
    let r = await api('POST', `/worker/orders/${taskId}/dispute`, { token: workerToken, body: { type: 'acceptance', claim: '已按标准交付，请平台裁决全额结算', claimAmount: 1840 } })
    const disputeId = r.data.id
    await api('POST', `/admin/disputes/${disputeId}/accept`, { token: adminToken })
    await api('POST', `/admin/disputes/${disputeId}/rule`, { token: adminToken, body: { rulingType: 'full_pay', rulingNote: '交付合格，裁决全额结算' } })
    db.prepare(`UPDATE disputes SET stage_deadline = datetime('now','-2 hours') WHERE id = ?`).run(disputeId)
    _testHooks.failNext.escrow = 1  // 自动执行时首腿分账失败
    await runDisputeTimeouts()
    const dMid = db.prepare(`SELECT status FROM disputes WHERE id = ?`).get(disputeId).status
    const sMid = db.prepare(`SELECT status FROM settlements WHERE task_id = ?`).get(taskId)
    ok('通道异常时争议未误标 executed（保持 ruled，锁未解）', dMid === 'ruled' && sMid && sMid.status !== 'done' &&
      db.prepare(`SELECT dispute_id FROM tasks WHERE id = ?`).get(taskId).dispute_id === disputeId)
    await runSettlementRetry()
    ok('结算重试补齐完成', db.prepare(`SELECT status FROM settlements WHERE task_id = ?`).get(taskId).status === 'done')
    await runDisputeTimeouts()
    const tEnd = db.prepare(`SELECT status, dispute_id FROM tasks WHERE id = ?`).get(taskId)
    ok('结算完成后争议自动收尾 executed、任务 settled、锁解除',
      db.prepare(`SELECT status FROM disputes WHERE id = ?`).get(disputeId).status === 'executed' &&
      tEnd.status === 'settled' && tEnd.dispute_id === null)
  }

  console.log('— #1：并发双 finalize 幂等（陈旧 pending 快照在结算完成后重推，不重复划账、不打回终态）—')
  {
    const taskId = await makeHiredTask(2000, { deliver: true })
    _testHooks.failNext.escrow = 1
    await api('POST', `/company/tasks/${taskId}/accept`, { token: companyToken }).catch(() => {})
    const stale = db.prepare(`SELECT * FROM settlements WHERE task_id = ?`).get(taskId)  // 抓取 pending 陈旧快照
    ok('结算单首次留 pending', stale.status === 'pending')
    await runSettlementRetry()
    ok('结算重试补齐为 done', db.prepare(`SELECT status FROM settlements WHERE id = ?`).get(stale.id).status === 'done')
    const balBefore = db.prepare(`SELECT balance FROM accounts WHERE owner_type='worker' AND owner_id=?`).get(workerId).balance
    const flowsBefore = db.prepare(`SELECT COUNT(*) AS n FROM fund_flows WHERE ref_type='task' AND ref_id=?`).get(taskId).n
    const r = await processSettlement(stale)  // 用陈旧 pending 快照再次推进（模拟手工重推/Job 撞车）
    ok('陈旧快照重推幂等返回 ok', r.ok === true)
    ok('结算单仍为 done（未被打回 pending/failed）', db.prepare(`SELECT status FROM settlements WHERE id = ?`).get(stale.id).status === 'done')
    const balAfter = db.prepare(`SELECT balance FROM accounts WHERE owner_type='worker' AND owner_id=?`).get(workerId).balance
    const flowsAfter = db.prepare(`SELECT COUNT(*) AS n FROM fund_flows WHERE ref_type='task' AND ref_id=?`).get(taskId).n
    ok('未重复划账（零工余额与流水笔数均不变）', balAfter === balBefore && flowsAfter === flowsBefore)
  }

  console.log('— B1：企业被拒后可重新审核通过（修复 rejected 死局）—')
  {
    let r = await api('POST', '/auth/register', { body: { role: 'company', phone: '13600001900', password: PW, name: '李总', companyName: '重审测试公司', licenseNo: '91330106MA2REREV1', industry: '软件信息服务', agree: true } })
    const cid = db.prepare(`SELECT id FROM companies WHERE license_no = '91330106MA2REREV1'`).get().id
    r = await api('POST', `/admin/companies/${cid}/review`, { token: adminToken, body: { pass: false, note: '材料不全，补齐后再审' } })
    ok('企业首次审核被拒', r.data.status === 'rejected')
    r = await api('POST', `/admin/companies/${cid}/review`, { token: adminToken, body: { pass: true, note: '材料已补齐，准予准入' } })
    ok('被拒企业可重新审核通过（非死局）', r.status === 200 && r.data.status === 'approved' && !!r.data.masterContractNo)
  }

  console.log('— B2：企业主不可被停用 + 所有权可转移（修复 owner 死结）—')
  {
    const ownerId = db.prepare(`SELECT user_id FROM company_members WHERE company_id = ? AND member_role = 'owner'`).get(companyId).user_id
    let r = await api('POST', `/admin/users/${ownerId}/disable`, { token: adminToken })
    ok('停用企业主被拒（OWNER_PROTECTED）', r.status === 409 && r.data.error.code === 'OWNER_PROTECTED')
    r = await api('POST', '/company/members', { token: companyToken, body: { phone: '13600001901', name: '新主管', memberRole: 'operator' } })
    const newOwnerUserId = r.data.userId
    r = await api('POST', `/company/members/${newOwnerUserId}/transfer-owner`, { token: companyToken })
    ok('所有权转移成功', r.status === 200 && r.data.newOwnerId === newOwnerUserId)
    ok('新成员成为 owner、原 owner 降为 operator',
      db.prepare(`SELECT member_role FROM company_members WHERE user_id = ?`).get(newOwnerUserId).member_role === 'owner' &&
      db.prepare(`SELECT member_role FROM company_members WHERE user_id = ?`).get(ownerId).member_role === 'operator')
    // 还原：companyToken 恢复 owner 身份，避免影响后续区块
    db.prepare(`UPDATE company_members SET member_role = 'owner' WHERE user_id = ?`).run(ownerId)
    db.prepare(`UPDATE company_members SET member_role = 'operator' WHERE user_id = ?`).run(newOwnerUserId)
  }

  console.log('— B3：技能被拒后可重新申请认证（修复 rejected 永久封死）—')
  {
    let r = await api('POST', '/worker/skills', { token: workerToken, body: { skill: '前端开发', level: '中级' } })
    const skillId = r.data.id
    await api('POST', `/admin/skills/${skillId}/review`, { token: adminToken, body: { pass: false, note: '证书不清晰，请重传' } })
    ok('技能审核被拒', db.prepare(`SELECT status FROM worker_skills WHERE id = ?`).get(skillId).status === 'rejected')
    r = await api('POST', '/worker/skills', { token: workerToken, body: { skill: '前端开发', level: '高级' } })
    ok('被拒技能可重新提交（复用唯一行回到 pending）', r.status === 201 && r.data.id === skillId)
    ok('重新提交后状态为 pending', db.prepare(`SELECT status FROM worker_skills WHERE id = ?`).get(skillId).status === 'pending')
  }

  console.log('— B4：API 凭据停用后可重新启用（修复单向死态）—')
  {
    let r = await api('POST', '/admin/api-credentials', { token: adminToken, body: { companyId } })
    const credId = r.data.id
    await api('POST', `/admin/api-credentials/${credId}/disable`, { token: adminToken })
    ok('凭据已停用', db.prepare(`SELECT status FROM api_credentials WHERE id = ?`).get(credId).status === 'disabled')
    r = await api('POST', `/admin/api-credentials/${credId}/enable`, { token: adminToken })
    ok('停用凭据可重新启用（active↔disabled 双向）', r.status === 200 && r.data.status === 'active')
  }

  console.log('— D3：风控锁不可被个体户登记绕过；阈值锁可自助解除 —')
  {
    let r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13600001910', password: PW, name: '风控锁工', agree: true } })
    const wA = r.data.token, wAId = db.prepare(`SELECT id FROM users WHERE phone = '13600001910'`).get().id
    await api('POST', '/worker/verify', { token: wA, body: { idCard: '330106199002022114', realName: '风控锁工', bankCard: '6217000000002222', consents: ['idcard', 'face', 'bankcard'] } })
    await api('POST', `/admin/workers/${wAId}/lock`, { token: adminToken, body: { lock: true } })
    ok('运营风控锁定零工（lock_reason=risk）', db.prepare(`SELECT lock_reason FROM worker_profiles WHERE user_id = ?`).get(wAId).lock_reason === 'risk')
    r = await api('POST', '/worker/soletrader', { token: wA, body: { licenseNo: '92330106MA2RISK01' } })
    ok('登记个体户后风控锁仍在（不可绕过）', r.data.subjectType === 'soletrader' && r.data.locked === true)

    r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13600001911', password: PW, name: '阈值锁工', agree: true } })
    const wB = r.data.token, wBId = db.prepare(`SELECT id FROM users WHERE phone = '13600001911'`).get().id
    await api('POST', '/worker/verify', { token: wB, body: { idCard: '330106199003033225', realName: '阈值锁工', bankCard: '6217000000003333', consents: ['idcard', 'face', 'bankcard'] } })
    db.prepare(`UPDATE worker_profiles SET locked = 1, lock_reason = 'threshold' WHERE user_id = ?`).run(wBId)
    r = await api('POST', '/worker/soletrader', { token: wB, body: { licenseNo: '92330106MA2THRE01' } })
    ok('阈值锁登记个体户后自助解锁', r.data.subjectType === 'soletrader' && r.data.locked === false)
  }

  console.log('— D8：理赔结案后不可重新打开（修复 closed→processing 回退）—')
  {
    const taskId = await makeHiredTask(2000)  // working，录用即有保单
    let r = await api('POST', '/worker/claims', { token: workerToken, body: { taskId, description: '作业中手部受伤已就医' } })
    const claimId = r.data.id
    await api('POST', `/admin/claims/${claimId}/process`, { token: adminToken, body: { status: 'closed', result: '保险公司已赔付' } })
    ok('理赔结案', db.prepare(`SELECT status FROM claims WHERE id = ?`).get(claimId).status === 'closed')
    r = await api('POST', `/admin/claims/${claimId}/process`, { token: adminToken, body: { status: 'processing' } })
    ok('已结案理赔不可重新打开（CLAIM_CLOSED）', r.status === 409 && r.data.error.code === 'CLAIM_CLOSED')
  }

  console.log(`\n✅ 第二轮审计修复回归测试 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message, '\n', err.stack)
  server.close()
  process.exit(1)
}
