// v5 商用化定时治理：争议超时流转 / 工单 SLA 升级 / 回调事件补单重放 / 充值单过期 / 导出申请过期
import db from '../db.js'
import { getConfig } from '../services/configStore.js'
import { notifyMany } from '../services/notify.js'
import { runDisputeTimeouts } from '../services/disputes.js'
import { replayEvent } from '../routes/webhooks.js'

export { runDisputeTimeouts }

/** 工单 SLA：超时未首响升级提醒（紧急2h/普通24h，参数可调），单工单只升级一次 */
export function runTicketSla() {
  const urgentHours = getConfig('ticketUrgentHours')
  const normalHours = getConfig('ticketNormalHours')
  const overdue = db.prepare(`
    SELECT * FROM tickets
    WHERE first_reply_at IS NULL AND escalated = 0 AND status NOT IN ('resolved','closed')
      AND ((priority = 'urgent' AND created_at <= datetime('now','localtime', ?))
        OR (priority IN ('high','normal') AND created_at <= datetime('now','localtime', ?)))
  `).all(`-${urgentHours} hours`, `-${normalHours} hours`)
  if (!overdue.length) return { escalated: 0 }

  const managers = db.prepare(`
    SELECT u.id FROM users u JOIN admin_roles r ON r.id = u.admin_role_id
    WHERE u.role = 'admin' AND u.status = 'active' AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%ticket:manage%')
  `).all().map(m => m.id)
  const mark = db.prepare(`UPDATE tickets SET escalated = 1 WHERE id = ?`)
  for (const t of overdue) {
    mark.run(t.id)
    notifyMany(managers, 'ticket', '【SLA超时】工单未首响',
      `工单 ${t.no}（${t.priority === 'urgent' ? '紧急' : '普通'}/${t.category}）已超首响时限，请立即处理：${t.title}`)
  }
  return { escalated: overdue.length }
}

/** 回调事件补单：重放 received/failed 事件（兜底主线，webhook 实时处理只是加速器） */
export function runWebhookRetry() {
  const events = db.prepare(`
    SELECT * FROM webhook_events WHERE status IN ('received','failed')
      AND received_at <= datetime('now','localtime','-2 minutes') ORDER BY id LIMIT 50
  `).all()
  let ok = 0, fail = 0
  for (const e of events) {
    const r = replayEvent(e)
    r.ok ? ok++ : fail++
  }
  return { scanned: events.length, ok, fail }
}

/** 充值单过期：超有效期未入金的充值单关闭（入金回调到达已过期单会被拒并预警） */
export function runRechargeExpire() {
  const minutes = getConfig('rechargeOrderExpireMinutes')
  const r = db.prepare(`
    UPDATE recharge_orders SET status = 'expired'
    WHERE status = 'created' AND created_at <= datetime('now','localtime', ?)
  `).run(`-${minutes} minutes`)
  // 导出申请下载窗口过期
  const e = db.prepare(`
    UPDATE export_requests SET status = 'expired'
    WHERE status = 'approved' AND expires_at <= datetime('now')
  `).run()
  return { expiredOrders: r.changes, expiredExports: e.changes }
}
