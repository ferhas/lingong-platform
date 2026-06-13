// 评价与信用：结算后双向互盲评价 + 零工信用分。
// 互盲：双方都评完或窗口期满后才互相可见（防报复性差评）。
// 信用分（350-950，基础600）：完单加分 + 评分加减分 - 争议败诉扣分；应用于接单限制与企业选人参考。
import db from '../db.js'
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js'
import { getConfig } from './configStore.js'
import { notify } from './notify.js'

const CREDIT_MIN = 350
const CREDIT_MAX = 950
const CREDIT_BASE = 600

export function recalcWorkerCredit(workerId) {
  const settled = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE worker_id = ? AND status = 'settled'`).get(workerId).n
  const review = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(AVG(score), 3) AS avg FROM reviews WHERE reviewee_id = ? AND reviewer_role = 'company'
  `).get(workerId)
  const lost = db.prepare(`
    SELECT COALESCE(SUM(CASE d.ruling_type WHEN 'no_pay' THEN 1 ELSE 0 END), 0) AS noPay,
           COALESCE(SUM(CASE d.ruling_type WHEN 'partial_pay' THEN 1 ELSE 0 END), 0) AS partial
    FROM disputes d JOIN tasks t ON t.id = d.task_id
    WHERE t.worker_id = ? AND d.status IN ('executed','closed','escalated')
  `).get(workerId)

  let score = CREDIT_BASE
  score += Math.min(120, settled * 3)
  score += Math.round((review.avg - 3) * 30) * (review.n > 0 ? 1 : 0)
  score -= lost.noPay * 50 + lost.partial * 20
  score = Math.max(CREDIT_MIN, Math.min(CREDIT_MAX, score))
  db.prepare(`UPDATE worker_profiles SET credit_score = ? WHERE user_id = ?`).run(score, workerId)
  return score
}

/** 结算后互评（reviewer 须为任务当事方，窗口期内，UNIQUE(task_id, reviewer_role) 防重） */
export function submitReview({ taskId, reviewerRole, reviewerId, score, tags = [], comment = '' }) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
  if (!task) throw notFound('任务不存在')
  if (task.status !== 'settled') throw conflict('NOT_SETTLED', '任务结算后方可评价')

  const windowDays = getConfig('reviewWindowDays')
  const inWindow = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND settled_at >= datetime('now','localtime', ?)`)
    .get(taskId, `-${windowDays} days`)
  if (!inWindow) throw conflict('WINDOW_CLOSED', `结算后 ${windowDays} 天内方可评价`)

  let revieweeId
  if (reviewerRole === 'company') {
    revieweeId = task.worker_id
  } else {
    if (task.worker_id !== reviewerId) throw forbidden('仅任务承接零工可评价')
    revieweeId = db.prepare(`SELECT user_id FROM companies WHERE id = ?`).get(task.company_id).user_id
  }

  const allowedTags = getConfig('reviewTags')
  const badTags = tags.filter(t => !allowedTags.includes(t))
  if (badTags.length) throw badRequest('BAD_TAGS', `标签仅支持：${allowedTags.join('/')}`)

  const exists = db.prepare(`SELECT 1 FROM reviews WHERE task_id = ? AND reviewer_role = ?`).get(taskId, reviewerRole)
  if (exists) throw conflict('ALREADY_REVIEWED', '该任务已评价')

  db.prepare(`
    INSERT INTO reviews (task_id, reviewer_role, reviewer_id, reviewee_id, score, tags, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, reviewerRole, reviewerId, revieweeId, score, JSON.stringify(tags), comment)

  if (reviewerRole === 'company') {
    recalcWorkerCredit(task.worker_id)
    // 企业差评低于3分触发运营回访关注
    if (score <= 2) {
      notify(task.worker_id, 'review', '收到企业评价', `「${task.title}」企业已完成评价（互评期满或双方均评价后可见详情）。`)
    }
  }
  return { ok: true }
}

/** 互盲可见性：双方都评完或窗口期满 → 双方可见；否则仅可见自己的评价 */
export function getTaskReviews(taskId, viewerRole) {
  const rows = db.prepare(`SELECT * FROM reviews WHERE task_id = ?`).all(taskId)
  const windowDays = getConfig('reviewWindowDays')
  const windowClosed = !db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND settled_at >= datetime('now','localtime', ?)`)
    .get(taskId, `-${windowDays} days`)
  const bothDone = rows.length >= 2
  const view = r => ({
    reviewerRole: r.reviewer_role, score: r.score, tags: JSON.parse(r.tags), comment: r.comment, createdAt: r.created_at
  })
  if (bothDone || windowClosed) return { visible: true, reviews: rows.map(view) }
  return { visible: false, reviews: rows.filter(r => r.reviewer_role === viewerRole).map(view) }
}

/** 零工信用概况（企业选人 / 零工个人中心展示） */
export function workerCreditProfile(workerId) {
  const p = db.prepare(`SELECT credit_score FROM worker_profiles WHERE user_id = ?`).get(workerId)
  const stats = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(AVG(score), 0) AS avg FROM reviews WHERE reviewee_id = ? AND reviewer_role = 'company'
  `).get(workerId)
  const settled = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE worker_id = ? AND status = 'settled'`).get(workerId).n
  const skills = db.prepare(`SELECT skill, level FROM worker_skills WHERE worker_id = ? AND status = 'verified'`).all(workerId)
  return {
    creditScore: p?.credit_score ?? CREDIT_BASE,
    grade: gradeOf(p?.credit_score ?? CREDIT_BASE),
    settledCount: settled,
    reviewCount: stats.n,
    avgScore: stats.n ? Number(stats.avg.toFixed(1)) : null,
    verifiedSkills: skills
  }
}

function gradeOf(score) {
  if (score >= 750) return '优选'
  if (score >= 600) return '良好'
  if (score >= 450) return '一般'
  return '受限'
}

/** 信用接单限制：信用分低于阈值时，同时在接任务数限制为 1 */
export function checkOrderLimit(workerId) {
  const min = getConfig('creditMinForMultiOrder')
  const p = db.prepare(`SELECT credit_score FROM worker_profiles WHERE user_id = ?`).get(workerId)
  if ((p?.credit_score ?? CREDIT_BASE) >= min) return
  const active = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE worker_id = ? AND status IN ('working','delivered')`).get(workerId).n
  if (active >= 1) {
    throw conflict('CREDIT_LIMITED', '您的信用分偏低，同时仅可承接 1 个任务，请先完成在接任务（按时保质交付可恢复信用分）')
  }
}
