import db from '../db.js'

const insert = db.prepare(`INSERT INTO audit_logs (user_id, action, detail) VALUES (?, ?, ?)`)

/** 全量写操作审计：logAction(req.user.id, 'task_publish', '任务#12 ...') */
export function logAction(userId, action, detail = '') {
  insert.run(userId ?? null, action, String(detail).slice(0, 500))
}

export function listAuditLogs({ page = 1, pageSize = 20, action, userId }) {
  const conds = []
  const params = []
  if (action) { conds.push(`a.action = ?`); params.push(action) }
  if (userId) { conds.push(`a.user_id = ?`); params.push(userId) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${where}`).get(...params).n
  const list = db.prepare(`
    SELECT a.*, u.name AS user_name, u.role AS user_role
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize)
  return { total, list }
}
