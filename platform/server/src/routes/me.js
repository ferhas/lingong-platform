// 全角色通用：站内通知 + 用户偏好设置 + 争议查看与举证 + 客服工单 + 帮助中心 + 协议版本同意
import { Router } from 'express'
import { z } from 'zod'
import db from '../db.js'
import { authenticate } from '../middleware/auth.js'
import { getMembership } from '../middleware/rbac.js'
import { notFound, forbidden, conflict, badRequest } from '../utils/errors.js'
import { listNotifications, markRead, notifyMany } from '../services/notify.js'
import { submitEvent, withdrawDispute, escalateDispute } from '../services/disputes.js'
import { logAction } from '../services/audit.js'
import { genNo } from '../utils/ids.js'
import { centsToYuan } from '../utils/money.js'
import { readableText } from '../utils/textQuality.js'
import { getLegalDoc, recordAgreements } from '../services/contractText.js'

const router = Router()
router.use(authenticate)

router.get('/notifications', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
  res.json(listNotifications(req.user.id, page, pageSize))
})

router.post('/notifications/read', (req, res, next) => {
  try {
    const { ids } = z.object({
      ids: z.union([z.literal('all'), z.array(z.number().int()).min(1)])
    }).parse(req.body)
    markRead(req.user.id, ids)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.get('/settings', (req, res) => {
  const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ?`).get(req.user.id)
  res.json(row ? JSON.parse(row.value) : {})
})

router.patch('/settings', (req, res, next) => {
  try {
    const patch = z.object({
      theme: z.enum(['light', 'dark', 'auto']).optional(),
      notifyEnabled: z.boolean().optional(),
      subscribeAuthorized: z.boolean().optional()
    }).parse(req.body)
    const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ?`).get(req.user.id)
    const merged = { ...(row ? JSON.parse(row.value) : {}), ...patch }
    db.prepare(`
      INSERT INTO user_settings (user_id, value) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')
    `).run(req.user.id, JSON.stringify(merged))
    res.json(merged)
  } catch (err) {
    next(err)
  }
})

// ============ 协议版本同意（PIPL：协议更新后强制重新同意） ============

router.get('/agreements/status', (req, res) => {
  const docs = ['tos', 'privacy'].map(type => {
    const doc = getLegalDoc(type)
    const agreed = db.prepare(`
      SELECT MAX(version) AS v FROM agreements WHERE user_id = ? AND doc_type = ?
    `).get(req.user.id, type)
    return { type, title: doc.title, currentVersion: doc.version, agreedVersion: agreed.v ?? 0, needReAgree: (agreed.v ?? 0) < doc.version }
  })
  res.json({ docs, needReAgree: docs.some(d => d.needReAgree) })
})

router.post('/agreements/re-agree', (req, res) => {
  recordAgreements(req.user.id)
  logAction(req.user.id, 'agreements_reagree', '')
  res.json({ ok: true })
})

// ============ 争议（双方共用：查看 / 举证留言 / 撤回 / 线下升级声明） ============

function disputeRole(user) {
  return user.role === 'company' ? 'company' : user.role
}

/** 当事方校验：零工=任务承接人；企业=任务发布企业成员 */
function assertParty(dispute, user) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(dispute.task_id)
  if (user.role === 'worker' && task.worker_id === user.id) return task
  if (user.role === 'company') {
    const m = getMembership(user.id)
    if (m && m.company_id === task.company_id) return task
  }
  if (user.role === 'admin') return task
  throw forbidden('非争议当事方')
}

const disputeView = (d, task) => ({
  id: d.id, no: d.no, taskId: d.task_id, taskTitle: task?.title,
  type: d.type, initiatorRole: d.initiator_role, claim: d.claim,
  claimAmount: centsToYuan(d.claim_amount), status: d.status,
  rulingType: d.ruling_type, rulingAmount: d.ruling_amount != null ? centsToYuan(d.ruling_amount) : null,
  rulingNote: d.ruling_note, stageDeadline: d.stage_deadline,
  createdAt: d.created_at, ruledAt: d.ruled_at, closedAt: d.closed_at
})

router.get('/disputes', (req, res) => {
  let rows
  if (req.user.role === 'worker') {
    rows = db.prepare(`
      SELECT d.*, t.title FROM disputes d JOIN tasks t ON t.id = d.task_id
      WHERE t.worker_id = ? ORDER BY d.id DESC LIMIT 50
    `).all(req.user.id)
  } else if (req.user.role === 'company') {
    const m = getMembership(req.user.id)
    rows = m ? db.prepare(`
      SELECT d.*, t.title FROM disputes d JOIN tasks t ON t.id = d.task_id
      WHERE t.company_id = ? ORDER BY d.id DESC LIMIT 50
    `).all(m.company_id) : []
  } else {
    rows = []
  }
  res.json({ total: rows.length, list: rows.map(d => disputeView(d, { title: d.title })) })
})

router.get('/disputes/:id', (req, res, next) => {
  try {
    const d = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(req.params.id)
    if (!d) throw notFound('争议不存在')
    const task = assertParty(d, req.user)
    const events = db.prepare(`SELECT * FROM dispute_events WHERE dispute_id = ? ORDER BY id`).all(d.id)
    res.json({
      ...disputeView(d, task),
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

router.post('/disputes/:id/events', (req, res, next) => {
  try {
    const body = z.object({
      content: readableText('留言内容', z.string().min(1).max(1000)),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    }).parse(req.body)
    const d = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(req.params.id)
    if (!d) throw notFound('争议不存在')
    assertParty(d, req.user)
    for (const uid of body.attachmentIds) {
      const owned = db.prepare(`SELECT 1 FROM uploads WHERE id = ? AND owner_id = ?`).get(uid, req.user.id)
      if (!owned) throw badRequest('BAD_ATTACHMENT', '附件不存在或不属于当前用户')
    }
    submitEvent(d.id, disputeRole(req.user), req.user.id, body.content, body.attachmentIds)
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.post('/disputes/:id/withdraw', (req, res, next) => {
  try {
    const d = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(req.params.id)
    if (!d) throw notFound('争议不存在')
    assertParty(d, req.user)
    const r = withdrawDispute(d.id, disputeRole(req.user), req.user.id)
    logAction(req.user.id, 'dispute_withdraw', d.no)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

router.post('/disputes/:id/escalate', (req, res, next) => {
  try {
    const d = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(req.params.id)
    if (!d) throw notFound('争议不存在')
    assertParty(d, req.user)
    const r = escalateDispute(d.id, disputeRole(req.user), req.user.id)
    logAction(req.user.id, 'dispute_escalate', d.no)
    res.json(r)
  } catch (err) {
    next(err)
  }
})

// ============ 客服工单 ============

const TICKET_CATEGORIES = ['account', 'realname', 'settlement', 'withdraw', 'invoice', 'tax', 'insurance', 'complaint', 'other']
// 资损类自动升级为紧急（SLA 2小时首响）
const AUTO_URGENT = new Set(['withdraw', 'settlement'])

function notifyAgents(title, body) {
  const agents = db.prepare(`
    SELECT u.id FROM users u JOIN admin_roles r ON r.id = u.admin_role_id
    WHERE u.role = 'admin' AND u.status = 'active' AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%ticket:manage%')
  `).all()
  notifyMany(agents.map(a => a.id), 'ticket', title, body)
}

router.post('/tickets', (req, res, next) => {
  try {
    const body = z.object({
      category: z.enum(TICKET_CATEGORIES),
      title: readableText('问题标题', z.string().min(2).max(80)),
      content: readableText('问题描述', z.string().min(5).max(2000)),
      refType: z.enum(['task', 'withdrawal', 'invoice', 'settlement', 'dispute']).optional(),
      refId: z.number().int().positive().optional(),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    }).parse(req.body)
    const no = genNo('TK')
    const priority = AUTO_URGENT.has(body.category) ? 'urgent' : body.category === 'complaint' ? 'high' : 'normal'
    const ticketId = db.transaction(() => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO tickets (no, user_id, category, priority, title, ref_type, ref_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(no, req.user.id, body.category, priority, body.title, body.refType ?? null, body.refId ?? null)
      db.prepare(`
        INSERT INTO ticket_messages (ticket_id, sender, sender_id, content, attachment_ids) VALUES (?, 'user', ?, ?, ?)
      `).run(lastInsertRowid, req.user.id, body.content, JSON.stringify(body.attachmentIds))
      return lastInsertRowid
    })()
    // 投诉举报联动风控（虚假任务/违法内容线索）
    if (body.category === 'complaint') {
      db.prepare(`INSERT INTO risk_alerts (level, type, detail, ref_type, ref_id) VALUES ('中', '用户投诉举报', ?, ?, ?)`)
        .run(`工单 ${no}：${body.title}（${body.content.slice(0, 100)}）`, body.refType ?? null, body.refId ?? null)
    }
    notifyAgents(priority === 'urgent' ? '【紧急】新客服工单' : '新客服工单', `${no}（${body.category}）：${body.title}`)
    logAction(req.user.id, 'ticket_create', no)
    res.status(201).json({ id: ticketId, no, priority })
  } catch (err) {
    next(err)
  }
})

const ticketView = t => ({
  id: t.id, no: t.no, category: t.category, priority: t.priority, title: t.title,
  refType: t.ref_type, refId: t.ref_id, status: t.status, satisfaction: t.satisfaction,
  createdAt: t.created_at, resolvedAt: t.resolved_at, closedAt: t.closed_at
})

router.get('/tickets', (req, res) => {
  const list = db.prepare(`SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(req.user.id)
  res.json({ total: list.length, list: list.map(ticketView) })
})

function myTicket(req) {
  const t = db.prepare(`SELECT * FROM tickets WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id)
  if (!t) throw notFound('工单不存在')
  return t
}

router.get('/tickets/:id', (req, res, next) => {
  try {
    const t = myTicket(req)
    const messages = db.prepare(`SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id`).all(t.id)
    res.json({
      ...ticketView(t),
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

router.post('/tickets/:id/messages', (req, res, next) => {
  try {
    const body = z.object({
      content: readableText('回复内容', z.string().min(1).max(2000)),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    }).parse(req.body)
    const t = myTicket(req)
    if (['resolved', 'closed'].includes(t.status)) throw conflict('TICKET_CLOSED', '工单已办结，如有新问题请新建工单')
    db.transaction(() => {
      db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, sender_id, content, attachment_ids) VALUES (?, 'user', ?, ?, ?)`)
        .run(t.id, req.user.id, body.content, JSON.stringify(body.attachmentIds))
      db.prepare(`UPDATE tickets SET status = 'pending_agent' WHERE id = ?`).run(t.id)
    })()
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.post('/tickets/:id/close', (req, res, next) => {
  try {
    const t = myTicket(req)
    if (t.status === 'closed') throw conflict('ALREADY_CLOSED', '工单已关闭')
    db.prepare(`UPDATE tickets SET status = 'closed', closed_at = datetime('now','localtime') WHERE id = ?`).run(t.id)
    res.json({ status: 'closed' })
  } catch (err) {
    next(err)
  }
})

router.post('/tickets/:id/rate', (req, res, next) => {
  try {
    const { satisfaction } = z.object({ satisfaction: z.number().int().min(1).max(5) }).parse(req.body)
    const t = myTicket(req)
    if (!['resolved', 'closed'].includes(t.status)) throw conflict('NOT_RESOLVED', '工单办结后方可评价')
    db.prepare(`UPDATE tickets SET satisfaction = ? WHERE id = ?`).run(satisfaction, t.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ============ 帮助中心 ============

router.get('/help', (req, res) => {
  const audience = req.user.role === 'admin' ? 'all' : req.user.role
  const list = db.prepare(`
    SELECT id, audience, category, title FROM help_articles
    WHERE status = 'published' AND (audience = 'all' OR audience = ?)
    ORDER BY sort DESC, id
  `).all(audience)
  const keyword = String(req.query.keyword || '')
  const filtered = keyword ? list.filter(a => a.title.includes(keyword) || a.category.includes(keyword)) : list
  res.json({ total: filtered.length, list: filtered })
})

router.get('/help/:id', (req, res, next) => {
  try {
    const a = db.prepare(`SELECT * FROM help_articles WHERE id = ? AND status = 'published'`).get(req.params.id)
    if (!a) throw notFound('文章不存在')
    res.json({ id: a.id, audience: a.audience, category: a.category, title: a.title, content: a.content, updatedAt: a.updated_at })
  } catch (err) {
    next(err)
  }
})

export default router
