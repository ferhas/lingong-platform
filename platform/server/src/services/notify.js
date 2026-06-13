// 多通道消息触达：站内信（全量事件）+ 短信（交易类白名单场景）+ 小程序订阅消息（占位）。
// 模板存 message_templates（运营端可编辑），外发记录 message_logs（计费审计与触达率统计）。
// 外发通道永不抛错阻塞业务主流程：失败仅落日志。
import db from '../db.js'
import { sms, wxsubscribe } from '../integrations/index.js'
import { getConfig } from './configStore.js'

const insert = db.prepare(`INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)`)
const qTemplate = db.prepare(`SELECT * FROM message_templates WHERE code = ? AND enabled = 1`)
const qMsgLog = db.prepare(`
  INSERT INTO message_logs (user_id, phone, channel, template_code, content, status, provider_msg_id, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const qUserPhone = db.prepare(`SELECT phone FROM users WHERE id = ?`)
const qUserOpenid = db.prepare(`SELECT wx_openid FROM users WHERE id = ?`)

export function notify(userId, type, title, body = '') {
  if (!userId) return
  insert.run(userId, type, title, body)
}

export function notifyMany(userIds, type, title, body = '') {
  for (const id of new Set(userIds.filter(Boolean))) insert.run(id, type, title, body)
}

/** 通知企业全部成员 */
export function notifyCompany(companyId, type, title, body = '') {
  const members = db.prepare(`SELECT user_id FROM company_members WHERE company_id = ?`).all(companyId)
  notifyMany(members.map(m => m.user_id), type, title, body)
}

function render(tpl, vars = {}) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''))
}

/**
 * 模板短信外发（白名单场景：录用/驳回/结算/提现结果/账号冻结/争议/验证码）。
 * 失败不抛错，仅写 message_logs；模板被运营停用时静默跳过。
 */
export async function sendTemplateSms(phone, templateCode, vars = {}, userId = null) {
  const tpl = qTemplate.get(templateCode)
  if (!tpl || tpl.channel !== 'sms' || !phone) return { sent: false }
  const content = render(tpl.body_tpl, vars)
  try {
    const r = await sms.send({ phone, content })
    qMsgLog.run(userId, phone, 'sms', templateCode, content, 'sent', r.msgId, null)
    return { sent: true, msgId: r.msgId }
  } catch (err) {
    qMsgLog.run(userId, phone, 'sms', templateCode, content, 'failed', null, String(err.message).slice(0, 200))
    return { sent: false, error: err.message }
  }
}

/** 按用户 ID 发模板短信（自动取注册手机号） */
export async function smsToUser(userId, templateCode, vars = {}) {
  const row = qUserPhone.get(userId)
  if (!row) return { sent: false }
  return sendTemplateSms(row.phone, templateCode, vars, userId)
}

/**
 * 微信订阅消息推送（小程序一次性订阅）。
 * 仅当运营已在小程序后台申请并配置 subscribeTmplIds、且用户绑定了微信(wx_openid) 时实际下发；
 * 否则静默跳过（仍有站内信兜底）。失败仅落 message_logs，不抛错。
 */
export async function sendSubscribe(userId, title, body, page) {
  const row = qUserOpenid.get(userId)
  if (!row || !row.wx_openid) return { sent: false }
  let tmplIds = []
  try { tmplIds = getConfig('subscribeTmplIds') } catch { tmplIds = [] }
  const templateId = Array.isArray(tmplIds) ? tmplIds[0] : null
  if (!templateId) return { sent: false }
  const data = { thing1: { value: String(title).slice(0, 20) }, thing2: { value: String(body).slice(0, 20) } }
  try {
    const r = await wxsubscribe.send({ openid: row.wx_openid, templateId, data, page })
    qMsgLog.run(userId, null, 'subscribe', templateId, `${title} ${body}`.slice(0, 200), 'sent', r.msgId, null)
    return { sent: true, msgId: r.msgId }
  } catch (err) {
    qMsgLog.run(userId, null, 'subscribe', templateId, `${title} ${body}`.slice(0, 200), 'failed', null, String(err.message).slice(0, 200))
    return { sent: false, error: err.message }
  }
}

/** 站内信 + 短信 + 微信订阅消息组合触达（短信/订阅异步不阻塞，调用方无需 await） */
export function notifyWithSms(userId, type, title, body, templateCode, vars = {}) {
  notify(userId, type, title, body)
  smsToUser(userId, templateCode, vars).catch(() => {})
  sendSubscribe(userId, title, body).catch(() => {})
}

export function listNotifications(userId, page = 1, pageSize = 20) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`).get(userId).n
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0`).get(userId).n
  const list = db.prepare(`
    SELECT id, type, title, body, read, created_at FROM notifications
    WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(userId, pageSize, (page - 1) * pageSize)
  return { total, unread, list }
}

export function markRead(userId, ids) {
  if (ids === 'all') {
    db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?`).run(userId)
  } else {
    const stmt = db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?`)
    for (const id of ids) stmt.run(userId, id)
  }
}
