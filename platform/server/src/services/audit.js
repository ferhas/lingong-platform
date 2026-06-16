import db from '../db.js'
import { currentDateTime } from '../utils/ids.js'
import { auditRowHash, GENESIS } from '../utils/auditHash.js'
import { currentContext } from './requestContext.js'

const insert = db.prepare(`
  INSERT INTO audit_logs (user_id, action, detail, detail_json, ip, user_agent, geo, prev_hash, hash, created_at)
  VALUES (@user_id, @action, @detail, @detail_json, @ip, @user_agent, @geo, @prev_hash, @hash, @created_at)
`)
const lastHash = db.prepare(`SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1`)

/**
 * 全量写操作审计 + 防篡改哈希链 + 终端证据自动捕获。
 * 终端证据（IP/UA/geo）默认从请求上下文（requestContext 中间件）自动带入，无需逐处传参。
 * @param {number|null} userId
 * @param {string} action
 * @param {string} detail 人话摘要（≤500）
 * @param {{json?:any, ip?:string, userAgent?:string, geo?:string}} extra 结构化明细与终端证据覆盖
 *
 * 注：刻意不包裹事务——better-sqlite3 同步单线程，本函数内"读链尾→插入"之间无其他 JS 介入，
 * 同进程天然无竞态；且若被某外层 db.transaction 调用，包裹事务会触发"事务内开事务"报错（保持可嵌套）。
 */
export function logAction(userId, action, detail = '', extra = {}) {
  const ctx = currentContext() || {}
  const prev = lastHash.get()?.hash || GENESIS
  const row = {
    user_id: userId ?? null,
    action,
    detail: String(detail).slice(0, 500),
    detail_json: extra.json !== undefined ? String(JSON.stringify(extra.json)).slice(0, 2000) : null,
    ip: extra.ip ?? ctx.ip ?? null,
    user_agent: (extra.userAgent ?? ctx.userAgent ?? null) || null,
    geo: (extra.geo ?? ctx.geo ?? null) || null,
    created_at: currentDateTime(),
    prev_hash: prev
  }
  row.hash = auditRowHash(prev, row)
  insert.run(row)
  return row
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

/**
 * 校验哈希链完整性：从当前在库最早一行起逐行重算哈希并比对前后衔接。
 * 任意一行被改/删/插/重排都会令其后所有行对不上而被检出。
 * 锚定首行的 prev_hash（兼容 housekeeping 归档搬走早期行后的活动窗口）。
 */
export function verifyChain() {
  const rows = db.prepare(`SELECT * FROM audit_logs ORDER BY id ASC`).all()
  if (rows.length === 0) return { ok: true, count: 0, head: GENESIS }
  let prev = rows[0].prev_hash || GENESIS
  for (const r of rows) {
    if ((r.prev_hash || GENESIS) !== prev) {
      return { ok: false, count: rows.length, brokenAt: r.id, reason: 'PREV_MISMATCH' }
    }
    const expect = auditRowHash(prev, r)
    if (r.hash !== expect) {
      return { ok: false, count: rows.length, brokenAt: r.id, reason: 'HASH_MISMATCH' }
    }
    prev = r.hash
  }
  return { ok: true, count: rows.length, head: prev }
}
