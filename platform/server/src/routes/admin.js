import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import db from '../db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { requirePermission, hasPermission } from '../middleware/rbac.js'
import { stepUp } from '../middleware/stepUp.js'
import { notFound, conflict, badRequest, forbidden } from '../utils/errors.js'
import { centsToYuan } from '../utils/money.js'
import { genNo, sha256, currentPeriod, currentQuarter, currentDate, genTempPassword } from '../utils/ids.js'
import { pageParams } from '../utils/pagination.js'
import { getAllConfigs, setConfig, getConfig } from '../services/configStore.js'
import { notifyCompany, notify } from '../services/notify.js'
import { logAction, listAuditLogs, verifyChain } from '../services/audit.js'
import { buildTaskEvidence } from '../services/evidence.js'
import { esign, taxbureau, healthCheck } from '../integrations/index.js'
import { renderContract, listLegalDocs, bumpLegalDoc } from '../services/contractText.js'
import { readableText } from '../utils/textQuality.js'

const router = Router()
router.use(authenticate, requireRole('admin'))

// PII 脱敏：手机号默认掩码展示，完整号须 user:read_pii 专项权限（PIPL 最小可用原则）
const maskPhone = phone => (phone ? String(phone).slice(0, 3) + '****' + String(phone).slice(-4) : phone)
const phoneFor = (req, phone) => (hasPermission(req.permissions ?? [], 'user:read_pii') ? phone : maskPhone(phone))

function sendCsv(res, filename, header, rows) {
  const esc = v => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = '﻿' + [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(csv)
}

// —— 总览 ——
router.get('/dashboard', requirePermission('dashboard:read'), (_req, res) => {
  const today = currentDate()
  const period = currentPeriod()
  const todayAmount = db.prepare(
    `SELECT COALESCE(SUM(price),0) AS n FROM tasks WHERE status = 'settled' AND settled_at LIKE ?`
  ).get(`${today}%`).n
  const monthTax = db.prepare(
    `SELECT COALESCE(SUM(tax + vat),0) AS n FROM tax_records WHERE period = ?`
  ).get(period).n
  res.json({
    todayAmount: centsToYuan(todayAmount),
    pendingCompanies: db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE status = 'pending'`).get().n,
    openAlerts: db.prepare(`SELECT COUNT(*) AS n FROM risk_alerts WHERE status = 'open'`).get().n,
    monthTax: centsToYuan(monthTax),
    totals: {
      companies: db.prepare(`SELECT COUNT(*) AS n FROM companies`).get().n,
      workers: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'worker'`).get().n,
      tasks: db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n,
      settledAmount: centsToYuan(db.prepare(`SELECT COALESCE(SUM(price),0) AS n FROM tasks WHERE status = 'settled'`).get().n)
    }
  })
})

// 平台统计趋势（图表）
router.get('/stats/trend', requirePermission('dashboard:read'), (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30))
  const trend = db.prepare(`
    SELECT substr(settled_at, 1, 10) AS day, COUNT(*) AS tasks, SUM(price) AS amount
    FROM tasks WHERE status = 'settled' AND settled_at >= date('now', 'localtime', ?)
    GROUP BY day ORDER BY day
  `).all(`-${days} days`)
  const taxTrend = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, SUM(tax) AS tax, SUM(vat) AS vat
    FROM tax_records WHERE created_at >= date('now', 'localtime', ?)
    GROUP BY day ORDER BY day
  `).all(`-${days} days`)
  const statusDist = db.prepare(`SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`).all()
  res.json({
    trend: trend.map(r => ({ day: r.day, tasks: r.tasks, amount: centsToYuan(r.amount) })),
    taxTrend: taxTrend.map(r => ({ day: r.day, tax: centsToYuan(r.tax), vat: centsToYuan(r.vat) })),
    statusDist: statusDist.map(r => ({ status: r.status, count: r.n }))
  })
})

// —— 企业准入审核 ——
router.get('/companies', requirePermission('company:read'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const list = status
    ? db.prepare(`SELECT * FROM companies WHERE status = ? ORDER BY id DESC`).all(status)
    : db.prepare(`SELECT * FROM companies ORDER BY id DESC`).all()
  res.json({
    total: list.length,
    list: list.map(c => ({
      id: c.id, companyName: c.company_name, licenseNo: c.license_no, industry: c.industry,
      riskLevel: c.risk_level, riskNote: c.risk_note, status: c.status,
      reviewNote: c.review_note, masterContractNo: c.master_contract_no, createdAt: c.created_at
    }))
  })
})

router.post('/companies/:id/review', requirePermission('company:review'), async (req, res, next) => {
  try {
    const { pass, note } = z.object({
      pass: z.boolean(),
      note: readableText('审核意见', z.string().max(200).optional().default(''))
    }).parse(req.body)
    const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(req.params.id)
    if (!c) throw notFound('企业不存在')
    // 已通过准入的企业不可重复审核；被拒企业允许补充材料后重新审核（rejected → approved/再拒），避免一拒即死局
    if (c.status === 'approved') throw conflict('ALREADY_REVIEWED', '该企业已通过准入')

    let masterContractNo = null
    if (pass) {
      masterContractNo = genNo('ZCL')
      const signed = await esign.sign({
        docType: 'master',
        parties: [c.company_name, '平台'],
        contentHash: sha256({ masterContractNo, companyId: c.id })
      })
      const content = renderContract('master', {
        partyA: c.company_name, licenseNo: c.license_no,
        contractNo: masterContractNo, date: currentDate(), hash: signed.contentHash
      })
      db.transaction(() => {
        db.prepare(`UPDATE companies SET status = 'approved', review_note = ?, master_contract_no = ? WHERE id = ?`)
          .run(note, masterContractNo, c.id)
        db.prepare(`
          INSERT INTO contracts (type, no, party_a, party_b, company_id, content_hash, esign_id, content)
          VALUES ('master', ?, ?, '平台', ?, ?, ?, ?)
        `).run(masterContractNo, c.company_name, c.id, signed.contentHash, signed.esignId, content)
      })()
      notifyCompany(c.id, 'review', '企业准入审核通过',
        `贵司已通过平台准入审核，《总承揽框架合同》（${masterContractNo}）已电子签署，现在可以充值并发布任务。`)
    } else {
      db.prepare(`UPDATE companies SET status = 'rejected', review_note = ? WHERE id = ?`).run(note || c.risk_note, c.id)
      notifyCompany(c.id, 'review', '企业准入审核未通过', `审核意见：${note || c.risk_note}`)
    }
    logAction(req.user.id, 'review_company', `企业#${c.id} ${pass ? '准入' : '拒绝'}：${note}`)
    res.json({ status: pass ? 'approved' : 'rejected', masterContractNo })
  } catch (err) {
    next(err)
  }
})

// 企业全貌（详情抽屉）
router.get('/companies/:id/detail', requirePermission('company:read'), (req, res, next) => {
  try {
    const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(req.params.id)
    if (!c) throw notFound('企业不存在')
    const acc = db.prepare(`SELECT * FROM accounts WHERE owner_type = 'company' AND owner_id = ?`).get(c.id)
    const taskStats = db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(price),0) AS amount FROM tasks WHERE company_id = ? GROUP BY status`).all(c.id)
    const members = db.prepare(`
      SELECT m.user_id, m.member_role, u.name, u.phone, u.status FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ?
    `).all(c.id)
    const flows = acc ? db.prepare(`SELECT * FROM fund_flows WHERE account_id = ? ORDER BY id DESC LIMIT 10`).all(acc.id) : []
    const alerts = db.prepare(`SELECT * FROM risk_alerts WHERE ref_type = 'company' AND ref_id = ? ORDER BY id DESC LIMIT 10`).all(c.id)
    res.json({
      company: {
        id: c.id, companyName: c.company_name, licenseNo: c.license_no, industry: c.industry,
        riskLevel: c.risk_level, status: c.status, masterContractNo: c.master_contract_no,
        contactPhone: c.contact_phone, contactEmail: c.contact_email, createdAt: c.created_at
      },
      account: acc ? { balance: centsToYuan(acc.balance), frozen: centsToYuan(acc.frozen) } : null,
      taskStats: taskStats.map(t => ({ status: t.status, count: t.n, amount: centsToYuan(t.amount) })),
      members: members.map(m => ({ userId: m.user_id, name: m.name, phone: phoneFor(req, m.phone), memberRole: m.member_role, status: m.status })),
      recentFlows: flows.map(f => ({ id: f.id, type: f.type, amount: centsToYuan(f.amount), remark: f.remark, createdAt: f.created_at })),
      alerts: alerts.map(a => ({ id: a.id, level: a.level, type: a.type, detail: a.detail, status: a.status, createdAt: a.created_at }))
    })
  } catch (err) {
    next(err)
  }
})

// B端业务真实性证明包（按需提供，供企业应对税务核查）
router.get('/companies/:id/evidence-pack', requirePermission('archive:read'), (req, res, next) => {
  try {
    const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(req.params.id)
    if (!c) throw notFound('企业不存在')
    const tasks = db.prepare(`
      SELECT t.*, u.name AS worker_name, p.real_name, p.id_card_masked, p.verified_at, p.frame_contract_no
      FROM tasks t JOIN users u ON u.id = t.worker_id JOIN worker_profiles p ON p.user_id = t.worker_id
      WHERE t.company_id = ? AND t.status = 'settled' ORDER BY t.id
    `).all(c.id)
    const acc = db.prepare(`SELECT id FROM accounts WHERE owner_type = 'company' AND owner_id = ?`).get(c.id)
    const flows = acc ? db.prepare(`SELECT * FROM fund_flows WHERE account_id = ? AND type = 'settle_out' ORDER BY id`).all(acc.id) : []
    logAction(req.user.id, 'evidence_pack_export', `company#${c.id}`)
    res.json({
      generatedAt: new Date().toISOString(),
      company: { companyName: c.company_name, licenseNo: c.license_no, masterContractNo: c.master_contract_no },
      realnameVerifications: tasks.map(t => ({
        taskId: t.id, workerName: t.real_name || t.worker_name, idCardMasked: t.id_card_masked,
        verifiedAt: t.verified_at, frameContractNo: t.frame_contract_no
      })),
      transactions: tasks.map(t => ({
        taskId: t.id, title: t.title, amount: centsToYuan(t.price),
        taskOrderNo: t.task_order_no, subOrderNo: t.sub_order_no,
        deliverable: t.deliverable, confirmNo: t.confirm_no, settledAt: t.settled_at
      })),
      payments: flows.map(f => ({ flowId: f.id, amount: centsToYuan(f.amount), remark: f.remark, paidAt: f.created_at }))
    })
  } catch (err) {
    next(err)
  }
})

// —— 零工管理 ——
router.get('/workers', requirePermission('worker:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const year = String(new Date().getFullYear())
  const conds = [`u.role = 'worker'`]
  const params = []
  if (req.query.subjectType === 'person' || req.query.subjectType === 'soletrader') {
    conds.push(`p.subject_type = ?`); params.push(req.query.subjectType)
  }
  if (req.query.status === 'active' || req.query.status === 'disabled') {
    conds.push(`u.status = ?`); params.push(req.query.status)
  }
  if (req.query.locked === '1') conds.push(`p.locked = 1`)
  if (req.query.verified === '1') conds.push(`p.verified = 1`)
  else if (req.query.verified === '0') conds.push(`p.verified = 0`)
  if (req.query.keyword) { conds.push(`u.name LIKE ?`); params.push(`%${req.query.keyword}%`) }
  const where = conds.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN worker_profiles p ON p.user_id = u.id WHERE ${where}`).get(...params).n
  const list = db.prepare(`
    SELECT u.id, u.name, u.phone, u.status, u.created_at, p.verified, p.subject_type, p.locked,
      (SELECT COALESCE(SUM(gross),0) FROM tax_records r WHERE r.worker_id = u.id AND r.period LIKE ?) AS year_gross
    FROM users u JOIN worker_profiles p ON p.user_id = u.id
    WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?
  `).all(`${year}-%`, ...params, pageSize, offset)
  res.json({
    total,
    list: list.map(w => ({
      id: w.id, name: w.name, phone: phoneFor(req, w.phone), verified: !!w.verified,
      subjectType: w.subject_type, locked: !!w.locked, status: w.status,
      yearGross: centsToYuan(w.year_gross), createdAt: w.created_at
    }))
  })
})

// 零工全貌（详情抽屉）
router.get('/workers/:id/detail', requirePermission('worker:read'), (req, res, next) => {
  try {
    const u = db.prepare(`
      SELECT u.id, u.name, u.phone, u.status, u.created_at, p.* FROM users u JOIN worker_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'worker'
    `).get(req.params.id)
    if (!u) throw notFound('零工不存在')
    const acc = db.prepare(`SELECT * FROM accounts WHERE owner_type = 'worker' AND owner_id = ?`).get(u.id)
    const orderStats = db.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE worker_id = ? GROUP BY status`).all(u.id)
    const taxRecords = db.prepare(`
      SELECT r.*, t.title FROM tax_records r JOIN tasks t ON t.id = r.task_id WHERE r.worker_id = ? ORDER BY r.id DESC LIMIT 10
    `).all(u.id)
    const contracts = db.prepare(`SELECT type, no, signed_at FROM contracts WHERE worker_id = ? ORDER BY id DESC LIMIT 10`).all(u.id)
    const alerts = db.prepare(`SELECT * FROM risk_alerts WHERE ref_type = 'worker' AND ref_id = ? ORDER BY id DESC LIMIT 10`).all(u.id)
    res.json({
      worker: {
        id: u.id, name: u.name, phone: phoneFor(req, u.phone), status: u.status,
        verified: !!u.verified, subjectType: u.subject_type, locked: !!u.locked,
        bankCard: u.bank_card_masked, frameContractNo: u.frame_contract_no, createdAt: u.created_at
      },
      account: acc ? { balance: centsToYuan(acc.balance - acc.frozen), frozen: centsToYuan(acc.frozen) } : null,
      orderStats: orderStats.map(o => ({ status: o.status, count: o.n })),
      recentIncome: taxRecords.map(r => ({
        taskTitle: r.title, gross: centsToYuan(r.gross), tax: centsToYuan(r.tax + r.vat),
        net: centsToYuan(r.net), period: r.period, createdAt: r.created_at
      })),
      contracts: contracts.map(c => ({ type: c.type, no: c.no, signedAt: c.signed_at })),
      alerts: alerts.map(a => ({ id: a.id, level: a.level, type: a.type, detail: a.detail, status: a.status, createdAt: a.created_at }))
    })
  } catch (err) {
    next(err)
  }
})

router.post('/workers/:id/lock', requirePermission('worker:manage'), (req, res, next) => {
  try {
    const { lock } = z.object({ lock: z.boolean() }).parse(req.body)
    const p = db.prepare(`SELECT * FROM worker_profiles WHERE user_id = ?`).get(req.params.id)
    if (!p) throw notFound('零工不存在')
    // 风控人工锁标记 reason='risk'：零工无法通过个体户登记绕过解除（仅运营可解）
    db.prepare(`UPDATE worker_profiles SET locked = ?, lock_reason = ? WHERE user_id = ?`)
      .run(lock ? 1 : 0, lock ? 'risk' : null, req.params.id)
    logAction(req.user.id, 'worker_lock', `worker#${req.params.id} lock=${lock}`)
    notify(Number(req.params.id), 'risk', lock ? '接单权限已锁定' : '接单权限已恢复',
      lock ? '平台风控已锁定您的接单权限，如有疑问请联系平台客服。' : '您的接单权限已恢复，可以正常接单。')
    res.json({ locked: lock })
  } catch (err) {
    next(err)
  }
})

router.get('/workers/export', requirePermission('worker:read'), (_req, res) => {
  const year = String(new Date().getFullYear())
  const rows = db.prepare(`
    SELECT u.id, u.name, u.phone, p.verified, p.subject_type, p.locked, u.status,
      (SELECT COALESCE(SUM(gross),0) FROM tax_records r WHERE r.worker_id = u.id AND r.period LIKE ?) AS year_gross
    FROM users u JOIN worker_profiles p ON p.user_id = u.id WHERE u.role = 'worker' ORDER BY u.id
  `).all(`${year}-%`)
  // 批量导出统一脱敏；完整手机号导出走导出审批流（/admin/exports）
  sendCsv(res, `零工名册_${currentDate()}.csv`,
    ['ID', '姓名', '手机号(脱敏)', '已实名', '主体类型', '接单锁定', '账号状态', '本年收入(元)'],
    rows.map(w => [w.id, w.name, maskPhone(w.phone), w.verified ? '是' : '否',
      w.subject_type === 'soletrader' ? '个体工商户' : '自然人',
      w.locked ? '是' : '否', w.status, centsToYuan(w.year_gross)]))
})

// —— 运营用户与角色管理 ——
// 高权限账号保护：非超级管理员不得停用/重置/改动「超级管理员」账号（防止借账号管理通道夺取超管）
function isSuperAdminUser(userId) {
  const row = db.prepare(`
    SELECT r.permissions FROM users u JOIN admin_roles r ON r.id = u.admin_role_id WHERE u.id = ?
  `).get(userId)
  return !!row && JSON.parse(row.permissions).includes('*')
}

router.get('/roles', requirePermission('user:read'), (_req, res) => {
  const list = db.prepare(`SELECT * FROM admin_roles ORDER BY id`).all()
  res.json({ list: list.map(r => ({ id: r.id, name: r.name, permissions: JSON.parse(r.permissions) })) })
})

router.get('/users', requirePermission('user:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n
  const list = db.prepare(`
    SELECT u.id, u.name, u.phone, u.status, u.created_at, r.name AS role_name, u.admin_role_id
    FROM users u LEFT JOIN admin_roles r ON r.id = u.admin_role_id
    WHERE u.role = 'admin' ORDER BY u.id LIMIT ? OFFSET ?
  `).all(pageSize, offset)
  res.json({
    total,
    list: list.map(u => ({
      id: u.id, name: u.name, phone: u.phone, status: u.status,
      roleId: u.admin_role_id, roleName: u.role_name, createdAt: u.created_at
    }))
  })
})

router.post('/users', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const body = z.object({
      phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确'),
      name: readableText('员工姓名', z.string().min(1).max(30)),
      roleId: z.number().int().positive()
    }).parse(req.body)
    const exists = db.prepare(`SELECT id FROM users WHERE phone = ?`).get(body.phone)
    if (exists) throw conflict('PHONE_EXISTS', '该手机号已注册')
    const role = db.prepare(`SELECT id, permissions FROM admin_roles WHERE id = ?`).get(body.roleId)
    if (!role) throw badRequest('BAD_ROLE', '角色不存在')
    // 仅超级管理员可分配「全部权限(*)」角色，防止 user:manage 持有者自我提权为超管
    if (JSON.parse(role.permissions).includes('*') && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可分配超级管理员角色')
    }
    const tempPassword = genTempPassword()
    const { lastInsertRowid: userId } = db.prepare(
      `INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', ?, ?, ?, ?)`
    ).run(body.phone, bcrypt.hashSync(tempPassword, 10), body.name, body.roleId)
    logAction(req.user.id, 'admin_user_create', `user#${userId} role#${body.roleId}`)
    res.status(201).json({ userId, tempPassword })
  } catch (err) {
    next(err)
  }
})

router.patch('/users/:id/role', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const { roleId } = z.object({ roleId: z.number().int().positive() }).parse(req.body)
    const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'admin'`).get(req.params.id)
    if (!u) throw notFound('用户不存在')
    if (u.id === req.user.id) throw badRequest('SELF_FORBIDDEN', '不能修改自己的角色')
    if (isSuperAdminUser(u.id) && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可调整超级管理员账号的角色')
    }
    const role = db.prepare(`SELECT permissions FROM admin_roles WHERE id = ?`).get(roleId)
    if (!role) throw badRequest('BAD_ROLE', '角色不存在')
    // 仅超级管理员可授予「全部权限(*)」角色，防止越权将他人提升为超管
    if (JSON.parse(role.permissions).includes('*') && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可分配超级管理员角色')
    }
    db.prepare(`UPDATE users SET admin_role_id = ? WHERE id = ?`).run(roleId, u.id)
    logAction(req.user.id, 'admin_user_role', `user#${u.id} role#${roleId}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.post('/users/:id/disable', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    // 账号治理覆盖全部角色（运营可封禁零工/企业账号），但超管账号仅超管可停用
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id)
    if (!u) throw notFound('用户不存在')
    if (u.id === req.user.id) throw badRequest('SELF_FORBIDDEN', '不能停用自己的账号')
    if (isSuperAdminUser(u.id) && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可停用超级管理员账号')
    }
    // 企业主账号不可单独停用：否则企业失去唯一 owner 且无自助恢复路径。需先由 owner 转移所有权（/company/members/:id/transfer-owner）
    const ownerOf = db.prepare(`SELECT 1 FROM company_members WHERE user_id = ? AND member_role = 'owner'`).get(u.id)
    if (ownerOf) throw conflict('OWNER_PROTECTED', '该账号为企业主账号，请先转移企业所有权后再停用，避免企业失去管理员而瘫痪')
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(u.id)
    logAction(req.user.id, 'user_disable', `user#${u.id}`)
    res.json({ status: 'disabled' })
  } catch (err) {
    next(err)
  }
})

router.post('/users/:id/enable', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id)
    if (!u) throw notFound('用户不存在')
    if (isSuperAdminUser(u.id) && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可启用超级管理员账号')
    }
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(u.id)
    logAction(req.user.id, 'user_enable', `user#${u.id}`)
    res.json({ status: 'active' })
  } catch (err) {
    next(err)
  }
})

router.post('/users/:id/reset-password', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id)
    if (!u) throw notFound('用户不存在')
    if (isSuperAdminUser(u.id) && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可重置超级管理员账号的密码')
    }
    const tempPassword = genTempPassword()
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(tempPassword, 10), u.id)
    logAction(req.user.id, 'user_reset_password', `user#${u.id}`)
    res.json({ tempPassword })
  } catch (err) {
    next(err)
  }
})

// —— 业务参数配置 ——
router.get('/configs', requirePermission('config:read'), (_req, res) => {
  res.json({ list: getAllConfigs() })
})

router.patch('/configs/:key', requirePermission('config:write'), (req, res, next) => {
  try {
    const { value } = z.object({ value: z.any() }).parse(req.body)
    const result = setConfig(req.params.key, value, req.user.id)
    logAction(req.user.id, 'config_update', `${req.params.key}: ${JSON.stringify(result.oldValue)} → ${JSON.stringify(value)}`)
    res.json({ key: result.key, value: result.value })
  } catch (err) {
    if (err.message?.startsWith('配置') || err.message?.includes('未知配置项')) {
      return next(badRequest('BAD_CONFIG', err.message))
    }
    next(err)
  }
})

// —— 风控 ——
router.get('/risk/alerts', requirePermission('risk:read'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const list = status
    ? db.prepare(`SELECT * FROM risk_alerts WHERE status = ? ORDER BY id DESC`).all(status)
    : db.prepare(`SELECT * FROM risk_alerts ORDER BY id DESC`).all()
  res.json({
    total: list.length,
    list: list.map(a => ({
      id: a.id, level: a.level, type: a.type, detail: a.detail,
      refType: a.ref_type, refId: a.ref_id,
      status: a.status, resolveNote: a.resolve_note, createdAt: a.created_at, resolvedAt: a.resolved_at
    }))
  })
})

router.post('/risk/alerts/:id/resolve', requirePermission('risk:resolve'), (req, res, next) => {
  try {
    const { note } = z.object({ note: readableText('处理备注', z.string().max(300).optional().default('')) }).parse(req.body)
    const a = db.prepare(`SELECT * FROM risk_alerts WHERE id = ?`).get(req.params.id)
    if (!a) throw notFound('预警不存在')
    if (a.status === 'resolved') throw conflict('ALREADY_RESOLVED', '该预警已处理')
    db.prepare(`
      UPDATE risk_alerts SET status = 'resolved', resolve_note = ?, resolved_at = datetime('now','localtime') WHERE id = ?
    `).run(note, a.id)
    logAction(req.user.id, 'risk_resolve', `alert#${a.id}：${note}`)
    res.json({ status: 'resolved' })
  } catch (err) {
    next(err)
  }
})

// —— 税务 ——
router.get('/tax/overview', requirePermission('tax:read'), (_req, res) => {
  const period = currentPeriod()
  const quarter = currentQuarter()
  const sums = db.prepare(`
    SELECT COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(vat),0) AS vat,
           COALESCE(SUM(gross),0) AS gross
    FROM tax_records WHERE period = ?
  `).get(period)
  const totalSettled = db.prepare(`SELECT COALESCE(SUM(price),0) AS p, COALESCE(SUM(price - sub_price),0) AS m FROM tasks WHERE status = 'settled'`).get()
  const soletrader = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN method = 'business_income' THEN gross ELSE 0 END),0) AS bi,
           COALESCE(SUM(gross),0) AS total
    FROM tax_records
  `).get()
  res.json({
    period,
    quarter,
    withheldTax: centsToYuan(sums.tax),
    vat: centsToYuan(sums.vat),
    declared: !!db.prepare(`SELECT 1 FROM tax_declarations WHERE type = 'monthly_declare' AND period = ?`).get(period),
    quarterReported: !!db.prepare(`SELECT 1 FROM tax_declarations WHERE type = 'quarter_report' AND period = ?`).get(quarter),
    health: {
      // 销项税率取自可在线调整的配置 outputVatRate（如 '6%'），避免与实际开票口径脱钩
      vatBurdenRate: totalSettled.p ? (totalSettled.m * (parseFloat(getConfig('outputVatRate')) / 100 || 0.06) / totalSettled.p * 100).toFixed(2) + '%' : '0%',
      grossMarginRate: totalSettled.p ? (totalSettled.m / totalSettled.p * 100).toFixed(2) + '%' : '0%',
      soletraderRatio: soletrader.total ? (soletrader.bi / soletrader.total * 100).toFixed(2) + '%' : '0%'
    }
  })
})

router.post('/tax/declare', requirePermission('tax:declare'), async (req, res, next) => {
  try {
    const { period } = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body)
    const exists = db.prepare(`SELECT 1 FROM tax_declarations WHERE type = 'monthly_declare' AND period = ?`).get(period)
    if (exists) throw conflict('ALREADY_DECLARED', '该期已申报')
    const sums = db.prepare(`
      SELECT COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(vat),0) AS vat, COUNT(*) AS cnt
      FROM tax_records WHERE period = ?
    `).get(period)
    const receipt = await taxbureau.declare({ period, taxCents: sums.tax, vatCents: sums.vat })
    db.prepare(`INSERT INTO tax_declarations (type, period, payload, receipt_no) VALUES ('monthly_declare', ?, ?, ?)`)
      .run(period, JSON.stringify({ tax: sums.tax, vat: sums.vat, records: sums.cnt }), receipt.receiptNo)
    logAction(req.user.id, 'tax_declare', `${period} 申报回执 ${receipt.receiptNo}`)
    res.json({ receiptNo: receipt.receiptNo, withheldTax: centsToYuan(sums.tax), vat: centsToYuan(sums.vat) })
  } catch (err) {
    next(err)
  }
})

router.post('/tax/quarter-report', requirePermission('tax:declare'), async (req, res, next) => {
  try {
    const { period } = z.object({ period: z.string().regex(/^\d{4}Q[1-4]$/) }).parse(req.body)
    const exists = db.prepare(`SELECT 1 FROM tax_declarations WHERE type = 'quarter_report' AND period = ?`).get(period)
    if (exists) throw conflict('ALREADY_REPORTED', '该季度已报送')
    const [y, q] = period.split('Q')
    const months = [1, 2, 3].map(i => `${y}-${String((q - 1) * 3 + i).padStart(2, '0')}`)
    const workers = db.prepare(`
      SELECT COUNT(DISTINCT worker_id) AS n FROM tax_records WHERE period IN (?, ?, ?)
    `).get(...months).n
    const receipt = await taxbureau.report({ period, workers })
    db.prepare(`INSERT INTO tax_declarations (type, period, payload, receipt_no) VALUES ('quarter_report', ?, ?, ?)`)
      .run(period, JSON.stringify({ workers, months }), receipt.fileNo)
    logAction(req.user.id, 'tax_quarter_report', `${period} 文件号 ${receipt.fileNo}`)
    res.json({ fileNo: receipt.fileNo, workers })
  } catch (err) {
    next(err)
  }
})

router.get('/tax/export', requirePermission('tax:read'), (req, res) => {
  const period = req.query.period || currentPeriod()
  const rows = db.prepare(`
    SELECT r.*, u.name AS worker_name, t.title FROM tax_records r
    JOIN users u ON u.id = r.worker_id JOIN tasks t ON t.id = r.task_id
    WHERE r.period = ? ORDER BY r.id
  `).all(period)
  sendCsv(res, `税务明细_${period}.csv`,
    ['记录ID', '零工', '任务', '账期', '劳务报酬(元)', '预扣个税(元)', '增值税(元)', '实发(元)', '计税方式', '完税凭证号'],
    rows.map(r => [r.id, r.worker_name, r.title, r.period, centsToYuan(r.gross),
      centsToYuan(r.tax), centsToYuan(r.vat), centsToYuan(r.net),
      r.method === 'cumulative' ? '累计预扣' : '经营所得', r.tax_voucher_no || '']))
})

// —— 四流证据链归档 ——
router.get('/archives', requirePermission('archive:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'settled'`).get().n
  const rows = db.prepare(`
    SELECT t.*, c.company_name, c.master_contract_no, u.name AS worker_name
    FROM tasks t JOIN companies c ON c.id = t.company_id JOIN users u ON u.id = t.worker_id
    WHERE t.status = 'settled' ORDER BY t.id DESC LIMIT ? OFFSET ?
  `).all(pageSize, offset)
  const list = rows.map(t => {
    const inv = db.prepare(`SELECT no FROM invoices WHERE task_id = ?`).get(t.id)
    const taxRec = db.prepare(`SELECT tax_voucher_no FROM tax_records WHERE task_id = ?`).get(t.id)
    const frame = db.prepare(`SELECT frame_contract_no FROM worker_profiles WHERE user_id = ?`).get(t.worker_id)
    const fundFlows = db.prepare(`SELECT id FROM fund_flows WHERE ref_type = 'task' AND ref_id = ?`).all(t.id).map(f => f.id)
    const flows = {
      contract: [t.master_contract_no, t.task_order_no, t.sub_order_no, frame?.frame_contract_no].filter(Boolean),
      business: { deliverable: t.deliverable, confirmNo: t.confirm_no },
      fund: fundFlows,
      invoice: { no: inv?.no, taxVoucher: taxRec?.tax_voucher_no }
    }
    return {
      taskId: t.id, title: t.title, companyName: t.company_name, workerName: t.worker_name,
      amount: centsToYuan(t.price), flows, evidenceHash: sha256(flows), settledAt: t.settled_at
    }
  })
  res.json({ total, list })
})

// —— 审计日志 ——
router.get('/audit-logs', requirePermission('audit:read'), (req, res) => {
  const { page, pageSize } = pageParams(req)
  const { total, list } = listAuditLogs({
    page, pageSize,
    action: req.query.action || undefined,
    userId: req.query.userId ? Number(req.query.userId) : undefined
  })
  res.json({
    total,
    list: list.map(a => ({
      id: a.id, userId: a.user_id, userName: a.user_name, userRole: a.user_role,
      action: a.action, detail: a.detail, detailJson: a.detail_json || null,
      ip: a.ip || null, userAgent: a.user_agent || null, geo: a.geo || null,
      hash: a.hash || null, createdAt: a.created_at
    }))
  })
})

// 审计动作字典：返回库中实际出现过的动作清单，供前端筛选下拉动态构建（避免与写死清单漂移）
router.get('/audit-logs/actions', requirePermission('audit:read'), (_req, res) => {
  const rows = db.prepare(`SELECT DISTINCT action FROM audit_logs ORDER BY action`).all()
  res.json({ actions: rows.map(r => r.action) })
})

// 审计哈希链完整性自检：校验全表防篡改链是否完好（任意改/删/插会被检出）
router.get('/audit-logs/verify', requirePermission('audit:read'), (_req, res) => {
  res.json(verifyChain())
})

// 单笔工单完整证据链（运营视角，IP/UA 不脱敏）
router.get('/tasks/:id/evidence', requirePermission('archive:read'), (req, res, next) => {
  try {
    const evidence = buildTaskEvidence(Number(req.params.id), { full: true })
    if (!evidence) throw notFound('任务不存在')
    res.json(evidence)
  } catch (err) {
    next(err)
  }
})

// —— 外部接口健康 ——
router.get('/integrations', requirePermission('integration:read'), async (_req, res, next) => {
  try {
    res.json(await healthCheck())
  } catch (err) {
    next(err)
  }
})

// —— 自动对账（全量汇总 + T+1 按日明细）——
router.get('/reconciliation', requirePermission('flow:read'), (_req, res) => {
  const bank = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM escrow_txns`).get()
  const platform = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM fund_flows
    WHERE type IN ('recharge','settle_out','withdraw')
  `).get()
  const diff = bank.total - platform.total
  const recent = db.prepare(`SELECT * FROM escrow_txns ORDER BY id DESC LIMIT 20`).all()
  const daily = db.prepare(`SELECT * FROM reconciliation_daily ORDER BY day DESC LIMIT 30`).all()
  res.json({
    balanced: diff === 0,
    bank: { txns: bank.n, total: centsToYuan(bank.total) },
    platform: { flows: platform.n, total: centsToYuan(platform.total) },
    diff: centsToYuan(diff),
    daily: daily.map(d => ({
      day: d.day, status: d.status, diff: centsToYuan(d.diff),
      bankTotal: centsToYuan(d.bank_total), bankTxns: d.bank_txns,
      platformTotal: centsToYuan(d.platform_total), platformFlows: d.platform_flows,
      checkedAt: d.checked_at
    })),
    mismatchDays: daily.filter(d => d.status === 'mismatch').map(d => d.day),
    recentTxns: recent.map(t => ({
      id: t.id, txnNo: t.txn_no, from: t.from_acct, to: t.to_acct,
      amount: centsToYuan(t.amount), purpose: t.purpose, createdAt: t.created_at
    }))
  })
})

// —— 提现单管理 ——
router.get('/withdrawals', requirePermission('flow:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? `WHERE w.status = ?` : ''
  const params = status ? [status] : []
  const total = db.prepare(`SELECT COUNT(*) AS n FROM withdrawals w ${where}`).get(...params).n
  const list = db.prepare(`
    SELECT w.*, u.name AS worker_name FROM withdrawals w JOIN users u ON u.id = w.worker_id
    ${where} ORDER BY w.id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)
  res.json({
    total,
    list: list.map(w => ({
      id: w.id, workerId: w.worker_id, workerName: w.worker_name,
      amount: centsToYuan(w.amount), bankCard: w.bank_card, status: w.status,
      escrowTxnNo: w.escrow_txn_no, failReason: w.fail_reason,
      createdAt: w.created_at, doneAt: w.done_at
    }))
  })
})

// —— 结算单监控 ——
router.get('/settlements', requirePermission('flow:read'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? `WHERE s.status = ?` : ''
  const params = status ? [status] : []
  const list = db.prepare(`
    SELECT s.*, t.title FROM settlements s JOIN tasks t ON t.id = s.task_id
    ${where} ORDER BY s.id DESC LIMIT 100
  `).all(...params)
  res.json({
    total: list.length,
    list: list.map(s => ({
      id: s.id, taskId: s.task_id, taskTitle: s.title, confirmNo: s.confirm_no,
      net: centsToYuan(s.net), tax: centsToYuan(s.tax + s.vat), margin: centsToYuan(s.margin),
      status: s.status, legsDone: JSON.parse(s.legs_done), attempts: s.attempts,
      lastError: s.last_error, createdAt: s.created_at, doneAt: s.done_at
    }))
  })
})

// —— 全平台资金流水 ——
const FLOW_TYPE_KEYS = ['recharge', 'freeze', 'unfreeze', 'settle_out', 'settle_in', 'withdraw', 'tax_in', 'revenue_in']
const FLOW_OWNER_KEYS = ['company', 'worker', 'platform_tax', 'platform_revenue']
router.get('/flows', requirePermission('flow:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const conds = []
  const params = []
  if (FLOW_TYPE_KEYS.includes(req.query.type)) { conds.push(`f.type = ?`); params.push(req.query.type) }
  if (FLOW_OWNER_KEYS.includes(req.query.ownerType)) { conds.push(`a.owner_type = ?`); params.push(req.query.ownerType) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM fund_flows f JOIN accounts a ON a.id = f.account_id ${where}`).get(...params).n
  const list = db.prepare(`
    SELECT f.*, a.owner_type, a.owner_id FROM fund_flows f JOIN accounts a ON a.id = f.account_id
    ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)
  res.json({
    total,
    list: list.map(f => ({
      id: f.id, ownerType: f.owner_type, ownerId: f.owner_id, type: f.type,
      amount: centsToYuan(f.amount), balanceAfter: centsToYuan(f.balance_after),
      remark: f.remark, createdAt: f.created_at
    }))
  })
})

router.get('/flows/export', requirePermission('flow:read'), (_req, res) => {
  const rows = db.prepare(`
    SELECT f.*, a.owner_type, a.owner_id FROM fund_flows f JOIN accounts a ON a.id = f.account_id ORDER BY f.id
  `).all()
  const OWNER = { company: '企业户', worker: '零工户', platform_tax: '税款备付金户', platform_revenue: '平台收益户' }
  sendCsv(res, `平台资金流水_${currentDate()}.csv`,
    ['流水ID', '账户类型', '账户主体ID', '类型', '金额(元)', '变动后余额(元)', '摘要', '时间'],
    rows.map(f => [f.id, OWNER[f.owner_type] || f.owner_type, f.owner_id, f.type,
      centsToYuan(f.amount), centsToYuan(f.balance_after), f.remark, f.created_at]))
})

// —— 权限点清单（角色管理 UI 勾选用）——
const PERMISSION_CATALOG = [
  ['dashboard:read', '查看运营总览'], ['company:read', '查看企业'], ['company:review', '企业入驻审核'],
  ['worker:read', '查看零工'], ['worker:manage', '零工锁定/管理'],
  ['risk:read', '查看风控预警'], ['risk:resolve', '处理风控预警'],
  ['tax:read', '查看税务'], ['tax:declare', '税务申报与报送'],
  ['flow:read', '资金流水/单据/对账'], ['flow:write', '结算重推/对账差异处置'], ['archive:read', '凭证归档/证明包'],
  ['integration:read', '查看外部服务状态'], ['config:read', '查看业务参数配置'], ['config:write', '修改业务参数和协议模板'],
  ['user:read', '查看运营用户'], ['user:manage', '管理运营用户'], ['user:read_pii', '查看用户完整个人信息（审计）'],
  ['audit:read', '查看审计日志'],
  ['dispute:read', '查看争议'], ['dispute:rule', '争议受理与裁决'],
  ['ticket:read', '查看客服工单'], ['ticket:manage', '处理客服工单'],
  ['finance:read', '财务报表中心'], ['export:approve', '个人信息导出审批'],
  ['message:manage', '消息模板与外发日志'], ['help:manage', '帮助中心管理'], ['skill:review', '技能认证审核']
]
const KNOWN_PERMS = new Set(PERMISSION_CATALOG.map(p => p[0]))
const PRESET_ROLES = new Set(['超级管理员', '审核专员', '风控专员', '财务税务', '只读审计', '客服', '合规专员'])

router.get('/permissions', requirePermission('user:read'), (_req, res) => {
  res.json({ list: PERMISSION_CATALOG.map(([key, label]) => ({ key, label })) })
})

// —— 自定义角色管理 ——
const roleSchema = z.object({
  name: readableText('角色名', z.string().min(2).max(20)),
  permissions: z.array(z.string()).min(1, '至少选择一个权限点')
})

function validatePerms(perms) {
  const bad = perms.filter(p => p !== '*' && !KNOWN_PERMS.has(p))
  if (bad.length) throw badRequest('BAD_PERMISSION', `未知权限点：${bad.join(',')}`)
}

router.post('/roles', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const body = roleSchema.parse(req.body)
    validatePerms(body.permissions)
    // 仅超级管理员可创建含「全部权限(*)」的角色，防止 user:manage 持有者借自定义角色提权
    if (body.permissions.includes('*') && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可创建包含全部权限(*)的角色')
    }
    const exists = db.prepare(`SELECT id FROM admin_roles WHERE name = ?`).get(body.name)
    if (exists) throw conflict('ROLE_EXISTS', '角色名已存在')
    const { lastInsertRowid } = db.prepare(`INSERT INTO admin_roles (name, permissions) VALUES (?, ?)`)
      .run(body.name, JSON.stringify(body.permissions))
    logAction(req.user.id, 'role_create', `${body.name}: ${body.permissions.join(',')}`)
    res.status(201).json({ id: lastInsertRowid, name: body.name, permissions: body.permissions })
  } catch (err) {
    next(err)
  }
})

router.patch('/roles/:id', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const body = roleSchema.partial().parse(req.body)
    const role = db.prepare(`SELECT * FROM admin_roles WHERE id = ?`).get(req.params.id)
    if (!role) throw notFound('角色不存在')
    if (role.name === '超级管理员') throw badRequest('PROTECTED_ROLE', '超级管理员角色不可修改')
    if (body.permissions) validatePerms(body.permissions)
    // 仅超级管理员可把角色权限提升为「全部权限(*)」，防止越权编辑自身角色提权为超管
    if (body.permissions?.includes('*') && !hasPermission(req.permissions ?? [], '*')) {
      throw forbidden('仅超级管理员可将角色提升为全部权限(*)')
    }
    if (body.name && PRESET_ROLES.has(role.name) && body.name !== role.name) {
      throw badRequest('PROTECTED_ROLE', '预置角色不可改名')
    }
    db.prepare(`UPDATE admin_roles SET name = COALESCE(?, name), permissions = COALESCE(?, permissions) WHERE id = ?`)
      .run(body.name ?? null, body.permissions ? JSON.stringify(body.permissions) : null, role.id)
    logAction(req.user.id, 'role_update', `role#${role.id}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.delete('/roles/:id', requirePermission('user:manage'), stepUp, (req, res, next) => {
  try {
    const role = db.prepare(`SELECT * FROM admin_roles WHERE id = ?`).get(req.params.id)
    if (!role) throw notFound('角色不存在')
    if (PRESET_ROLES.has(role.name)) throw badRequest('PROTECTED_ROLE', '预置角色不可删除')
    const inUse = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE admin_role_id = ?`).get(role.id).n
    if (inUse) throw conflict('ROLE_IN_USE', `仍有 ${inUse} 个账号使用该角色，请先调整`)
    db.prepare(`DELETE FROM admin_roles WHERE id = ?`).run(role.id)
    logAction(req.user.id, 'role_delete', role.name)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// —— 协议与合同模板管理 ——
router.get('/legal', requirePermission('config:read'), (_req, res) => {
  res.json({ list: listLegalDocs() })
})

router.patch('/legal/:type', requirePermission('config:write'), (req, res, next) => {
  try {
    const { content } = z.object({ content: readableText('文书正文', z.string().min(20, '正文过短')) }).parse(req.body)
    const doc = bumpLegalDoc(req.params.type, content, req.user.id)
    logAction(req.user.id, 'legal_update', `${req.params.type} → v${doc.version}`)
    res.json({ type: doc.type, version: doc.version })
  } catch (err) {
    if (err.message === '未知文书类型') return next(notFound('文书不存在'))
    next(err)
  }
})

// —— 业务真实性抽查回访工作台（方案模块8，P2）——
router.post('/callbacks/sample', requirePermission('risk:resolve'), (req, res, next) => {
  try {
    const ratio = getConfigSafe('callbackSampleRatio', 0.2)
    const candidates = db.prepare(`
      SELECT t.id, t.worker_id, t.company_id FROM tasks t
      LEFT JOIN callbacks cb ON cb.task_id = t.id
      WHERE t.status = 'settled' AND cb.id IS NULL
        AND t.settled_at >= datetime('now', 'localtime', '-30 days')
    `).all()
    const sampleCount = Math.max(candidates.length ? 1 : 0, Math.floor(candidates.length * ratio))
    const sampled = candidates.sort(() => Math.random() - 0.5).slice(0, sampleCount)
    const insert = db.prepare(`INSERT INTO callbacks (task_id, worker_id, company_id) VALUES (?, ?, ?)`)
    for (const t of sampled) insert.run(t.id, t.worker_id, t.company_id)
    logAction(req.user.id, 'callback_sample', `抽取 ${sampled.length}/${candidates.length}`)
    res.json({ sampled: sampled.length, candidates: candidates.length })
  } catch (err) {
    next(err)
  }
})

function getConfigSafe(key, fallback) {
  try { return getAllConfigs().find(c => c.key === key)?.value ?? fallback } catch { return fallback }
}

// 注意：回访工作台返回零工完整手机号（workerPhone 不脱敏）是登记在案的 PII 例外——
// 运营需据此电话回访核验业务真实性，集成测试 L654 固化该契约；与默认脱敏 + user:read_pii 专项查看口径区分。
router.get('/callbacks', requirePermission('risk:read'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? 'WHERE cb.status = ?' : ''
  const params = status ? [status] : []
  const list = db.prepare(`
    SELECT cb.*, t.title, u.name AS worker_name, u.phone AS worker_phone, c.company_name
    FROM callbacks cb JOIN tasks t ON t.id = cb.task_id
    JOIN users u ON u.id = cb.worker_id JOIN companies c ON c.id = cb.company_id
    ${where} ORDER BY cb.id DESC LIMIT 100
  `).all(...params)
  res.json({
    total: list.length,
    list: list.map(x => ({
      id: x.id, taskId: x.task_id, taskTitle: x.title,
      workerName: x.worker_name, workerPhone: x.worker_phone, companyName: x.company_name,
      status: x.status, note: x.note, createdAt: x.created_at, doneAt: x.done_at
    }))
  })
})

router.post('/callbacks/:id/resolve', requirePermission('risk:resolve'), (req, res, next) => {
  try {
    const { confirmed, note } = z.object({
      confirmed: z.boolean(),
      note: readableText('回访备注', z.string().max(300).optional().default(''))
    }).parse(req.body)
    const cb = db.prepare(`SELECT cb.*, t.title, c.company_name FROM callbacks cb JOIN tasks t ON t.id = cb.task_id JOIN companies c ON c.id = cb.company_id WHERE cb.id = ?`).get(req.params.id)
    if (!cb) throw notFound('回访记录不存在')
    if (cb.status !== 'pending') throw conflict('ALREADY_DONE', '该回访已完成')
    db.prepare(`
      UPDATE callbacks SET status = ?, note = ?, done_at = datetime('now','localtime'), done_by = ? WHERE id = ?
    `).run(confirmed ? 'confirmed' : 'abnormal', note, req.user.id, cb.id)
    if (!confirmed) {
      db.prepare(`INSERT INTO risk_alerts (level, type, detail, ref_type, ref_id) VALUES ('高', '回访异常', ?, 'company', ?)`)
        .run(`任务#${cb.task_id}「${cb.title}」回访异常：${note || '零工否认提供服务'}，涉嫌虚构交易，请立即核查企业「${cb.company_name}」`, cb.company_id)
    }
    logAction(req.user.id, 'callback_resolve', `callback#${cb.id} ${confirmed ? '确认真实' : '异常'}`)
    res.json({ status: confirmed ? 'confirmed' : 'abnormal' })
  } catch (err) {
    next(err)
  }
})

// —— 保险理赔管理 ——
router.get('/claims', requirePermission('risk:read'), (req, res) => {
  const list = db.prepare(`
    SELECT cl.*, t.title, u.name AS worker_name FROM claims cl
    JOIN tasks t ON t.id = cl.task_id JOIN users u ON u.id = cl.worker_id
    ORDER BY cl.id DESC LIMIT 100
  `).all()
  res.json({
    total: list.length,
    list: list.map(x => ({
      id: x.id, taskTitle: x.title, workerName: x.worker_name, policyNo: x.policy_no,
      description: x.description, status: x.status, result: x.result,
      createdAt: x.created_at, closedAt: x.closed_at
    }))
  })
})

router.post('/claims/:id/process', requirePermission('risk:resolve'), (req, res, next) => {
  try {
    const { status, result } = z.object({
      status: z.enum(['processing', 'closed']),
      result: readableText('处理结果', z.string().max(300).optional().default(''))
    }).parse(req.body)
    const cl = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(req.params.id)
    if (!cl) throw notFound('理赔不存在')
    if (cl.status === 'closed') throw conflict('CLAIM_CLOSED', '理赔已结案，不可重新处理')
    db.prepare(`
      UPDATE claims SET status = ?, result = COALESCE(NULLIF(?, ''), result),
        closed_at = CASE WHEN ? = 'closed' THEN datetime('now','localtime') ELSE closed_at END
      WHERE id = ?
    `).run(status, result, status, cl.id)
    notify(cl.worker_id, 'member', status === 'closed' ? '理赔已办结' : '理赔处理中',
      status === 'closed' ? `您的理赔（保单 ${cl.policy_no}）已办结：${result || '详见保险公司通知'}` : '平台已协助保险公司受理您的报案，请保持电话畅通。')
    logAction(req.user.id, 'claim_process', `claim#${cl.id} ${status}`)
    res.json({ status })
  } catch (err) {
    next(err)
  }
})

// —— 防员转零：企业历史发薪名单维护 ——
router.get('/companies/:id/payroll', requirePermission('risk:read'), (req, res) => {
  const list = db.prepare(`SELECT name, created_at FROM payroll_names WHERE company_id = ? ORDER BY name`).all(req.params.id)
  res.json({ total: list.length, list })
})

router.post('/companies/:id/payroll', requirePermission('risk:resolve'), (req, res, next) => {
  try {
    const { names } = z.object({ names: z.array(readableText('姓名', z.string().min(2).max(30))).min(1).max(2000) }).parse(req.body)
    const c = db.prepare(`SELECT id, company_name FROM companies WHERE id = ?`).get(req.params.id)
    if (!c) throw notFound('企业不存在')
    const insert = db.prepare(`INSERT OR IGNORE INTO payroll_names (company_id, name) VALUES (?, ?)`)
    let added = 0
    for (const n of names) added += insert.run(c.id, n.trim()).changes
    logAction(req.user.id, 'payroll_upload', `company#${c.id} +${added}`)
    res.json({ added, total: db.prepare(`SELECT COUNT(*) AS n FROM payroll_names WHERE company_id = ?`).get(c.id).n })
  } catch (err) {
    next(err)
  }
})

// —— 同IP多账号关联（设备/IP画像轻量版）——
router.get('/risk/ip-graph', requirePermission('risk:read'), (_req, res) => {
  const rows = db.prepare(`
    SELECT ip, COUNT(DISTINCT user_id) AS users, GROUP_CONCAT(DISTINCT user_id) AS user_ids
    FROM login_logs WHERE ip IS NOT NULL AND created_at >= datetime('now','localtime','-30 days')
    GROUP BY ip HAVING users >= 3 ORDER BY users DESC LIMIT 50
  `).all()
  const nameOf = db.prepare(`SELECT name, role FROM users WHERE id = ?`)
  res.json({
    total: rows.length,
    list: rows.map(r => ({
      ip: r.ip,
      userCount: r.users,
      users: String(r.user_ids).split(',').slice(0, 10).map(id => {
        const u = nameOf.get(Number(id))
        return { id: Number(id), name: u?.name, role: u?.role }
      })
    }))
  })
})

// —— 发票管理与红冲 ——
router.get('/invoices', requirePermission('tax:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get().n
  const list = db.prepare(`
    SELECT i.*, t.title, c.company_name FROM invoices i
    JOIN tasks t ON t.id = i.task_id JOIN companies c ON c.id = i.company_id
    ORDER BY i.id DESC LIMIT ? OFFSET ?
  `).all(pageSize, offset)
  res.json({
    total,
    list: list.map(i => ({
      id: i.id, no: i.no, companyName: i.company_name, taskTitle: i.title,
      amount: centsToYuan(i.amount), taxRate: i.tax_rate, status: i.status,
      confirmNo: i.confirm_no, issuedAt: i.issued_at
    }))
  })
})

router.post('/invoices/:id/void', requirePermission('tax:declare'), stepUp, async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: readableText('红冲原因', z.string().min(2).max(200)) }).parse(req.body)
    const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id)
    if (!inv) throw notFound('发票不存在')
    if (inv.status === 'voided') throw conflict('ALREADY_VOIDED', '该发票已红冲')
    // 红字发票（红字确认单）留痕，与原票关联
    const red = await einvoiceRedFlush(inv.no, reason)
    db.prepare(`UPDATE invoices SET status = 'voided', red_invoice_no = ?, void_reason = ? WHERE id = ?`)
      .run(red.redInvoiceNo, reason, inv.id)
    notifyCompany(inv.company_id, 'review', '发票已红冲',
      `发票 ${inv.no}（¥${centsToYuan(inv.amount)}）已红冲作废（红字发票 ${red.redInvoiceNo}）：${reason}。如需重开请联系平台。`)
    logAction(req.user.id, 'invoice_void', `${inv.no} → ${red.redInvoiceNo}：${reason}`)
    res.json({ status: 'voided', redInvoiceNo: red.redInvoiceNo })
  } catch (err) {
    next(err)
  }
})

async function einvoiceRedFlush(invoiceNo, reason) {
  const { einvoice } = await import('../integrations/index.js')
  return einvoice.redFlush({ invoiceNo, reason })
}

// —— 进项优化看板（方案模块6）——
router.get('/tax/input-overview', requirePermission('tax:read'), (_req, res) => {
  const monthly = db.prepare(`
    SELECT period,
      SUM(CASE WHEN method = 'business_income' THEN gross ELSE 0 END) AS bi_gross,
      SUM(gross) AS total_gross
    FROM tax_records GROUP BY period ORDER BY period DESC LIMIT 6
  `).all()
  const totals = db.prepare(`
    SELECT SUM(CASE WHEN method = 'business_income' THEN gross ELSE 0 END) AS bi, SUM(gross) AS total FROM tax_records
  `).get()
  const persons = db.prepare(`SELECT COUNT(*) AS n FROM worker_profiles WHERE subject_type = 'person' AND verified = 1`).get().n
  const soletraders = db.prepare(`SELECT COUNT(*) AS n FROM worker_profiles WHERE subject_type = 'soletrader'`).get().n
  // 进项改善估算：个体户分包款可取得进项发票（按1%征收率估算可抵扣）
  const currentInput = Math.round((totals.bi || 0) * 0.01)
  const potentialInput = Math.round((totals.total || 0) * 0.5 * 0.01)
  res.json({
    soletraderCount: soletraders,
    personCount: persons,
    soletraderGrossRatio: totals.total ? ((totals.bi / totals.total) * 100).toFixed(2) + '%' : '0%',
    currentInputDeduction: centsToYuan(currentInput),
    potentialInputDeduction: centsToYuan(potentialInput),
    monthly: monthly.reverse().map(m => ({
      period: m.period,
      soletraderGross: centsToYuan(m.bi_gross),
      totalGross: centsToYuan(m.total_gross),
      ratio: m.total_gross ? ((m.bi_gross / m.total_gross) * 100).toFixed(1) + '%' : '0%'
    })),
    suggestion: '引导高收入自然人零工注册个体工商户可增加平台可得进项，直接改善增值税税负'
  })
})

// —— 平台初始报送（上线30日内向税务机关报送平台基本信息）——
// 季度涉税信息报送汇总（对齐15号公告：按所得类型分类汇总平台内从业人员收入）
// quarter 形如 2026Q2，缺省取当前季度。
router.get('/tax/quarter-summary', requirePermission('tax:read'), (req, res, next) => {
  try {
    const m = String(req.query.quarter || currentQuarter()).match(/^(\d{4})Q([1-4])$/)
    if (!m) throw badRequest('BAD_QUARTER', '季度格式应为 2026Q2')
    const year = Number(m[1]), q = Number(m[2])
    const startM = (q - 1) * 3 + 1
    const periods = [0, 1, 2].map(i => `${year}-${String(startM + i).padStart(2, '0')}`)
    const placeholders = periods.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT income_type,
             COUNT(DISTINCT worker_id) AS people,
             COUNT(*) AS records,
             COALESCE(SUM(gross),0) AS gross,
             COALESCE(SUM(tax),0) AS tax,
             COALESCE(SUM(vat),0) AS vat
      FROM tax_records WHERE period IN (${placeholders}) GROUP BY income_type
    `).all(...periods)
    const LABEL = { labor_continuous: '劳务报酬所得(连续性劳务)', labor_other: '劳务报酬所得(其他)', business: '经营所得' }
    const byType = rows.map(r => ({
      incomeType: r.income_type, label: LABEL[r.income_type] || r.income_type,
      people: r.people, records: r.records,
      gross: centsToYuan(r.gross), tax: centsToYuan(r.tax), vat: centsToYuan(r.vat)
    }))
    res.json({
      quarter: `${year}Q${q}`, periods,
      byType,
      totals: {
        gross: centsToYuan(rows.reduce((s, r) => s + r.gross, 0)),
        tax: centsToYuan(rows.reduce((s, r) => s + r.tax, 0)),
        vat: centsToYuan(rows.reduce((s, r) => s + r.vat, 0))
      }
    })
  } catch (err) {
    next(err)
  }
})

router.post('/tax/platform-report', requirePermission('tax:declare'), async (req, res, next) => {
  try {
    const done = db.prepare(`SELECT 1 FROM tax_declarations WHERE type = 'quarter_report' AND period = 'PLATFORM_INIT'`).get()
    if (done) throw conflict('ALREADY_REPORTED', '平台基本信息已报送')
    const receipt = await taxbureau.report({ period: 'PLATFORM_INIT', workers: 0 })
    db.prepare(`INSERT INTO tax_declarations (type, period, payload, receipt_no) VALUES ('quarter_report', 'PLATFORM_INIT', ?, ?)`)
      .run(JSON.stringify({ name: '灵工云平台', mode: '承揽后分包' }), receipt.fileNo)
    logAction(req.user.id, 'platform_init_report', receipt.fileNo)
    res.json({ fileNo: receipt.fileNo })
  } catch (err) {
    next(err)
  }
})

export default router
