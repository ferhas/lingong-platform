// 运营端 v5 商用化扩展：争议仲裁 / 客服工单 / 财务报表 / 导出审批 / 回调事件监控 /
// 消息模板 / 帮助中心 / 技能审核 / 进项台账 / 对账差异 / 结算治理 / 2FA / 系统健康
import { Router } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import db from '../db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { requirePermission, getPermissions, hasPermission } from '../middleware/rbac.js'
import { stepUp } from '../middleware/stepUp.js'
import { notFound, conflict, badRequest, forbidden } from '../utils/errors.js'
import { centsToYuan } from '../utils/money.js'
import { currentDate, currentPeriod } from '../utils/ids.js'
import { pageParams } from '../utils/pagination.js'
import { logAction } from '../services/audit.js'
import { notify } from '../services/notify.js'
import { readableText } from '../utils/textQuality.js'
import { acceptDispute, ruleDispute, executeDispute } from '../services/disputes.js'
import { retrySettlement } from '../services/settlement.js'
import { setConfig, getConfig } from '../services/configStore.js'
import * as finance from '../services/finance.js'
import { replayEvent } from './webhooks.js'
import { generateSecret, verifyTotp, otpauthUrl } from '../utils/totp.js'
import { raiseAlert } from '../services/risk.js'
import { healthCheck, einvoice } from '../integrations/index.js'
import { recalcWorkerCredit } from '../services/credit.js'
import * as secrets from '../services/secrets.js'

const router = Router()
router.use(authenticate, requireRole('admin'))

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

// ============ 2FA 绑定（运营账号自助） ============
router.post('/2fa/setup', (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)
  if (u.totp_enabled) return res.status(409).json({ error: { code: 'ALREADY_ENABLED', message: '已绑定动态码，如需更换请先解绑' } })
  const secret = generateSecret()
  db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(secret, u.id)
  res.json({ secret, otpauthUrl: otpauthUrl(secret, u.phone) })
})

router.post('/2fa/enable', (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().length(6) }).parse(req.body)
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)
    if (!u.totp_secret) throw badRequest('NO_SECRET', '请先获取绑定二维码')
    if (!verifyTotp(u.totp_secret, code)) throw badRequest('BAD_CODE', '动态码不正确，请确认时间同步后重试')
    db.prepare(`UPDATE users SET totp_enabled = 1 WHERE id = ?`).run(u.id)
    logAction(req.user.id, '2fa_enable', '')
    res.json({ enabled: true })
  } catch (err) {
    next(err)
  }
})

router.post('/2fa/disable', (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().length(6) }).parse(req.body)
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)
    if (!u.totp_enabled) throw conflict('NOT_ENABLED', '未绑定动态码')
    if (!verifyTotp(u.totp_secret, code)) throw badRequest('BAD_CODE', '动态码不正确')
    db.prepare(`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`).run(u.id)
    logAction(req.user.id, '2fa_disable', '')
    res.json({ enabled: false })
  } catch (err) {
    next(err)
  }
})

// ============ 争议仲裁工作台 ============
router.get('/disputes', requirePermission('dispute:read'), (req, res) => {
  const conds = []
  const params = []
  if (req.query.status && req.query.status !== 'all') { conds.push(`d.status = ?`); params.push(req.query.status) }
  if (req.query.type && req.query.type !== 'all') { conds.push(`d.type = ?`); params.push(req.query.type) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const list = db.prepare(`
    SELECT d.*, t.title, t.status AS task_status, t.sub_price, c.company_name, u.name AS worker_name
    FROM disputes d JOIN tasks t ON t.id = d.task_id
    JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = t.worker_id
    ${where} ORDER BY d.id DESC LIMIT 100
  `).all(...params)
  res.json({
    total: list.length,
    list: list.map(d => ({
      id: d.id, no: d.no, taskId: d.task_id, taskTitle: d.title, taskStatus: d.task_status,
      subPrice: centsToYuan(d.sub_price), companyName: d.company_name, workerName: d.worker_name,
      type: d.type, initiatorRole: d.initiator_role, claim: d.claim, claimAmount: centsToYuan(d.claim_amount),
      status: d.status, rulingType: d.ruling_type,
      rulingAmount: d.ruling_amount != null ? centsToYuan(d.ruling_amount) : null,
      stageDeadline: d.stage_deadline, createdAt: d.created_at, ruledAt: d.ruled_at
    }))
  })
})

router.get('/disputes/:id', requirePermission('dispute:read'), (req, res, next) => {
  try {
    const d = db.prepare(`
      SELECT d.*, t.title, t.status AS task_status, t.price, t.sub_price, t.deliverable, t.standard,
             c.company_name, u.name AS worker_name
      FROM disputes d JOIN tasks t ON t.id = d.task_id
      JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = t.worker_id
      WHERE d.id = ?
    `).get(req.params.id)
    if (!d) throw notFound('争议不存在')
    const events = db.prepare(`SELECT * FROM dispute_events WHERE dispute_id = ? ORDER BY id`).all(d.id)
    res.json({
      id: d.id, no: d.no, taskId: d.task_id, taskTitle: d.title, taskStatus: d.task_status,
      price: centsToYuan(d.price), subPrice: centsToYuan(d.sub_price),
      deliverable: d.deliverable, standard: d.standard,
      companyName: d.company_name, workerName: d.worker_name,
      type: d.type, initiatorRole: d.initiator_role, claim: d.claim, claimAmount: centsToYuan(d.claim_amount),
      status: d.status, rulingType: d.ruling_type,
      rulingAmount: d.ruling_amount != null ? centsToYuan(d.ruling_amount) : null,
      rulingNote: d.ruling_note, stageDeadline: d.stage_deadline,
      createdAt: d.created_at, ruledAt: d.ruled_at, closedAt: d.closed_at,
      timeline: events.map(e => ({
        id: e.id, actorRole: e.actor_role, action: e.action, content: e.content,
        attachments: JSON.parse(e.attachment_ids).map(id => ({ id, url: `/api/v1/files/${id}` })),
        createdAt: e.created_at
      }))
    })
  } catch (err) {
    next(err)
  }
})

router.post('/disputes/:id/accept', requirePermission('dispute:rule'), (req, res, next) => {
  try {
    const r = acceptDispute(Number(req.params.id), req.user.id)
    logAction(req.user.id, 'dispute_accept', `dispute#${req.params.id}`)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

router.post('/disputes/:id/rule', requirePermission('dispute:rule'), stepUp, (req, res, next) => {
  try {
    const body = z.object({
      rulingType: z.enum(['full_pay', 'partial_pay', 'no_pay', 'redeliver']),
      rulingAmount: z.number().positive().optional(),
      rulingNote: readableText('裁决理由', z.string().min(10, '裁决理由不少于10个字').max(1000))
    }).parse(req.body)
    const r = ruleDispute(Number(req.params.id), req.user.id, {
      rulingType: body.rulingType,
      rulingAmount: body.rulingAmount ? Math.round(body.rulingAmount * 100) : undefined,
      rulingNote: body.rulingNote
    })
    logAction(req.user.id, 'dispute_rule', `dispute#${req.params.id} ${body.rulingType}`)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

router.post('/disputes/:id/execute', requirePermission('dispute:rule'), stepUp, async (req, res, next) => {
  try {
    const r = await executeDispute(Number(req.params.id), req.user.id)
    logAction(req.user.id, 'dispute_execute', `dispute#${req.params.id}`)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

// ============ 客服工单工作台 ============
router.get('/tickets', requirePermission('ticket:read'), (req, res) => {
  const conds = []
  const params = []
  if (req.query.status && req.query.status !== 'all') { conds.push(`t.status = ?`); params.push(req.query.status) }
  if (req.query.category && req.query.category !== 'all') { conds.push(`t.category = ?`); params.push(req.query.category) }
  if (req.query.assignee) { conds.push(`t.assignee_id = ?`); params.push(Number(req.query.assignee)) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const list = db.prepare(`
    SELECT t.*, u.name AS user_name, u.role AS user_role, a.name AS assignee_name
    FROM tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assignee_id
    ${where} ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.id DESC LIMIT 100
  `).all(...params)
  res.json({
    total: list.length,
    list: list.map(t => ({
      id: t.id, no: t.no, userName: t.user_name, userRole: t.user_role,
      category: t.category, priority: t.priority, title: t.title,
      refType: t.ref_type, refId: t.ref_id, status: t.status, escalated: !!t.escalated,
      assigneeName: t.assignee_name, satisfaction: t.satisfaction,
      createdAt: t.created_at, firstReplyAt: t.first_reply_at, resolvedAt: t.resolved_at
    }))
  })
})

// 注意：工单详情返回创建人完整手机号（userPhone 不脱敏）是登记在案的 PII 例外——
// 客服需据此回拨处理诉求；与默认脱敏 + user:read_pii 专项查看口径区分。
router.get('/tickets/:id', requirePermission('ticket:read'), (req, res, next) => {
  try {
    const t = db.prepare(`
      SELECT t.*, u.name AS user_name, u.phone AS user_phone, u.role AS user_role FROM tickets t
      JOIN users u ON u.id = t.user_id WHERE t.id = ?
    `).get(req.params.id)
    if (!t) throw notFound('工单不存在')
    const messages = db.prepare(`SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id`).all(t.id)
    res.json({
      id: t.id, no: t.no, userName: t.user_name, userPhone: t.user_phone, userRole: t.user_role,
      category: t.category, priority: t.priority, title: t.title,
      refType: t.ref_type, refId: t.ref_id, status: t.status,
      assigneeId: t.assignee_id, satisfaction: t.satisfaction, createdAt: t.created_at,
      messages: messages.map(m => ({
        id: m.id, sender: m.sender, content: m.content,
        attachments: JSON.parse(m.attachment_ids).map(id => ({ id, url: `/api/v1/files/${id}` })),
        createdAt: m.created_at
      }))
    })
  } catch (err) {
    next(err)
  }
})

router.post('/tickets/:id/assign', requirePermission('ticket:manage'), (req, res, next) => {
  try {
    const { assigneeId } = z.object({ assigneeId: z.number().int().positive() }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id)
    if (!t) throw notFound('工单不存在')
    const a = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'active'`).get(assigneeId)
    if (!a) throw badRequest('BAD_ASSIGNEE', '受理人不存在或非运营账号')
    db.prepare(`UPDATE tickets SET assignee_id = ? WHERE id = ?`).run(assigneeId, t.id)
    notify(assigneeId, 'ticket', '工单已分派给您', `工单 ${t.no}（${t.category}）：${t.title}`)
    logAction(req.user.id, 'ticket_assign', `${t.no} → admin#${assigneeId}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.post('/tickets/:id/reply', requirePermission('ticket:manage'), (req, res, next) => {
  try {
    const { content } = z.object({ content: readableText('回复内容', z.string().min(1).max(2000)) }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id)
    if (!t) throw notFound('工单不存在')
    if (t.status === 'closed') throw conflict('TICKET_CLOSED', '工单已关闭')
    db.transaction(() => {
      db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, sender_id, content) VALUES (?, 'agent', ?, ?)`)
        .run(t.id, req.user.id, content)
      db.prepare(`
        UPDATE tickets SET status = 'pending_user', assignee_id = COALESCE(assignee_id, ?),
          first_reply_at = COALESCE(first_reply_at, datetime('now','localtime'))
        WHERE id = ?
      `).run(req.user.id, t.id)
    })()
    notify(t.user_id, 'ticket', '客服已回复您的工单', `工单 ${t.no}：${content.slice(0, 80)}`)
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.post('/tickets/:id/resolve', requirePermission('ticket:manage'), (req, res, next) => {
  try {
    const { note } = z.object({ note: readableText('办结说明', z.string().max(500).optional().default('')) }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id)
    if (!t) throw notFound('工单不存在')
    if (['resolved', 'closed'].includes(t.status)) throw conflict('ALREADY_RESOLVED', '工单已办结')
    db.transaction(() => {
      if (note) {
        db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, sender_id, content) VALUES (?, 'agent', ?, ?)`)
          .run(t.id, req.user.id, `【办结】${note}`)
      }
      db.prepare(`UPDATE tickets SET status = 'resolved', resolved_at = datetime('now','localtime') WHERE id = ?`).run(t.id)
    })()
    notify(t.user_id, 'ticket', '工单已办结', `工单 ${t.no} 已办结${note ? `：${note.slice(0, 80)}` : ''}，可在工单详情对本次服务评价。`)
    logAction(req.user.id, 'ticket_resolve', t.no)
    res.json({ status: 'resolved' })
  } catch (err) {
    next(err)
  }
})

// ============ 财务报表中心 ============
router.get('/finance/daily', requirePermission('finance:read'), (req, res) => {
  const day = String(req.query.day || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.day : currentDate()
  res.json(finance.dailyReport(day))
})

router.get('/finance/monthly', requirePermission('finance:read'), (req, res) => {
  const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : currentPeriod()
  res.json({
    operating: finance.operatingReport(period),
    taxReserve: finance.taxReserveReport(period),
    subjects: finance.subjectBalance(period)
  })
})

router.get('/finance/settlement-detail', requirePermission('finance:read'), (req, res) => {
  const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : currentPeriod()
  const rows = finance.settlementDetail(period)
  if (req.query.format === 'csv') {
    return sendCsv(res, `结算明细_${period}.csv`,
      ['结算单ID', '确认单号', '任务', '企业', '零工', '企业承担(元)', '零工计酬(元)', '个税(元)', '增值税(元)', '实发(元)', '服务费(元)', '计税方式', '完税凭证', '发票号', '裁决单', '完成时间'],
      rows.map(r => [r.id, r.confirmNo, r.taskTitle, r.companyName, r.workerName, r.charged, r.gross,
        r.tax, r.vat, r.net, r.margin, r.method, r.taxVoucherNo || '', r.invoiceNo || '', r.ruled ? '是' : '', r.doneAt]))
  }
  res.json({ period, total: rows.length, list: rows })
})

router.get('/finance/company-statement', requirePermission('finance:read'), (req, res, next) => {
  try {
    const companyId = Number(req.query.companyId)
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : currentPeriod()
    if (!companyId) throw badRequest('BAD_COMPANY', '请提供 companyId')
    const statement = finance.companyStatement(companyId, period)
    if (!statement) throw notFound('企业不存在')
    res.json(statement)
  } catch (err) {
    next(err)
  }
})

// ============ 个人信息导出审批（PIPL） ============
router.post('/exports', requirePermission('worker:read'), (req, res, next) => {
  try {
    const body = z.object({
      scope: readableText('导出范围', z.string().min(2).max(200)),
      reason: readableText('导出事由', z.string().min(5, '请说明导出事由').max(300)),
      rowEstimate: z.number().int().positive().optional()
    }).parse(req.body)
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO export_requests (applicant_id, scope, reason, row_estimate) VALUES (?, ?, ?, ?)
    `).run(req.user.id, body.scope, body.reason, body.rowEstimate ?? null)
    // PIPL 行数阈值：预计行数低于 exportApprovalRows 的小批量导出免双人审批，自动批准并开放限时下载
    const threshold = getConfig('exportApprovalRows')
    const autoApprove = body.rowEstimate != null && body.rowEstimate < threshold
    if (autoApprove) {
      const expiresAt = new Date(Date.now() + 48 * 3600000).toISOString()
      db.prepare(`
        UPDATE export_requests SET status = 'approved', approve_note = ?, expires_at = ?, approved_at = datetime('now','localtime')
        WHERE id = ?
      `).run(`系统自动批准：预计 ${body.rowEstimate} 行 < 审批阈值 ${threshold} 行（小批量免双人审批）`, expiresAt, lastInsertRowid)
    }
    logAction(req.user.id, 'export_apply', `export#${lastInsertRowid} ${body.scope}${autoApprove ? ' [自动批准]' : ''}`)
    res.status(201).json({ id: lastInsertRowid, status: autoApprove ? 'approved' : 'pending' })
  } catch (err) {
    next(err)
  }
})

router.get('/exports', requirePermission('worker:read'), (req, res) => {
  const list = db.prepare(`
    SELECT e.*, u.name AS applicant_name, a.name AS approver_name FROM export_requests e
    JOIN users u ON u.id = e.applicant_id LEFT JOIN users a ON a.id = e.approver_id
    ORDER BY e.id DESC LIMIT 100
  `).all()
  res.json({
    total: list.length,
    list: list.map(e => ({
      id: e.id, applicantName: e.applicant_name, scope: e.scope, reason: e.reason,
      rowEstimate: e.row_estimate, status: e.status, approverName: e.approver_name,
      approveNote: e.approve_note, expiresAt: e.expires_at, createdAt: e.created_at
    }))
  })
})

router.post('/exports/:id/approve', requirePermission('export:approve'), stepUp, (req, res, next) => {
  try {
    const { pass, note } = z.object({
      pass: z.boolean(),
      note: readableText('审批意见', z.string().max(200).optional().default(''))
    }).parse(req.body)
    const e = db.prepare(`SELECT * FROM export_requests WHERE id = ?`).get(req.params.id)
    if (!e) throw notFound('导出申请不存在')
    if (e.status !== 'pending') throw conflict('ALREADY_REVIEWED', '该申请已审批')
    if (e.applicant_id === req.user.id) throw badRequest('SELF_FORBIDDEN', '不能审批自己的导出申请')
    const expiresAt = pass ? new Date(Date.now() + 48 * 3600000).toISOString() : null
    db.prepare(`
      UPDATE export_requests SET status = ?, approver_id = ?, approve_note = ?, expires_at = ?, approved_at = datetime('now','localtime')
      WHERE id = ?
    `).run(pass ? 'approved' : 'rejected', req.user.id, note, expiresAt, e.id)
    notify(e.applicant_id, 'export', pass ? '导出申请已批准' : '导出申请被拒绝',
      pass ? `导出申请 #${e.id} 已批准，请在 48 小时内下载（超时失效）。` : `导出申请 #${e.id} 被拒绝：${note}`)
    logAction(req.user.id, 'export_review', `export#${e.id} ${pass ? '批准' : '拒绝'}`)
    res.json({ status: pass ? 'approved' : 'rejected' })
  } catch (err) {
    next(err)
  }
})

// 批准后限时下载（完整手机号版零工名册；每行尾列嵌入申请单号水印，全程审计）
router.get('/exports/:id/download', requirePermission('worker:read'), (req, res, next) => {
  try {
    const e = db.prepare(`SELECT * FROM export_requests WHERE id = ?`).get(req.params.id)
    if (!e) throw notFound('导出申请不存在')
    if (e.applicant_id !== req.user.id) throw forbidden('仅申请人可下载')
    if (!['approved', 'downloaded'].includes(e.status)) throw conflict('NOT_APPROVED', '申请未批准或已失效')
    if (new Date(e.expires_at) < new Date()) {
      db.prepare(`UPDATE export_requests SET status = 'expired' WHERE id = ?`).run(e.id)
      throw conflict('EXPIRED', '下载已过期，请重新申请')
    }
    const year = String(new Date().getFullYear())
    // PIPL 收口：自动批准（approver_id 为空）的小批量导出，下载行数受申报 rowEstimate 物理限制，
    // 杜绝"自报极小行数→自动批准→下载全量零工完整手机号"绕过双人审批的越权导出；人工审批（大批量）不设上限。
    const autoApproved = e.approver_id == null
    const rowCap = autoApproved ? Math.max(0, e.row_estimate ?? 0) : null
    if (rowCap != null) {
      const totalWorkers = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'worker'`).get().n
      if (totalWorkers > rowCap) {
        raiseAlert('高', '导出越权风险',
          `导出申请 #${e.id} 自动批准额度 ${rowCap} 行，全量零工 ${totalWorkers} 人——已按额度截断下载，疑似借小额申报套取全量名册，请合规复核`)
      }
    }
    const rows = db.prepare(`
      SELECT u.id, u.name, u.phone, p.verified, p.subject_type, p.locked, p.credit_score, u.status,
        (SELECT COALESCE(SUM(gross),0) FROM tax_records r WHERE r.worker_id = u.id AND r.period LIKE ?) AS year_gross
      FROM users u JOIN worker_profiles p ON p.user_id = u.id WHERE u.role = 'worker' ORDER BY u.id
      ${rowCap != null ? 'LIMIT ?' : ''}
    `).all(...(rowCap != null ? [`${year}-%`, rowCap] : [`${year}-%`]))
    db.prepare(`UPDATE export_requests SET status = 'downloaded', downloaded_at = datetime('now','localtime') WHERE id = ?`).run(e.id)
    logAction(req.user.id, 'export_download', `export#${e.id} rows=${rows.length}`)
    sendCsv(res, `零工名册_完整_${currentDate()}.csv`,
      ['ID', '姓名', '手机号', '已实名', '主体类型', '接单锁定', '信用分', '账号状态', '本年收入(元)', '水印'],
      rows.map(w => [w.id, w.name, w.phone, w.verified ? '是' : '否',
        w.subject_type === 'soletrader' ? '个体工商户' : '自然人',
        w.locked ? '是' : '否', w.credit_score, w.status, centsToYuan(w.year_gross), `EXPORT-${e.id}`]))
  } catch (err) {
    next(err)
  }
})

// ============ 零工 PII 查看（user:read_pii 专项权限 + 审计） ============
router.get('/workers/:id/pii', requirePermission('user:read_pii'), (req, res, next) => {
  try {
    const u = db.prepare(`
      SELECT u.id, u.name, u.phone, p.real_name, p.id_card_masked FROM users u
      JOIN worker_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'worker'
    `).get(req.params.id)
    if (!u) throw notFound('零工不存在')
    const idCard = secrets.readIdCard(u.id, req.user.id, 'admin_pii_view')
    logAction(req.user.id, 'pii_view', `worker#${u.id}`)
    res.json({ id: u.id, name: u.name, realName: u.real_name, phone: u.phone, idCard: idCard ?? u.id_card_masked })
  } catch (err) {
    next(err)
  }
})

// ============ 回调事件监控与重放 ============
router.get('/webhook-events', requirePermission('integration:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? `WHERE status = ?` : ''
  const params = status ? [status] : []
  const total = db.prepare(`SELECT COUNT(*) AS n FROM webhook_events ${where}`).get(...params).n
  const list = db.prepare(`SELECT * FROM webhook_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)
  res.json({
    total,
    list: list.map(e => ({
      id: e.id, provider: e.provider, eventId: e.event_id, eventType: e.event_type,
      payload: e.payload, status: e.status, error: e.error,
      receivedAt: e.received_at, processedAt: e.processed_at
    }))
  })
})

router.post('/webhook-events/:id/replay', requirePermission('integration:read'), (req, res, next) => {
  try {
    const e = db.prepare(`SELECT * FROM webhook_events WHERE id = ?`).get(req.params.id)
    if (!e) throw notFound('事件不存在')
    // 人工重放给一次干净的重试预算：复活死信(ignored)事件，让根因修复后能重新自动补单
    db.prepare(`UPDATE webhook_events SET attempts = 0 WHERE id = ?`).run(e.id)
    const r = replayEvent({ ...e, attempts: 0 })
    logAction(req.user.id, 'webhook_replay', `event#${e.id} ${r.ok ? 'ok' : r.error}`)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

router.get('/integration-calls', requirePermission('integration:read'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const conds = []
  const params = []
  if (req.query.provider && req.query.provider !== 'all') { conds.push(`provider = ?`); params.push(req.query.provider) }
  if (req.query.status && req.query.status !== 'all') { conds.push(`status = ?`); params.push(req.query.status) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM integration_calls ${where}`).get(...params).n
  const list = db.prepare(`SELECT * FROM integration_calls ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)
  res.json({
    total,
    list: list.map(c => ({
      id: c.id, provider: c.provider, action: c.action, bizRef: c.biz_ref,
      status: c.status, latencyMs: c.latency_ms, error: c.error, createdAt: c.created_at
    }))
  })
})

// ============ 消息模板与外发日志 ============
router.get('/message-templates', requirePermission('message:manage'), (_req, res) => {
  const list = db.prepare(`SELECT * FROM message_templates ORDER BY code`).all()
  res.json({
    list: list.map(t => ({
      code: t.code, channel: t.channel, titleTpl: t.title_tpl, bodyTpl: t.body_tpl,
      enabled: !!t.enabled, updatedAt: t.updated_at
    }))
  })
})

router.patch('/message-templates/:code', requirePermission('message:manage'), (req, res, next) => {
  try {
    const body = z.object({
      titleTpl: readableText('标题模板', z.string().min(2).max(50)).optional(),
      bodyTpl: readableText('正文模板', z.string().min(5).max(500)).optional(),
      enabled: z.boolean().optional()
    }).parse(req.body)
    const t = db.prepare(`SELECT * FROM message_templates WHERE code = ?`).get(req.params.code)
    if (!t) throw notFound('模板不存在')
    db.prepare(`
      UPDATE message_templates SET title_tpl = COALESCE(?, title_tpl), body_tpl = COALESCE(?, body_tpl),
        enabled = COALESCE(?, enabled), updated_at = datetime('now','localtime') WHERE code = ?
    `).run(body.titleTpl ?? null, body.bodyTpl ?? null, body.enabled == null ? null : (body.enabled ? 1 : 0), t.code)
    logAction(req.user.id, 'message_template_update', t.code)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.get('/message-logs', requirePermission('message:manage'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM message_logs`).get().n
  const sent = db.prepare(`SELECT COUNT(*) AS n FROM message_logs WHERE status = 'sent'`).get().n
  const list = db.prepare(`SELECT * FROM message_logs ORDER BY id DESC LIMIT ? OFFSET ?`).all(pageSize, offset)
  res.json({
    total,
    deliveryRate: total ? ((sent / total) * 100).toFixed(1) + '%' : '100%',
    list: list.map(m => ({
      id: m.id, userId: m.user_id, phone: m.phone ? m.phone.slice(0, 3) + '****' + m.phone.slice(-4) : null,
      channel: m.channel, templateCode: m.template_code, content: m.content,
      status: m.status, error: m.error, createdAt: m.created_at
    }))
  })
})

// ============ 帮助中心管理 ============
router.get('/help-articles', requirePermission('help:manage'), (_req, res) => {
  const list = db.prepare(`SELECT * FROM help_articles ORDER BY sort DESC, id`).all()
  res.json({ total: list.length, list })
})

const helpSchema = z.object({
  audience: z.enum(['worker', 'company', 'all']),
  category: readableText('分类', z.string().min(1).max(20)),
  title: readableText('标题', z.string().min(2).max(80)),
  content: readableText('正文', z.string().min(10)),
  sort: z.number().int().optional().default(0),
  status: z.enum(['published', 'draft']).optional().default('published')
})

router.post('/help-articles', requirePermission('help:manage'), (req, res, next) => {
  try {
    const body = helpSchema.parse(req.body)
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO help_articles (audience, category, title, content, sort, status, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(body.audience, body.category, body.title, body.content, body.sort, body.status, req.user.id)
    logAction(req.user.id, 'help_create', `#${lastInsertRowid} ${body.title}`)
    res.status(201).json({ id: lastInsertRowid })
  } catch (err) {
    next(err)
  }
})

router.patch('/help-articles/:id', requirePermission('help:manage'), (req, res, next) => {
  try {
    const body = helpSchema.partial().parse(req.body)
    const a = db.prepare(`SELECT id FROM help_articles WHERE id = ?`).get(req.params.id)
    if (!a) throw notFound('文章不存在')
    db.prepare(`
      UPDATE help_articles SET audience = COALESCE(?, audience), category = COALESCE(?, category),
        title = COALESCE(?, title), content = COALESCE(?, content), sort = COALESCE(?, sort),
        status = COALESCE(?, status), updated_at = datetime('now','localtime'), updated_by = ?
      WHERE id = ?
    `).run(body.audience ?? null, body.category ?? null, body.title ?? null, body.content ?? null,
      body.sort ?? null, body.status ?? null, req.user.id, a.id)
    logAction(req.user.id, 'help_update', `#${a.id}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ============ 技能认证审核 ============
router.get('/skills', requirePermission('skill:review'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? `WHERE s.status = ?` : ''
  const params = status ? [status] : []
  const list = db.prepare(`
    SELECT s.*, u.name AS worker_name FROM worker_skills s JOIN users u ON u.id = s.worker_id
    ${where} ORDER BY s.id DESC LIMIT 100
  `).all(...params)
  res.json({
    total: list.length,
    list: list.map(s => ({
      id: s.id, workerId: s.worker_id, workerName: s.worker_name, skill: s.skill, level: s.level,
      certUrl: s.cert_upload_id ? `/api/v1/files/${s.cert_upload_id}` : null,
      status: s.status, verifyNote: s.verify_note, createdAt: s.created_at
    }))
  })
})

router.post('/skills/:id/review', requirePermission('skill:review'), (req, res, next) => {
  try {
    const { pass, note } = z.object({
      pass: z.boolean(),
      note: readableText('审核意见', z.string().max(200).optional().default(''))
    }).parse(req.body)
    const s = db.prepare(`SELECT * FROM worker_skills WHERE id = ?`).get(req.params.id)
    if (!s) throw notFound('认证申请不存在')
    if (s.status !== 'pending') throw conflict('ALREADY_REVIEWED', '该申请已审核')
    db.prepare(`UPDATE worker_skills SET status = ?, verify_note = ?, verified_by = ? WHERE id = ?`)
      .run(pass ? 'verified' : 'rejected', note, req.user.id, s.id)
    notify(s.worker_id, 'skill', pass ? '技能认证通过' : '技能认证未通过',
      pass ? `您的「${s.skill}（${s.level}）」认证已通过，徽章已在任务大厅展示。` : `您的「${s.skill}」认证未通过：${note}`)
    logAction(req.user.id, 'skill_review', `skill#${s.id} ${pass ? '通过' : '拒绝'}`)
    res.json({ status: pass ? 'verified' : 'rejected' })
  } catch (err) {
    next(err)
  }
})

// ============ 进项发票台账（B线发票认证） ============
router.get('/input-invoices', requirePermission('tax:read'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? `WHERE i.status = ?` : ''
  const params = status ? [status] : []
  const list = db.prepare(`
    SELECT i.*, u.name AS worker_name, t.title FROM input_invoices i
    JOIN users u ON u.id = i.worker_id JOIN tasks t ON t.id = i.task_id
    ${where} ORDER BY i.id DESC LIMIT 100
  `).all(...params)
  res.json({
    total: list.length,
    list: list.map(i => ({
      id: i.id, workerName: i.worker_name, taskTitle: i.title, invoiceNo: i.invoice_no,
      amount: centsToYuan(i.amount), taxAmount: centsToYuan(i.tax_amount),
      invoiceType: i.invoice_type === 'special' ? '专票' : '普票',
      fileUrl: i.upload_id ? `/api/v1/files/${i.upload_id}` : null,
      status: i.status, verifyNote: i.verify_note, createdAt: i.created_at
    }))
  })
})

router.post('/input-invoices/:id/verify', requirePermission('tax:declare'), (req, res, next) => {
  try {
    const { status, note } = z.object({
      status: z.enum(['verified', 'rejected', 'deducted']),
      note: readableText('认证备注', z.string().max(200).optional().default(''))
    }).parse(req.body)
    const i = db.prepare(`SELECT * FROM input_invoices WHERE id = ?`).get(req.params.id)
    if (!i) throw notFound('进项发票不存在')
    // 已抵扣为终态，不可再改（防止 deducted→rejected 等无依据的状态横跳，与税务抵扣台账脱钩）
    if (i.status === 'deducted') throw conflict('ALREADY_DEDUCTED', '该进项发票已抵扣，状态不可再变更')
    db.prepare(`
      UPDATE input_invoices SET status = ?, verify_note = ?, verified_by = ?, verified_at = datetime('now','localtime') WHERE id = ?
    `).run(status, note, req.user.id, i.id)
    if (status === 'rejected') {
      notify(i.worker_id, 'invoice', '发票认证未通过', `发票 ${i.invoice_no} 认证未通过：${note}，请重新开具上传，否则影响结算。`)
    }
    logAction(req.user.id, 'input_invoice_verify', `inv#${i.id} ${status}`)
    res.json({ status })
  } catch (err) {
    next(err)
  }
})

// ============ 发票红冲重开（红字发票号留痕 + 关联重开） ============
router.post('/invoices/:id/reissue', requirePermission('tax:declare'), stepUp, async (req, res, next) => {
  try {
    const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id)
    if (!inv) throw notFound('发票不存在')
    if (inv.status !== 'voided') throw conflict('NOT_VOIDED', '仅已红冲的发票可重开')
    const reissued = db.prepare(`SELECT id FROM invoices WHERE original_invoice_id = ?`).get(inv.id)
    if (reissued) throw conflict('ALREADY_REISSUED', '该发票已重开')
    const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(inv.company_id)
    const issued = await einvoice.issue({
      title: company.company_name, taxNo: company.license_no, amountCents: inv.amount, item: inv.item
    })
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO invoices (no, company_id, task_id, amount, tax_rate, item, confirm_no, original_invoice_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(issued.invoiceNo, inv.company_id, inv.task_id, inv.amount, inv.tax_rate, inv.item, inv.confirm_no, inv.id)
    logAction(req.user.id, 'invoice_reissue', `${inv.no} → ${issued.invoiceNo}`)
    res.status(201).json({ id: lastInsertRowid, no: issued.invoiceNo })
  } catch (err) {
    next(err)
  }
})

// ============ 逐笔对账差异工作台 ============
router.get('/recon-diffs', requirePermission('flow:read'), (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null
  const where = status ? `WHERE status = ?` : ''
  const params = status ? [status] : []
  const list = db.prepare(`SELECT * FROM recon_diffs ${where} ORDER BY id DESC LIMIT 100`).all(...params)
  res.json({
    total: list.length,
    list: list.map(d => ({
      id: d.id, day: d.day, side: d.side, refNo: d.ref_no, amount: centsToYuan(d.amount),
      detail: d.detail, status: d.status, resolveNote: d.resolve_note,
      createdAt: d.created_at, resolvedAt: d.resolved_at
    }))
  })
})

router.post('/recon-diffs/:id/resolve', requirePermission('flow:write'), (req, res, next) => {
  try {
    const { note } = z.object({ note: readableText('处置说明', z.string().min(2).max(300)) }).parse(req.body)
    const d = db.prepare(`SELECT * FROM recon_diffs WHERE id = ?`).get(req.params.id)
    if (!d) throw notFound('差异记录不存在')
    if (d.status === 'resolved') throw conflict('ALREADY_RESOLVED', '该差异已处置')
    db.prepare(`
      UPDATE recon_diffs SET status = 'resolved', resolve_note = ?, resolved_at = datetime('now','localtime') WHERE id = ?
    `).run(note, d.id)
    logAction(req.user.id, 'recon_diff_resolve', `diff#${d.id}：${note}`)
    res.json({ status: 'resolved' })
  } catch (err) {
    next(err)
  }
})

// ============ 结算治理：人工重推 + 全局应急开关 ============
router.post('/settlements/:id/retry', requirePermission('flow:write'), stepUp, async (req, res, next) => {
  try {
    const r = await retrySettlement(Number(req.params.id))
    logAction(req.user.id, 'settlement_retry', `settlement#${req.params.id} ${r.ok ? 'done' : r.error}`)
    res.json(r.ok ? { status: 'done', data: r.data } : { status: 'pending', error: r.error })
  } catch (err) {
    next(err)
  }
})

router.post('/fund-switches', requirePermission('config:write'), stepUp, (req, res, next) => {
  try {
    const body = z.object({
      settlementPaused: z.boolean().optional(),
      withdrawalPaused: z.boolean().optional()
    }).parse(req.body)
    const changed = {}
    for (const key of ['settlementPaused', 'withdrawalPaused']) {
      if (body[key] != null) {
        setConfig(key, body[key] ? 1 : 0, req.user.id)
        changed[key] = body[key]
        if (body[key]) {
          raiseAlert('高', '资金应急开关', `运营已开启全局${key === 'settlementPaused' ? '结算' : '提现'}暂停（应急止血），请尽快定位影响面并恢复`)
        }
      }
    }
    logAction(req.user.id, 'fund_switches', JSON.stringify(changed))
    res.json({
      settlementPaused: !!getConfig('settlementPaused'),
      withdrawalPaused: !!getConfig('withdrawalPaused')
    })
  } catch (err) {
    next(err)
  }
})

// ============ 防员转零白名单豁免（存量人员合规迁移评估通过后放行） ============
router.post('/companies/:id/payroll/exempt', requirePermission('risk:resolve'), (req, res, next) => {
  try {
    const { name, exempt, note } = z.object({
      name: readableText('姓名', z.string().min(2).max(30)),
      exempt: z.boolean(),
      note: readableText('评估结论', z.string().min(2, '请填写迁移评估结论').max(300))
    }).parse(req.body)
    const row = db.prepare(`SELECT * FROM payroll_names WHERE company_id = ? AND name = ?`).get(req.params.id, name)
    if (!row) throw notFound('该姓名不在企业发薪名单中')
    db.prepare(`UPDATE payroll_names SET exempt = ?, exempt_note = ? WHERE id = ?`).run(exempt ? 1 : 0, note, row.id)
    logAction(req.user.id, 'payroll_exempt', `company#${req.params.id} ${name} exempt=${exempt}：${note}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ============ 税务申报辅助：扣缴端导入文件 + 回执回填 ============
router.get('/tax/declare-file', requirePermission('tax:read'), (req, res) => {
  const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : currentPeriod()
  const rows = db.prepare(`
    SELECT r.*, u.name AS worker_name, p.id_card_masked FROM tax_records r
    JOIN users u ON u.id = r.worker_id JOIN worker_profiles p ON p.user_id = r.worker_id
    WHERE r.period = ? AND r.method = 'cumulative' ORDER BY r.worker_id
  `).all(period)
  const INCOME_LABEL = { labor_continuous: '劳务报酬所得(连续性劳务)', labor_other: '劳务报酬所得', business: '经营所得' }
  sendCsv(res, `扣缴申报导入_${period}.csv`,
    ['姓名', '证件号码(脱敏)', '所得项目', '计税方式', '连续取得月份数', '收入额(元)', '减除费用(元)', '已预扣税额(元)', '所属期'],
    rows.map(r => [r.worker_name, r.id_card_masked || '', INCOME_LABEL[r.income_type] || '劳务报酬所得',
      '累计预扣法', r.consecutive_months ?? '',
      centsToYuan(r.gross), centsToYuan(Math.round(r.gross * 0.2)), centsToYuan(r.tax), r.period]))
})

router.post('/tax/declarations/:id/receipt', requirePermission('tax:declare'), (req, res, next) => {
  try {
    const { receiptNo } = z.object({ receiptNo: z.string().min(4).max(40) }).parse(req.body)
    const d = db.prepare(`SELECT * FROM tax_declarations WHERE id = ?`).get(req.params.id)
    if (!d) throw notFound('申报记录不存在')
    db.prepare(`UPDATE tax_declarations SET receipt_no = ?, status = 'filed' WHERE id = ?`).run(receiptNo, d.id)
    logAction(req.user.id, 'tax_receipt_fill', `declaration#${d.id} ${receiptNo}`)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ============ 开放 API 凭据管理（大客户系统直连，HMAC 鉴权） ============
router.get('/api-credentials', requirePermission('config:read'), (_req, res) => {
  const list = db.prepare(`
    SELECT a.*, c.company_name FROM api_credentials a JOIN companies c ON c.id = a.company_id ORDER BY a.id DESC
  `).all()
  res.json({
    total: list.length,
    list: list.map(a => ({
      id: a.id, companyId: a.company_id, companyName: a.company_name,
      appKey: a.app_key, scopes: JSON.parse(a.scopes), status: a.status, createdAt: a.created_at
    }))
  })
})

router.post('/api-credentials', requirePermission('config:write'), stepUp, (req, res, next) => {
  try {
    const body = z.object({
      companyId: z.number().int().positive(),
      scopes: z.array(z.enum(['task:create', 'task:read'])).min(1).optional().default(['task:create', 'task:read'])
    }).parse(req.body)
    const c = db.prepare(`SELECT * FROM companies WHERE id = ? AND status = 'approved'`).get(body.companyId)
    if (!c) throw badRequest('BAD_COMPANY', '企业不存在或未通过准入')
    const appKey = 'AK' + crypto.randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()
    const appSecret = crypto.randomBytes(24).toString('hex')
    const secretHash = crypto.createHash('sha256').update(appSecret).digest('hex')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO api_credentials (company_id, app_key, app_secret_hash, scopes) VALUES (?, ?, ?, ?)
    `).run(body.companyId, appKey, secretHash, JSON.stringify(body.scopes))
    logAction(req.user.id, 'api_credential_create', `company#${body.companyId} ${appKey}`)
    // appSecret 仅创建时返回一次，平台只存哈希
    res.status(201).json({ id: lastInsertRowid, appKey, appSecret, scopes: body.scopes })
  } catch (err) {
    next(err)
  }
})

// 停用为「降权/应急吊销」操作，刻意不挂 stepUp：紧急止血不应被二次验证拖慢；
// step-up 只把守「授权类」操作（create/enable 授予访问）。此非对称是有意的最小阻力安全设计。
router.post('/api-credentials/:id/disable', requirePermission('config:write'), (req, res, next) => {
  try {
    const a = db.prepare(`SELECT * FROM api_credentials WHERE id = ?`).get(req.params.id)
    if (!a) throw notFound('凭据不存在')
    db.prepare(`UPDATE api_credentials SET status = 'disabled' WHERE id = ?`).run(a.id)
    logAction(req.user.id, 'api_credential_disable', a.app_key)
    res.json({ status: 'disabled' })
  } catch (err) {
    next(err)
  }
})

// 重新启用凭据（误停用/暂时停用后恢复）：补齐 active↔disabled 双向，避免停用即单向死态
router.post('/api-credentials/:id/enable', requirePermission('config:write'), stepUp, (req, res, next) => {
  try {
    const a = db.prepare(`SELECT * FROM api_credentials WHERE id = ?`).get(req.params.id)
    if (!a) throw notFound('凭据不存在')
    const c = db.prepare(`SELECT status FROM companies WHERE id = ?`).get(a.company_id)
    if (!c || c.status !== 'approved') throw badRequest('BAD_COMPANY', '所属企业未通过准入，不可启用凭据')
    db.prepare(`UPDATE api_credentials SET status = 'active' WHERE id = ?`).run(a.id)
    logAction(req.user.id, 'api_credential_enable', a.app_key)
    res.json({ status: 'active' })
  } catch (err) {
    next(err)
  }
})

// ============ 系统健康（Job 哑死检测 / 回调积压 / 资金开关 / 结算单据） ============
router.get('/system-health', requirePermission('integration:read'), async (_req, res) => {
  const jobs = db.prepare(`SELECT * FROM job_runs ORDER BY job`).all()
  const webhookBacklog = db.prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE status IN ('received','failed')`).get().n
  const pendingSettlements = db.prepare(`
    SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM settlements WHERE status = 'pending'
  `).get()
  const failedSettlements = db.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE status = 'failed'`).get().n
  const processingWithdrawals = db.prepare(`
    SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM withdrawals WHERE status IN ('applied','processing')
  `).get()
  const negativeAccounts = db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE balance < 0 OR frozen < 0 OR balance < frozen`).get().n
  const lastRecon = db.prepare(`SELECT * FROM reconciliation_daily ORDER BY day DESC LIMIT 1`).get()
  res.json({
    switches: {
      settlementPaused: !!getConfig('settlementPaused'),
      withdrawalPaused: !!getConfig('withdrawalPaused')
    },
    jobs: jobs.map(j => ({
      job: j.job, lastRunAt: j.last_run_at, lastSuccessAt: j.last_success_at,
      lastResult: j.last_result, lastError: j.last_error
    })),
    webhookBacklog,
    settlements: { pending: pendingSettlements.n, pendingOldest: pendingSettlements.oldest, failed: failedSettlements },
    withdrawals: { inflight: processingWithdrawals.n, oldest: processingWithdrawals.oldest },
    negativeAccounts,
    lastReconciliation: lastRecon ? { day: lastRecon.day, status: lastRecon.status, diff: centsToYuan(lastRecon.diff) } : null,
    integrations: await healthCheck()
  })
})

export default router
