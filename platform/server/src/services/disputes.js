// 任务争议仲裁：
//   negotiating(协商48h) → arbitrating(平台介入，举证72h) → ruled(裁决) → executed(资金处置) → closed
//   任一环节发起方可 withdrawn（撤回/和解）；ruled 后任一方不服可 escalated（线下仲裁/诉讼，资金按裁决先行执行）
// 争议创建即在任务上打 dispute_id 标记：结算引擎入口校验该标记，冻结资金既不解冻也不结算。
import db from '../db.js'
import { genNo } from '../utils/ids.js'
import { badRequest, notFound, conflict, forbidden } from '../utils/errors.js'
import { getConfig } from './configStore.js'
import { notify, notifyCompany, notifyMany, smsToUser } from './notify.js'
import { raiseAlert } from './risk.js'
import { settleWithRuling } from './settlement.js'
import * as accounts from './accounts.js'
import { centsToYuan } from '../utils/money.js'
import { recalcWorkerCredit } from './credit.js'

const qDispute = db.prepare(`SELECT * FROM disputes WHERE id = ?`)
const qEvent = db.prepare(`
  INSERT INTO dispute_events (dispute_id, actor_role, actor_id, action, content, attachment_ids) VALUES (?, ?, ?, ?, ?, ?)
`)
const qOwnedUpload = db.prepare(`SELECT 1 FROM uploads WHERE id = ? AND owner_id = ?`)

function deadlineAfterHours(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString().replace('T', ' ').slice(0, 19)
}

export function addEvent(disputeId, actorRole, actorId, action, content = '', attachmentIds = []) {
  qEvent.run(disputeId, actorRole, actorId, action, content, JSON.stringify(attachmentIds))
}

function assertOwnedAttachments(actorId, attachmentIds) {
  for (const uid of attachmentIds) {
    if (!qOwnedUpload.get(uid, actorId)) {
      throw badRequest('BAD_ATTACHMENT', '附件不存在或不属于当前用户')
    }
  }
}

function notifyParties(task, title, body, exceptRole = null) {
  if (exceptRole !== 'worker' && task.worker_id) notify(task.worker_id, 'dispute', title, body)
  if (exceptRole !== 'company') notifyCompany(task.company_id, 'dispute', title, body)
}

function notifyArbiters(title, body) {
  const arbiters = db.prepare(`
    SELECT u.id FROM users u JOIN admin_roles r ON r.id = u.admin_role_id
    WHERE u.role = 'admin' AND u.status = 'active' AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%dispute:rule%')
  `).all()
  notifyMany(arbiters.map(a => a.id), 'dispute', title, body)
}

// 各争议类型的发起资格校验
const TYPE_RULES = {
  acceptance: { roles: ['worker'], statuses: ['working', 'delivered'], label: '验收争议' },
  payment_overdue: { roles: ['worker'], statuses: ['delivered'], label: '超期未验收' },
  worker_missing: { roles: ['company'], statuses: ['working'], label: '零工失联' },
  quality_after: { roles: ['company'], statuses: ['settled'], label: '结算后质量争议' },
  other: { roles: ['worker', 'company', 'admin'], statuses: ['working', 'delivered', 'settled'], label: '其他' }
}

export function createDispute({ task, type, initiatorRole, initiatorId, claim, claimAmount, attachmentIds = [] }) {
  const rule = TYPE_RULES[type]
  if (!rule) throw badRequest('BAD_TYPE', '不支持的争议类型')
  if (!rule.roles.includes(initiatorRole)) throw forbidden(`${rule.label}仅限${rule.roles.includes('worker') ? '零工' : '企业'}发起`)
  if (!rule.statuses.includes(task.status)) throw conflict('BAD_STATUS', '当前任务状态不可发起该类型争议')
  if (task.dispute_id) throw conflict('DISPUTE_EXISTS', '该任务已有处理中的争议')
  if (type === 'payment_overdue') {
    const overdueDays = getConfig('acceptOverdueDays')
    const overdue = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND delivered_at <= datetime('now','localtime', ?)`)
      .get(task.id, `-${overdueDays} days`)
    if (!overdue) throw badRequest('NOT_OVERDUE', `交付后超过 ${overdueDays} 天未验收方可发起该争议`)
  }
  // 结算处理中的任务不可发起（资金腿可能已在途）
  const settling = db.prepare(`SELECT status FROM settlements WHERE task_id = ?`).get(task.id)
  if (settling && settling.status !== 'done' && task.status !== 'settled') {
    throw conflict('SETTLING', '该任务结算处理中，暂不可发起争议，请联系平台客服')
  }
  assertOwnedAttachments(initiatorId, attachmentIds)

  const no = genNo('DSP')
  const negotiateHours = getConfig('disputeNegotiateHours')
  const disputeId = db.transaction(() => {
    // 事务内复查并以条件更新抢占争议锁：杜绝并发双开（多实例下两请求都通过事务外 :56 检查）
    const cur = db.prepare(`SELECT dispute_id FROM tasks WHERE id = ?`).get(task.id)
    if (cur?.dispute_id) throw conflict('DISPUTE_EXISTS', '该任务已有处理中的争议')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO disputes (no, task_id, type, initiator_role, initiator_id, claim, claim_amount, stage_deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(no, task.id, type, initiatorRole, initiatorId, claim, claimAmount, deadlineAfterHours(negotiateHours))
    const upd = db.prepare(`UPDATE tasks SET dispute_id = ? WHERE id = ? AND dispute_id IS NULL`).run(lastInsertRowid, task.id)
    if (upd.changes === 0) throw conflict('DISPUTE_EXISTS', '该任务已有处理中的争议')
    return lastInsertRowid
  })()
  addEvent(disputeId, initiatorRole, initiatorId, 'create', claim, attachmentIds)

  notifyParties(task, '收到任务争议',
    `任务「${task.title}」收到${rule.label}（${no}），现进入 ${negotiateHours} 小时协商期。双方可在线和解，逾期未和解将自动转平台仲裁。`,
    initiatorRole)
  notifyArbiters('新争议待关注', `争议 ${no}（${rule.label}）已创建，任务#${task.id}「${task.title}」，协商期 ${negotiateHours} 小时。`)
  return { id: disputeId, no }
}

/** 双方留言/举证（negotiating 与 arbitrating 期可提交） */
export function submitEvent(disputeId, actorRole, actorId, content, attachmentIds = []) {
  const d = qDispute.get(disputeId)
  if (!d) throw notFound('争议不存在')
  if (!['negotiating', 'arbitrating'].includes(d.status)) throw conflict('STAGE_CLOSED', '当前阶段不可提交留言或证据')
  addEvent(disputeId, actorRole, actorId, 'evidence', content, attachmentIds)
  return d
}

/** 发起方撤回（和解/放弃），解除争议锁 */
export function withdrawDispute(disputeId, actorRole, actorId) {
  const d = qDispute.get(disputeId)
  if (!d) throw notFound('争议不存在')
  if (d.initiator_role !== actorRole || d.initiator_id !== actorId) throw forbidden('仅发起方可撤回争议')
  if (!['negotiating', 'arbitrating'].includes(d.status)) throw conflict('STAGE_CLOSED', '当前阶段不可撤回')
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(d.task_id)
  db.transaction(() => {
    db.prepare(`UPDATE disputes SET status = 'withdrawn', closed_at = datetime('now','localtime') WHERE id = ?`).run(d.id)
    // 仅解除仍指向本争议的锁，避免误解他人争议的结算锁
    db.prepare(`UPDATE tasks SET dispute_id = NULL WHERE id = ? AND dispute_id = ?`).run(d.task_id, d.id)
  })()
  addEvent(d.id, actorRole, actorId, 'withdraw', '发起方撤回争议（已和解或放弃）')
  notifyParties(task, '争议已撤回', `争议 ${d.no} 已由发起方撤回，任务恢复正常流转。`)
  return { status: 'withdrawn' }
}

/** 平台受理（negotiating → arbitrating，设举证期） */
export function acceptDispute(disputeId, arbiterId) {
  const d = qDispute.get(disputeId)
  if (!d) throw notFound('争议不存在')
  if (d.status !== 'negotiating') throw conflict('BAD_STATUS', '仅协商期争议可受理转仲裁')
  const evidenceHours = getConfig('disputeEvidenceHours')
  db.prepare(`UPDATE disputes SET status = 'arbitrating', arbiter_id = ?, stage_deadline = ? WHERE id = ?`)
    .run(arbiterId, deadlineAfterHours(evidenceHours), d.id)
  addEvent(d.id, 'admin', arbiterId, 'accept', `平台受理，进入仲裁，双方请在 ${evidenceHours} 小时内提交证据`)
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(d.task_id)
  notifyParties(task, '争议已转平台仲裁',
    `争议 ${d.no} 已由平台受理，请双方在 ${evidenceHours} 小时内提交全部证据（交付记录/沟通截图等），逾期视为放弃举证。`)
  return { status: 'arbitrating' }
}

/**
 * 裁决（仲裁员，权限点 dispute:rule）。
 * 四种结果：full_pay 全额结算 / partial_pay 按裁决金额部分结算 / no_pay 不予结算全额解冻 / redeliver 限期重新交付。
 */
export function ruleDispute(disputeId, arbiterId, { rulingType, rulingAmount, rulingNote }) {
  const d = qDispute.get(disputeId)
  if (!d) throw notFound('争议不存在')
  if (d.status !== 'arbitrating') throw conflict('BAD_STATUS', '仅仲裁中的争议可裁决')
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(d.task_id)
  if (rulingType === 'partial_pay') {
    if (!rulingAmount || rulingAmount <= 0 || rulingAmount >= task.sub_price) {
      throw badRequest('BAD_RULING_AMOUNT', '部分结算金额须大于0且小于分包价')
    }
  }
  // 已结算任务（quality_after）：资金不可逆向扣划，仅支持记录性裁决（退款/红冲走线下通道）；重交付无意义
  if (task.status === 'settled' && rulingType === 'redeliver') {
    throw badRequest('BAD_RULING', '已结算任务不支持限期重交付裁决')
  }
  db.prepare(`
    UPDATE disputes SET status = 'ruled', ruling_type = ?, ruling_amount = ?, ruling_note = ?,
      ruled_at = datetime('now','localtime'), stage_deadline = ? WHERE id = ?
  `).run(rulingType, rulingType === 'partial_pay' ? rulingAmount : null, rulingNote, deadlineAfterHours(24), d.id)
  addEvent(d.id, 'admin', arbiterId, 'rule', `裁决：${rulingLabel(rulingType, rulingAmount)}。${rulingNote}`)
  notifyParties(task, '争议已裁决',
    `争议 ${d.no} 平台裁决：${rulingLabel(rulingType, rulingAmount)}。理由：${rulingNote}。裁决公示 24 小时后执行；对裁决不服可向平台所在地仲裁委员会或人民法院提起，平台将提供完整证据包。`)
  if (task.worker_id) smsToUser(task.worker_id, 'sms_dispute', { disputeNo: d.no, stage: '已裁决' }).catch(() => {})
  return { status: 'ruled' }
}

function rulingLabel(type, amount) {
  return {
    full_pay: '全额结算',
    partial_pay: `按 ¥${centsToYuan(amount ?? 0)} 部分结算（剩余解冻退回企业）`,
    no_pay: '不予结算（冻结资金全额解冻退回企业）',
    redeliver: '责令限期重新交付'
  }[type] || type
}

/** 执行裁决（资金处置，幂等：executed 后重复调用直接返回） */
export async function executeDispute(disputeId, operatorId) {
  const d = qDispute.get(disputeId)
  if (!d) throw notFound('争议不存在')
  if (d.status === 'executed' || d.status === 'closed') return { status: d.status, duplicated: true }
  if (d.status !== 'ruled' && d.status !== 'escalated') throw conflict('BAD_STATUS', '仅已裁决的争议可执行')
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(d.task_id)
  const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(task.company_id)

  // 幂等护栏：escalated 可能来自"已执行"态（closed_at 已写）。此时资金已按裁决处置完毕，
  // 二次执行只补记状态、绝不重复划款/解冻（no_pay 解冻无幂等屏障，重复会吃掉其他冻结额）。
  const alreadyExecuted = !!d.closed_at

  if (!alreadyExecuted && task.status !== 'settled') {
    switch (d.ruling_type) {
      case 'full_pay':
      case 'partial_pay': {
        // 幂等且对结算通道异常有韧性：结算单已 done（可能由结算重试 Job 补齐）则直接收尾；
        // 若通道异常留下 pending 单，settleWithRuling 抛 SETTLING/502，本次不解锁、不改争议状态，
        // 待结算重试 Job 完成后由超时 Job 再次执行收尾，避免争议永久卡在 ruled。
        const existed = db.prepare(`SELECT status FROM settlements WHERE task_id = ?`).get(task.id)
        if (existed?.status !== 'done') {
          await settleWithRuling(task, company, d.ruling_type === 'full_pay' ? task.sub_price : d.ruling_amount, d.no)
        }
        break
      }
      case 'no_pay':
        db.transaction(() => {
          db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run(task.id)
          accounts.unfreeze('company', company.id, task.price, task.id, `争议裁决不予结算，解冻退回：${task.title}`)
        })()
        if (task.worker_id) recalcWorkerCredit(task.worker_id)
        break
      case 'redeliver':
        db.transaction(() => {
          db.prepare(`UPDATE tasks SET status = 'working', deliverable = NULL, delivered_at = NULL WHERE id = ?`).run(task.id)
          db.prepare(`DELETE FROM task_attachments WHERE task_id = ? AND kind = 'deliverable'`).run(task.id)
        })()
        notify(task.worker_id, 'dispute', '请限期重新交付', `争议 ${d.no} 裁决要求重新交付「${task.title}」，请按交付标准修改后重新提交。`)
        break
    }
  }
  // 已结算任务：仅记录处置结论（退款/红冲走协商通道，不逆向扣划 C 端已提现资金）
  // 处置成功后才解除争议锁（仅当仍指向本争议）：pay 分支结算 pending 时上面已抛错返回，锁保留待下轮收尾。
  db.prepare(`UPDATE tasks SET dispute_id = NULL WHERE id = ? AND dispute_id = ?`).run(task.id, d.id)

  db.prepare(`UPDATE disputes SET status = 'executed', closed_at = COALESCE(closed_at, datetime('now','localtime')) WHERE id = ?`).run(d.id)
  if (!alreadyExecuted) {
    addEvent(d.id, 'admin', operatorId, 'execute', `裁决已执行：${rulingLabel(d.ruling_type, d.ruling_amount)}`)
    notifyParties(task, '争议处理完成', `争议 ${d.no} 裁决已执行完毕。`)
    if (d.ruling_type === 'partial_pay' && task.worker_id) recalcWorkerCredit(task.worker_id)
  }
  return { status: 'executed' }
}

/** 任一方对裁决不服（线下升级留痕，资金已按裁决先行执行） */
export function escalateDispute(disputeId, actorRole, actorId) {
  const d = qDispute.get(disputeId)
  if (!d) throw notFound('争议不存在')
  if (!['ruled', 'executed'].includes(d.status)) throw conflict('BAD_STATUS', '仅裁决后可声明线下升级')
  db.prepare(`UPDATE disputes SET status = 'escalated' WHERE id = ?`).run(d.id)
  addEvent(d.id, actorRole, actorId, 'escalate', '当事方声明向仲裁委/法院提起，平台将按需出具证据包')
  raiseAlert('中', '争议线下升级', `争议 ${d.no} 当事方声明线下升级，请运营准备证据包（四流归档一键导出）`)
  return { status: 'escalated' }
}

/** 超时流转 Job：协商期满自动转仲裁；仲裁举证期满提醒仲裁员；裁决公示期满自动执行；执行后24h归档关闭 */
export async function runDisputeTimeouts() {
  let toArbitrating = 0, reminders = 0, executed = 0, closed = 0
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

  for (const d of db.prepare(`SELECT * FROM disputes WHERE status = 'negotiating' AND stage_deadline <= ?`).all(now)) {
    const evidenceHours = getConfig('disputeEvidenceHours')
    db.prepare(`UPDATE disputes SET status = 'arbitrating', stage_deadline = ? WHERE id = ?`)
      .run(deadlineAfterHours(evidenceHours), d.id)
    addEvent(d.id, 'admin', 0, 'accept', '协商期满未和解，自动转平台仲裁')
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(d.task_id)
    notifyParties(task, '争议已转平台仲裁', `争议 ${d.no} 协商期满未和解，已自动转平台仲裁，请双方在 ${evidenceHours} 小时内提交证据。`)
    notifyArbiters('争议待仲裁', `争议 ${d.no} 已进入仲裁，请在举证期满后 3 个工作日内出具裁决。`)
    toArbitrating++
  }

  for (const d of db.prepare(`SELECT * FROM disputes WHERE status = 'arbitrating' AND stage_deadline <= ?`).all(now)) {
    notifyArbiters('争议举证期已满', `争议 ${d.no} 举证期已满，请尽快出具裁决（超期将升级至运营负责人）。`)
    reminders++
  }

  // 裁决公示期满（ruled.stage_deadline，默认24h）自动执行：否则结算锁永不解除，零工资金被永久冻结。
  for (const d of db.prepare(`SELECT id FROM disputes WHERE status = 'ruled' AND stage_deadline <= ?`).all(now)) {
    try {
      await executeDispute(d.id, 0)
      executed++
    } catch (err) {
      // 单条执行失败（如银行通道异常）不影响整批，结算单留 pending 由结算重试 Job 补齐
      console.error(`[disputeTimeouts] 自动执行争议#${d.id}失败:`, err.message)
    }
  }

  const r = db.prepare(`
    UPDATE disputes SET status = 'closed' WHERE status = 'executed' AND closed_at <= datetime('now','localtime','-1 day')
  `).run()
  closed = r.changes
  return { toArbitrating, reminders, executed, closed }
}
