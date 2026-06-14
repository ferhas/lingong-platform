import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import db from '../db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { requireCompanyRole, getMembership } from '../middleware/rbac.js'
import { badRequest, notFound, forbidden, conflict } from '../utils/errors.js'
import { yuanToCents, centsToYuan, mulRate } from '../utils/money.js'
import { genNo, sha256, genTempPassword, currentDate } from '../utils/ids.js'
import { renderContract } from '../services/contractText.js'
import { pageParams } from '../utils/pagination.js'
import * as accounts from '../services/accounts.js'
import * as risk from '../services/risk.js'
import { acceptAndSettle } from '../services/settlement.js'
import { hireWorker } from '../services/hiring.js'
import { getConfig } from '../services/configStore.js'
import { CATEGORY_TRADES, tradesForCategory, allTrades } from '../services/taxonomy.js'
import { notify, notifyMany } from '../services/notify.js'
import { logAction } from '../services/audit.js'
import { esign, escrow } from '../integrations/index.js'
import { readableText } from '../utils/textQuality.js'
import { handleRechargePaid } from '../services/escrowEvents.js'
import { createDispute } from '../services/disputes.js'
import { submitReview, getTaskReviews, workerCreditProfile } from '../services/credit.js'
import { companyStatement } from '../services/finance.js'

const router = Router()
router.use(authenticate, requireRole('company'))

function myCompany(req) {
  const m = getMembership(req.user.id)
  if (!m) throw notFound('企业不存在')
  const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(m.company_id)
  if (!c) throw notFound('企业不存在')
  return c
}

function requireApproved(c) {
  if (c.status !== 'approved') {
    throw forbidden(c.status === 'pending' ? '企业资质审核中，审核通过后方可操作' : `企业准入被拒绝：${c.review_note || ''}`)
  }
}

function taskAttachments(taskId) {
  return db.prepare(`
    SELECT u.id, u.original_name AS name, u.mime, u.size, a.kind
    FROM task_attachments a JOIN uploads u ON u.id = a.upload_id WHERE a.task_id = ?
  `).all(taskId).map(f => ({ ...f, url: `/api/v1/files/${f.id}` }))
}

const taskView = t => ({
  id: t.id, title: t.title, category: t.category, trade: t.trade ?? undefined, city: t.city,
  payMethod: t.pay_method, price: centsToYuan(t.price), subPrice: centsToYuan(t.sub_price),
  deadline: t.deadline, description: t.description, standard: t.standard,
  status: t.status, workerId: t.worker_id, workerName: t.worker_name ?? undefined,
  taskOrderNo: t.task_order_no, subOrderNo: t.sub_order_no, policyNo: t.policy_no,
  deliverable: t.deliverable, deliverableData: t.deliverable_data ? JSON.parse(t.deliverable_data) : null,
  deliveredAt: t.delivered_at,
  confirmNo: t.confirm_no, settledAt: t.settled_at, createdAt: t.created_at
})

// —— 档案与资金 ——
router.get('/profile', (req, res) => {
  const c = myCompany(req)
  const m = getMembership(req.user.id)
  const acc = accounts.getAccount('company', c.id)
  res.json({
    companyName: c.company_name, licenseNo: c.license_no, industry: c.industry,
    contactPhone: c.contact_phone, contactEmail: c.contact_email,
    status: c.status, reviewNote: c.review_note, masterContractNo: c.master_contract_no,
    esignAuthorized: !!c.esign_authorized,
    memberRole: m.member_role,
    account: {
      balance: centsToYuan(acc.balance),
      frozen: centsToYuan(acc.frozen),
      available: centsToYuan(acc.balance - acc.frozen)
    }
  })
})

router.patch('/profile', requireCompanyRole('owner'), (req, res, next) => {
  try {
    const patch = z.object({
      contactPhone: z.string().max(20).optional(),
      contactEmail: z.string().email('邮箱格式不正确').max(60).optional()
    }).parse(req.body)
    const c = myCompany(req)
    db.prepare(`UPDATE companies SET contact_phone = COALESCE(?, contact_phone), contact_email = COALESCE(?, contact_email) WHERE id = ?`)
      .run(patch.contactPhone ?? null, patch.contactEmail ?? null, c.id)
    logAction(req.user.id, 'update_company_profile', JSON.stringify(patch))
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// [兼容保留] 一步充值（开发/演示态）；商用充值请使用充值单收银台（/recharge-orders）
// 生产环境禁用：真实入金必须经银行回调驱动（绕过会与"余额=银行子户镜像"不变量冲突、污染对账）。
router.post('/recharge', requireCompanyRole('owner', 'finance'), async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') throw forbidden('生产环境请使用充值单收银台（/recharge-orders），入金由存管银行回调确认')
    const { amount } = z.object({ amount: z.number().positive().max(10_000_000) }).parse(req.body)
    const c = myCompany(req)
    requireApproved(c)
    const cents = yuanToCents(amount)
    await escrow.transfer({ from: `bank:company:${c.id}`, to: `escrow:company:${c.id}`, amountCents: cents, purpose: '企业存管户充值' })
    const acc = accounts.recharge('company', c.id, cents, '存管户充值（银行存管虚拟户）')
    logAction(req.user.id, 'recharge', `¥${amount}`)
    res.json({ balance: centsToYuan(acc.balance), available: centsToYuan(acc.balance - acc.frozen) })
  } catch (err) {
    next(err)
  }
})

// —— 充值单收银台（真实资金闭环）——
// 创建充值单获取专属入金账户 → 企业对公转账 → 银行入金回调（/webhooks/escrow）确认到账后入账
router.post('/recharge-orders', requireCompanyRole('owner', 'finance'), async (req, res, next) => {
  try {
    const { amount } = z.object({ amount: z.number().positive().max(10_000_000) }).parse(req.body)
    const c = myCompany(req)
    requireApproved(c)
    const cents = yuanToCents(amount)
    const orderNo = genNo('CZ')
    const cashier = await escrow.cashier({ companyId: c.id, orderNo, amountCents: cents })
    db.prepare(`
      INSERT INTO recharge_orders (no, company_id, amount, pay_account, created_by) VALUES (?, ?, ?, ?, ?)
    `).run(orderNo, c.id, cents, cashier.payAccount, req.user.id)
    logAction(req.user.id, 'recharge_order_create', `${orderNo} ¥${amount}`)
    res.status(201).json({
      orderNo,
      no: orderNo, // 与列表接口字段名(no)对齐，避免同概念双名导致重构踩坑
      amount,
      payAccount: cashier.payAccount,
      payBank: cashier.payBank,
      payee: cashier.payee,
      expireMinutes: getConfig('rechargeOrderExpireMinutes'),
      note: '请使用企业对公账户向上述专属账户转账，金额须与充值单一致；银行确认入金后自动到账（通常分钟级）'
    })
  } catch (err) {
    next(err)
  }
})

router.get('/recharge-orders', (req, res) => {
  const c = myCompany(req)
  const list = db.prepare(`SELECT * FROM recharge_orders WHERE company_id = ? ORDER BY id DESC LIMIT 50`).all(c.id)
  res.json({
    total: list.length,
    list: list.map(o => ({
      no: o.no, amount: centsToYuan(o.amount), payAccount: o.pay_account,
      status: o.status, escrowTxnNo: o.escrow_txn_no, createdAt: o.created_at, paidAt: o.paid_at
    }))
  })
})

// 模拟入金（仅非生产环境：联调收银台流程用，生产由银行 webhook 驱动）
router.post('/recharge-orders/:no/mock-pay', requireCompanyRole('owner', 'finance'), (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') throw forbidden('生产环境入金由存管银行回调确认')
    const c = myCompany(req)
    const order = db.prepare(`SELECT * FROM recharge_orders WHERE no = ? AND company_id = ?`).get(req.params.no, c.id)
    if (!order) throw notFound('充值单不存在')
    const r = handleRechargePaid({ orderNo: order.no, escrowTxnNo: null, amount: order.amount })
    logAction(req.user.id, 'recharge_mock_pay', order.no)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

// —— 电子签静默签授权（一次性有感意愿认证，企业审核通过后完成；此后工单全部 API 静默落章）——
router.post('/esign-auth', requireCompanyRole('owner'), async (req, res, next) => {
  try {
    const c = myCompany(req)
    requireApproved(c)
    if (c.esign_authorized) throw conflict('ALREADY_AUTHORIZED', '已完成电子签授权')
    const auth = await esign.authorize({ subjectType: 'company', subjectName: c.company_name })
    db.prepare(`UPDATE companies SET esign_authorized = 1, esign_auth_at = datetime('now','localtime') WHERE id = ?`).run(c.id)
    db.prepare(`INSERT INTO agreements (user_id, doc_type, version) VALUES (?, 'esign_silent_auth', 1)`).run(req.user.id)
    logAction(req.user.id, 'esign_authorize', auth.authId)
    res.json({ authorized: true, authId: auth.authId })
  } catch (err) {
    next(err)
  }
})

// —— 企业月结单（对账单下载：充值/消耗/发票/期末余额）——
router.get('/statement', (req, res, next) => {
  try {
    const c = myCompany(req)
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : new Date().toISOString().slice(0, 7)
    res.json(companyStatement(c.id, period))
  } catch (err) {
    next(err)
  }
})

// —— 零工邀请码（冷启动：企业定向邀请存量合作者注册并绑定关系）——
router.get('/invite-code', requireCompanyRole('owner', 'operator'), (req, res) => {
  const c = myCompany(req)
  let code = c.invite_code
  if (!code) {
    code = 'INV' + String(c.id).padStart(4, '0') + genNo('').slice(-4)
    db.prepare(`UPDATE companies SET invite_code = ? WHERE id = ?`).run(code, c.id)
  }
  const invited = db.prepare(`SELECT COUNT(*) AS n FROM worker_profiles WHERE invited_by_company_id = ?`).get(c.id).n
  res.json({ inviteCode: code, invitedWorkers: invited })
})

router.get('/flows', (req, res) => {
  const c = myCompany(req)
  const acc = accounts.getAccount('company', c.id)
  const { page, pageSize } = pageParams(req)
  const { list, total } = accounts.listFlows(acc.id, page, pageSize)
  res.json({
    total,
    list: list.map(f => ({
      id: f.id, type: f.type, amount: centsToYuan(f.amount),
      balanceAfter: centsToYuan(f.balance_after), remark: f.remark, createdAt: f.created_at
    }))
  })
})

// —— 成员管理（仅 owner）——
router.get('/members', (req, res) => {
  const c = myCompany(req)
  const list = db.prepare(`
    SELECT m.user_id, m.member_role, m.created_at, u.name, u.phone, u.status
    FROM company_members m JOIN users u ON u.id = m.user_id
    WHERE m.company_id = ? ORDER BY m.created_at
  `).all(c.id)
  res.json({
    total: list.length,
    list: list.map(m => ({
      userId: m.user_id, name: m.name, phone: m.phone,
      memberRole: m.member_role, status: m.status, createdAt: m.created_at
    }))
  })
})

router.post('/members', requireCompanyRole('owner'), (req, res, next) => {
  try {
    const body = z.object({
      phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确'),
      name: readableText('成员姓名', z.string().min(1).max(30)),
      memberRole: z.enum(['operator', 'finance'])
    }).parse(req.body)
    const c = myCompany(req)
    const exists = db.prepare(`SELECT id FROM users WHERE phone = ?`).get(body.phone)
    if (exists) throw conflict('PHONE_EXISTS', '该手机号已注册')

    // 生成临时密码（owner 线下告知成员，成员首次登录后应修改）
    const tempPassword = genTempPassword()
    const txn = db.transaction(() => {
      const { lastInsertRowid: userId } = db.prepare(
        `INSERT INTO users (role, phone, password_hash, name) VALUES ('company', ?, ?, ?)`
      ).run(body.phone, bcrypt.hashSync(tempPassword, 10), body.name)
      db.prepare(`INSERT INTO company_members (user_id, company_id, member_role) VALUES (?, ?, ?)`)
        .run(userId, c.id, body.memberRole)
      return userId
    })
    const userId = txn()
    logAction(req.user.id, 'member_create', `user#${userId} role=${body.memberRole}`)
    notify(userId, 'member', '您已加入企业', `您已被添加为「${c.company_name}」的${body.memberRole === 'finance' ? '财务' : '运营'}成员。`)
    res.status(201).json({ userId, tempPassword })
  } catch (err) {
    next(err)
  }
})

// 任务发布元数据（类目/计酬方式/地点/工种，实时读配置）
// categoryTrades 提供「类目→工种」级联数据；offlineCategories 用于前端动态展示高保额提示与"线下不可远程"校验。
router.get('/meta', (_req, res) => {
  res.json({
    categories: getConfig('categories'),
    payMethods: getConfig('payMethods'),
    cities: getConfig('cities'),
    trades: allTrades(),
    categoryTrades: CATEGORY_TRADES,
    offlineCategories: getConfig('offlineCategories')
  })
})

// 改成员角色（仅 owner；owner 自身角色不可改）
router.patch('/members/:userId', requireCompanyRole('owner'), (req, res, next) => {
  try {
    const { memberRole } = z.object({ memberRole: z.enum(['operator', 'finance']) }).parse(req.body)
    const c = myCompany(req)
    const m = db.prepare(`SELECT * FROM company_members WHERE user_id = ? AND company_id = ?`).get(req.params.userId, c.id)
    if (!m) throw notFound('成员不存在')
    if (m.member_role === 'owner') throw badRequest('CANNOT_CHANGE_OWNER', '不能修改企业主账号的角色')
    db.prepare(`UPDATE company_members SET member_role = ? WHERE user_id = ?`).run(memberRole, m.user_id)
    logAction(req.user.id, 'member_role_change', `user#${m.user_id} → ${memberRole}`)
    notify(m.user_id, 'member', '成员角色已变更', `您在「${c.company_name}」的角色已调整为${memberRole === 'finance' ? '财务' : '运营'}。`)
    res.json({ memberRole })
  } catch (err) {
    next(err)
  }
})

router.delete('/members/:userId', requireCompanyRole('owner'), (req, res, next) => {
  try {
    const c = myCompany(req)
    const m = db.prepare(`SELECT * FROM company_members WHERE user_id = ? AND company_id = ?`).get(req.params.userId, c.id)
    if (!m) throw notFound('成员不存在')
    if (m.member_role === 'owner') throw badRequest('CANNOT_REMOVE_OWNER', '不能移除企业主账号')
    db.transaction(() => {
      db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(m.user_id)
    })()
    logAction(req.user.id, 'member_disable', `user#${m.user_id}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// 转移企业所有权（仅 owner）：owner 身份转给某在职成员，自身降为 operator。
// 解决"owner 不可转移/降级，一旦 owner 账号不可用企业即瘫痪"的死结。
router.post('/members/:userId/transfer-owner', requireCompanyRole('owner'), (req, res, next) => {
  try {
    const c = myCompany(req)
    const target = db.prepare(`SELECT * FROM company_members WHERE user_id = ? AND company_id = ?`).get(req.params.userId, c.id)
    if (!target) throw notFound('成员不存在')
    if (target.member_role === 'owner') throw badRequest('ALREADY_OWNER', '该成员已是企业主')
    const targetUser = db.prepare(`SELECT status FROM users WHERE id = ?`).get(target.user_id)
    if (!targetUser || targetUser.status !== 'active') throw badRequest('TARGET_INACTIVE', '目标成员账号未激活，不可转移所有权')
    db.transaction(() => {
      db.prepare(`UPDATE company_members SET member_role = 'operator' WHERE user_id = ? AND company_id = ?`).run(req.user.id, c.id)
      db.prepare(`UPDATE company_members SET member_role = 'owner' WHERE user_id = ? AND company_id = ?`).run(target.user_id, c.id)
    })()
    logAction(req.user.id, 'transfer_owner', `company#${c.id} owner#${req.user.id} → user#${target.user_id}`)
    notify(target.user_id, 'member', '您已成为企业主', `「${c.company_name}」的所有权已转移给您，您现在是企业主（owner），原企业主已降为运营成员。`)
    res.json({ ok: true, newOwnerId: target.user_id })
  } catch (err) {
    next(err)
  }
})

// —— 按单税负测算（方案模块6：承接前测算毛利，低于安全线预警）——
function platformEstimate(priceCents, category) {
  const marginRate = getConfig('platformMarginRate')
  const offlineCategories = getConfig('offlineCategories')
  const safeMarginRate = getConfig('safeMarginRate')
  const subPrice = mulRate(priceCents, 1 - marginRate)
  const grossMargin = priceCents - subPrice
  // 平台销项 6%（自然人零工无进项抵扣，按全额估算）+ 附加税约 12%
  const outputVat = mulRate(priceCents, 0.06)
  const surtax = mulRate(outputVat, 0.12)
  const insurance = (offlineCategories.includes(category) ? getConfig('insurancePremiumHigh') : getConfig('insurancePremiumBase')) * 100
  const netMargin = grossMargin - outputVat - surtax - insurance
  const netMarginRate = priceCents > 0 ? netMargin / priceCents : 0
  return { subPrice, grossMargin, outputVat, surtax, insurance, netMargin, netMarginRate, safe: netMarginRate >= safeMarginRate }
}

// 发布前测算预览（企业端发布页展示，降低理解成本）
router.get('/estimate', (req, res, next) => {
  try {
    const price = yuanToCents(Number(req.query.price))
    if (!price || price <= 0) throw badRequest('BAD_PRICE', '请提供有效金额')
    const e = platformEstimate(price, String(req.query.category || ''))
    res.json({
      price: centsToYuan(price),
      subPrice: centsToYuan(e.subPrice),
      platformFee: centsToYuan(e.grossMargin),
      estimatedVat: centsToYuan(e.outputVat + e.surtax),
      insurance: centsToYuan(e.insurance),
      safe: e.safe,
      note: '分包报酬为零工税前所得；平台向贵司全额开具6%增值税发票，可作税前扣除凭证'
    })
  } catch (err) {
    next(err)
  }
})

// —— 任务 ——
const publishSchema = z.object({
  title: readableText('任务标题', z.string().min(2).max(80)),
  category: readableText('任务类目', z.string()),
  trade: readableText('工种', z.string()).optional(),
  city: z.string().max(20).optional().default('远程'),
  payMethod: readableText('计酬方式', z.string()),
  price: z.number().positive().max(1_000_000),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '截止日期格式应为 YYYY-MM-DD'),
  description: readableText('任务描述', z.string().min(5).max(2000)),
  standard: readableText('交付标准', z.string().max(2000).optional().default(''))
})

/** 发布单个任务（单发与批量发单共用）：合规校验 → 电子签工单 → 冻结预算 */
async function publishTask(c, userId, body) {
  const categories = getConfig('categories')
  if (!categories.includes(body.category)) {
    throw badRequest('BAD_CATEGORY', `任务类目仅支持：${categories.join('/')}`)
  }
  const cities = getConfig('cities')
  const city = body.city || '远程'
  if (!cities.includes(city)) {
    throw badRequest('BAD_CITY', `任务地点仅支持：${cities.join('/')}`)
  }
  // 线下作业类目（配送/安装/施工）必须落到具体城市，不能为"远程"——否则按类目触发的高保额投保与属地匹配失去依据
  const offlineCategories = getConfig('offlineCategories')
  if (offlineCategories.includes(body.category) && city === '远程') {
    throw badRequest('OFFLINE_NEEDS_CITY', `「${body.category}」属于线下作业类目，请选择具体工作城市（不能为"远程"）`)
  }
  if (body.trade) {
    const allowed = tradesForCategory(body.category)
    if (!allowed.includes(body.trade)) {
      throw badRequest('BAD_TRADE', allowed.length
        ? `「${body.category}」类目下的工种仅支持：${allowed.join('/')}`
        : `「${body.category}」类目暂无细分工种，请将工种留空`)
    }
  }

  // 风控：计酬方式 + 违禁词（命中即阻断并产生预警）
  risk.checkPublish({
    title: body.title, description: body.description,
    payMethod: body.payMethod, companyName: c.company_name, companyId: c.id
  })

  const price = yuanToCents(body.price)
  const subPrice = mulRate(price, 1 - getConfig('platformMarginRate'))
  const taskOrderNo = genNo('GD')

  const signed = await esign.sign({
    docType: 'work_order',
    parties: [c.company_name, '平台'],
    contentHash: sha256({ taskOrderNo, title: body.title, price })
  })

  const orderContent = renderContract('work_order', {
    partyA: c.company_name, contractNo: taskOrderNo, date: currentDate(),
    taskTitle: body.title, category: body.category, payMethod: body.payMethod,
    price: body.price.toFixed(2), deadline: body.deadline,
    standard: body.standard || '见任务描述', hash: signed.contentHash
  })
  const taskId = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tasks (company_id, title, category, trade, city, pay_method, price, sub_price, deadline, description, standard, task_order_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.id, body.title, body.category, body.trade ?? null, city, body.payMethod, price, subPrice, body.deadline, body.description, body.standard, taskOrderNo)
    accounts.freeze('company', c.id, price, lastInsertRowid, `发布任务冻结：${body.title}`)
    db.prepare(`
      INSERT INTO contracts (type, no, party_a, party_b, company_id, task_id, content_hash, esign_id, content)
      VALUES ('work_order', ?, ?, '平台', ?, ?, ?, ?, ?)
    `).run(taskOrderNo, c.company_name, c.id, lastInsertRowid, signed.contentHash, signed.esignId, orderContent)
    return lastInsertRowid
  })()

  // 按单税负测算安全线（方案模块6）：净毛利率低于安全线产生预警（不阻断）
  const estimate = platformEstimate(price, body.category)
  if (!estimate.safe) {
    risk.raiseAlert('中', '税负安全线',
      `企业「${c.company_name}」任务「${body.title}」承揽价 ¥${body.price}，平台净毛利率 ${(estimate.netMarginRate * 100).toFixed(2)}% 低于安全线 ${(getConfig('safeMarginRate') * 100).toFixed(1)}%，请关注定价`, 'company', c.id)
  }

  logAction(userId, 'task_publish', `task#${taskId} ¥${body.price}`)
  return { id: taskId, workOrderNo: taskOrderNo, frozen: body.price }
}

router.post('/tasks', requireCompanyRole('owner', 'operator'), async (req, res, next) => {
  try {
    const c = myCompany(req)
    requireApproved(c)
    const body = publishSchema.parse(req.body)
    res.status(201).json(await publishTask(c, req.user.id, body))
  } catch (err) {
    next(err)
  }
})

// 批量发单（≤50条，逐行复用发布校验，返回逐行成败报告；任一行失败不影响其他行）
router.post('/tasks/batch', requireCompanyRole('owner', 'operator'), async (req, res, next) => {
  try {
    const c = myCompany(req)
    requireApproved(c)
    const { items } = z.object({ items: z.array(z.any()).min(1).max(50) }).parse(req.body)
    const results = []
    for (let i = 0; i < items.length; i++) {
      try {
        const body = publishSchema.parse(items[i])
        const r = await publishTask(c, req.user.id, body)
        results.push({ row: i + 1, ok: true, id: r.id, workOrderNo: r.workOrderNo })
      } catch (err) {
        const message = err.issues
          ? err.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('；')
          : err.message
        results.push({ row: i + 1, ok: false, error: message })
      }
    }
    const success = results.filter(r => r.ok).length
    logAction(req.user.id, 'task_batch_publish', `${success}/${items.length}`)
    res.status(201).json({ total: items.length, success, failed: items.length - success, results })
  } catch (err) {
    next(err)
  }
})

router.get('/tasks', (req, res) => {
  const c = myCompany(req)
  const { page, pageSize, offset } = pageParams(req)
  const conds = [`t.company_id = ?`]
  const params = [c.id]
  if (req.query.status && req.query.status !== 'all') { conds.push(`t.status = ?`); params.push(req.query.status) }
  if (req.query.keyword) { conds.push(`t.title LIKE ?`); params.push(`%${req.query.keyword}%`) }
  const where = conds.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where}`).get(...params).n
  const list = db.prepare(`
    SELECT t.*, u.name AS worker_name,
           (SELECT COUNT(*) FROM applications a WHERE a.task_id = t.id AND a.status != 'withdrawn') AS applicant_count
    FROM tasks t LEFT JOIN users u ON u.id = t.worker_id
    WHERE ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)
  res.json({ total, list: list.map(t => ({ ...taskView(t), applicants: t.applicant_count })) })
})

router.get('/tasks/:id', (req, res, next) => {
  try {
    const c = myCompany(req)
    const t = db.prepare(`
      SELECT t.*, u.name AS worker_name FROM tasks t LEFT JOIN users u ON u.id = t.worker_id
      WHERE t.id = ? AND t.company_id = ?
    `).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    const applications = db.prepare(`
      SELECT a.id, a.worker_id, a.status, a.created_at, a.source, u.name, p.verified, p.subject_type
      FROM applications a JOIN users u ON u.id = a.worker_id
      JOIN worker_profiles p ON p.user_id = a.worker_id
      WHERE a.task_id = ? AND a.status != 'withdrawn' ORDER BY a.id
    `).all(t.id)
    const dispatches = db.prepare(`
      SELECT d.id, d.worker_id, d.status, d.note, d.reject_reason, d.created_at, d.responded_at, COALESCE(p.real_name, u.name) AS name
      FROM dispatches d JOIN users u ON u.id = d.worker_id JOIN worker_profiles p ON p.user_id = d.worker_id
      WHERE d.task_id = ? ORDER BY d.id DESC
    `).all(t.id)
    res.json({
      ...taskView(t),
      attachments: taskAttachments(t.id),
      applications: applications.map(a => ({
        id: a.id, workerId: a.worker_id, workerName: a.name,
        verified: !!a.verified, subjectType: a.subject_type,
        credit: workerCreditProfile(a.worker_id),
        status: a.status, source: a.source, createdAt: a.created_at
      })),
      dispatches: dispatches.map(d => ({
        id: d.id, workerId: d.worker_id, workerName: d.name, status: d.status,
        note: d.note, rejectReason: d.reject_reason, createdAt: d.created_at, respondedAt: d.responded_at
      }))
    })
  } catch (err) {
    next(err)
  }
})

router.post('/tasks/:id/hire', requireCompanyRole('owner', 'operator'), async (req, res, next) => {
  try {
    const c = myCompany(req)
    const { workerId } = z.object({ workerId: z.number().int().positive() }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    if (t.status !== 'recruiting') throw conflict('BAD_STATUS', '该任务不在报名阶段')
    const app = db.prepare(`SELECT * FROM applications WHERE task_id = ? AND worker_id = ? AND status != 'withdrawn'`).get(t.id, workerId)
    if (!app) throw badRequest('NO_APPLICATION', '该零工未报名此任务')

    const result = await hireWorker(t, c, workerId)
    logAction(req.user.id, 'task_hire', `task#${t.id} worker#${workerId}`)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// —— 派单（定向派单）——
// 与"报名→录用"互补：企业向已合作/已邀约的零工定向派单，零工接受后成立承揽关系。
// 候选范围限定为：该企业历史录用过的零工 ∪ 该企业邀请码邀请注册的零工（避免按手机号枚举他人）。
router.get('/dispatch/candidates', requireCompanyRole('owner', 'operator'), (req, res) => {
  const c = myCompany(req)
  const kw = req.query.keyword ? `%${String(req.query.keyword)}%` : null
  const rows = db.prepare(`
    SELECT u.id AS worker_id, COALESCE(p.real_name, u.name) AS name, p.verified, p.locked,
           p.subject_type, p.credit_score,
           (SELECT COUNT(*) FROM tasks t2 WHERE t2.worker_id = u.id AND t2.company_id = ?) AS hired_count,
           (SELECT MAX(t3.id) FROM tasks t3 WHERE t3.worker_id = u.id AND t3.company_id = ?) AS last_task_id
    FROM users u JOIN worker_profiles p ON p.user_id = u.id
    WHERE p.verified = 1 AND (
      p.invited_by_company_id = ?
      OR EXISTS (SELECT 1 FROM tasks t WHERE t.worker_id = u.id AND t.company_id = ?)
    )
    ${kw ? `AND COALESCE(p.real_name, u.name) LIKE ?` : ''}
    ORDER BY hired_count DESC, u.id DESC LIMIT 50
  `).all(...(kw ? [c.id, c.id, c.id, c.id, kw] : [c.id, c.id, c.id, c.id]))
  res.json({
    list: rows.map(r => ({
      workerId: r.worker_id, name: r.name, verified: !!r.verified, locked: !!r.locked,
      subjectType: r.subject_type, creditScore: r.credit_score, hiredCount: r.hired_count
    }))
  })
})

router.post('/tasks/:id/dispatch', requireCompanyRole('owner', 'operator'), (req, res, next) => {
  try {
    const c = myCompany(req)
    requireApproved(c)
    const { workerId, note } = z.object({
      workerId: z.number().int().positive(),
      note: readableText('派单留言', z.string().max(200)).optional().default('')
    }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    if (t.status !== 'recruiting') throw conflict('BAD_STATUS', '仅报名中的任务可派单')

    // 候选校验：仅可派给历史合作或本企业邀请的、已实名未锁定的零工
    const cand = db.prepare(`
      SELECT u.id, COALESCE(p.real_name, u.name) AS name, p.verified, p.locked, p.invited_by_company_id
      FROM users u JOIN worker_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'worker'
    `).get(workerId)
    if (!cand) throw notFound('零工不存在')
    if (!cand.verified) throw badRequest('WORKER_NOT_VERIFIED', '该零工未完成实名认证')
    if (cand.locked) throw badRequest('WORKER_LOCKED', '该零工接单权限已锁定')
    const cooperated = db.prepare(`SELECT 1 FROM tasks WHERE worker_id = ? AND company_id = ?`).get(workerId, c.id)
    if (!cooperated && cand.invited_by_company_id !== c.id) {
      throw badRequest('NOT_CANDIDATE', '仅可向曾合作或本企业邀请的零工派单')
    }

    const existing = db.prepare(`SELECT * FROM dispatches WHERE task_id = ? AND worker_id = ?`).get(t.id, workerId)
    // 进行中的派单（待接受 invited 或已接受 accepted）不可重复派；仅 rejected/cancelled 可改派
    if (existing && (existing.status === 'invited' || existing.status === 'accepted')) {
      throw conflict('ALREADY_DISPATCHED', '已向该零工派单或其已接受，无需重复派单')
    }

    db.transaction(() => {
      if (existing) {
        db.prepare(`UPDATE dispatches SET status = 'invited', note = ?, reject_reason = NULL, responded_at = NULL, created_at = datetime('now','localtime') WHERE id = ?`).run(note, existing.id)
      } else {
        db.prepare(`INSERT INTO dispatches (task_id, worker_id, company_id, note) VALUES (?, ?, ?, ?)`).run(t.id, workerId, c.id, note)
      }
    })()

    logAction(req.user.id, 'task_dispatch', `task#${t.id} worker#${workerId}`)
    notify(workerId, 'dispatch', '收到派单邀约', `企业「${c.company_name}」向您定向派单「${t.title}」，分包报酬 ¥${centsToYuan(t.sub_price)}${note ? `。留言：${note}` : ''}。请在接单中心确认接受或拒绝。`)
    res.status(201).json({ dispatched: true })
  } catch (err) {
    next(err)
  }
})

router.post('/tasks/:id/accept', requireCompanyRole('owner', 'operator'), async (req, res, next) => {
  try {
    const c = myCompany(req)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    const result = await acceptAndSettle(t, c)
    logAction(req.user.id, 'task_accept', `task#${t.id} ${result.confirmNo}`)
    res.json({
      confirmNo: result.confirmNo,
      invoice: { ...result.invoice, amount: centsToYuan(result.invoice.amount) },
      settlement: {
        workerNet: centsToYuan(result.settlement.workerNet),
        tax: centsToYuan(result.settlement.tax),
        vat: centsToYuan(result.settlement.vat),
        platformFee: centsToYuan(result.settlement.platformFee)
      }
    })
  } catch (err) {
    next(err)
  }
})

router.post('/tasks/:id/reject', requireCompanyRole('owner', 'operator'), (req, res, next) => {
  try {
    const c = myCompany(req)
    const { reason } = z.object({ reason: readableText('驳回理由', z.string().min(1).max(500)) }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    if (t.status !== 'delivered') throw conflict('BAD_STATUS', '当前状态不可驳回')
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET status = 'working', deliverable = NULL, deliverable_data = NULL, delivered_at = NULL WHERE id = ?`).run(t.id)
      db.prepare(`DELETE FROM task_attachments WHERE task_id = ? AND kind = 'deliverable'`).run(t.id)
    })()
    logAction(req.user.id, 'task_reject', `task#${t.id}：${reason}`)
    notify(t.worker_id, 'rejected', '交付被驳回', `「${t.title}」交付未通过验收：${reason}。请修改后重新提交（成果不合格不计酬）。`)
    res.json({ status: 'working' })
  } catch (err) {
    next(err)
  }
})

// 取消任务（仅报名中）：解冻资金、通知报名者
router.post('/tasks/:id/cancel', requireCompanyRole('owner', 'operator'), (req, res, next) => {
  try {
    const c = myCompany(req)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    if (t.status !== 'recruiting') throw conflict('BAD_STATUS', '仅报名中的任务可取消（已录用任务请联系平台协商处理）')

    const applicants = db.prepare(`SELECT worker_id FROM applications WHERE task_id = ? AND status = 'applied'`).all(t.id)
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run(t.id)
      accounts.unfreeze('company', c.id, t.price, t.id, `取消任务解冻：${t.title}`)
      db.prepare(`UPDATE applications SET status = 'rejected' WHERE task_id = ? AND status = 'applied'`).run(t.id)
    })()

    logAction(req.user.id, 'task_cancel', `task#${t.id}`)
    notifyMany(applicants.map(a => a.worker_id), 'cancelled', '任务已取消', `您报名的「${t.title}」已被发布企业取消。`)
    res.json({ status: 'cancelled', unfrozen: centsToYuan(t.price) })
  } catch (err) {
    next(err)
  }
})

// —— 争议：发起（零工失联/结算后质量争议等）——
router.post('/tasks/:id/dispute', requireCompanyRole('owner', 'operator'), (req, res, next) => {
  try {
    const body = z.object({
      type: z.enum(['worker_missing', 'quality_after', 'other']),
      claim: readableText('诉求描述', z.string().min(10, '请描述诉求（不少于10个字）').max(1000)),
      claimAmount: z.number().min(0).optional().default(0),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    }).parse(req.body)
    const c = myCompany(req)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    const r = createDispute({
      task: t, type: body.type, initiatorRole: 'company', initiatorId: req.user.id,
      claim: body.claim, claimAmount: yuanToCents(body.claimAmount), attachmentIds: body.attachmentIds
    })
    logAction(req.user.id, 'dispute_create', `${r.no} task#${t.id}`)
    res.status(201).json(r)
  } catch (err) {
    next(err)
  }
})

// —— 评价（结算后互盲互评：企业评零工影响其信用分）——
router.post('/tasks/:id/review', requireCompanyRole('owner', 'operator'), (req, res, next) => {
  try {
    const body = z.object({
      score: z.number().int().min(1).max(5),
      tags: z.array(z.string()).max(6).optional().default([]),
      comment: readableText('评价内容', z.string().max(300).optional().default(''))
    }).parse(req.body)
    const c = myCompany(req)
    const t = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    submitReview({
      taskId: Number(req.params.id), reviewerRole: 'company', reviewerId: req.user.id,
      score: body.score, tags: body.tags, comment: body.comment
    })
    logAction(req.user.id, 'review_submit', `task#${req.params.id} score=${body.score}`)
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.get('/tasks/:id/reviews', (req, res, next) => {
  try {
    const c = myCompany(req)
    const t = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, c.id)
    if (!t) throw notFound('任务不存在')
    res.json(getTaskReviews(Number(req.params.id), 'company'))
  } catch (err) {
    next(err)
  }
})

// —— 统计（仪表盘图表）——
router.get('/stats/trend', (req, res) => {
  const c = myCompany(req)
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30))
  const rows = db.prepare(`
    SELECT substr(settled_at, 1, 10) AS day, COUNT(*) AS tasks, SUM(price) AS amount
    FROM tasks WHERE company_id = ? AND status = 'settled' AND settled_at >= date('now', 'localtime', ?)
    GROUP BY day ORDER BY day
  `).all(c.id, `-${days} days`)
  const statusRows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM tasks WHERE company_id = ? GROUP BY status
  `).all(c.id)
  res.json({
    trend: rows.map(r => ({ day: r.day, tasks: r.tasks, amount: centsToYuan(r.amount) })),
    statusDist: statusRows.map(r => ({ status: r.status, count: r.n }))
  })
})

// —— 发票与合同 ——
router.get('/invoices', (req, res) => {
  const c = myCompany(req)
  const { pageSize, offset } = pageParams(req)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE company_id = ?`).get(c.id).n
  const list = db.prepare(`
    SELECT i.*, t.title FROM invoices i JOIN tasks t ON t.id = i.task_id
    WHERE i.company_id = ? ORDER BY i.id DESC LIMIT ? OFFSET ?
  `).all(c.id, pageSize, offset)
  res.json({
    total,
    list: list.map(i => ({
      id: i.id, no: i.no, taskTitle: i.title, amount: centsToYuan(i.amount),
      taxRate: i.tax_rate, item: i.item, confirmNo: i.confirm_no, issuedAt: i.issued_at,
      status: i.status, redInvoiceNo: i.red_invoice_no, voidReason: i.void_reason,
      buyer: { title: c.company_name, taxNo: c.license_no }
    }))
  })
})

router.get('/contracts', (req, res) => {
  const c = myCompany(req)
  const { pageSize, offset } = pageParams(req)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contracts WHERE company_id = ?`).get(c.id).n
  const list = db.prepare(`
    SELECT ct.*, t.title FROM contracts ct LEFT JOIN tasks t ON t.id = ct.task_id
    WHERE ct.company_id = ? ORDER BY ct.id DESC LIMIT ? OFFSET ?
  `).all(c.id, pageSize, offset)
  res.json({
    total,
    list: list.map(x => ({
      id: x.id, type: x.type, no: x.no, taskTitle: x.title,
      partyA: x.party_a, partyB: x.party_b, contentHash: x.content_hash,
      esignId: x.esign_id, signedAt: x.signed_at, hasContent: !!x.content
    }))
  })
})

// 合同正文（签署时渲染的快照）
router.get('/contracts/:id', (req, res, next) => {
  try {
    const c = myCompany(req)
    const x = db.prepare(`SELECT ct.*, t.title FROM contracts ct LEFT JOIN tasks t ON t.id = ct.task_id WHERE ct.id = ? AND ct.company_id = ?`)
      .get(req.params.id, c.id)
    if (!x) throw notFound('合同不存在')
    res.json({
      id: x.id, type: x.type, no: x.no, taskTitle: x.title,
      partyA: x.party_a, partyB: x.party_b, contentHash: x.content_hash,
      esignId: x.esign_id, signedAt: x.signed_at, content: x.content
    })
  } catch (err) {
    next(err)
  }
})

// 开放 API（/api/open/v1）复用同一发布链：合规校验/电子签/冻结全部生效
export { publishTask as publishViaOpenApi }

export default router
