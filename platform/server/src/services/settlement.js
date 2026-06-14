// 两阶段结算：
//   阶段1（事务）：四流硬校验 → 算税定格 → 落 settlements 单据（task_id 唯一 = 幂等屏障）
//   阶段2：逐腿执行外部分账（幂等键消重）+ 数电票开具，全部成功后在单事务内完成本地账务与单据闭环
//   任意外部腿失败：单据停留 pending，由 settlementRetry Job 自动重试；3次失败转 failed + 高风险预警
//   v5：全局结算应急开关 / 争议锁（dispute_id 非空阻断）/ 按裁决金额部分结算（ruled_gross）
import db from '../db.js'
import { genNo, currentPeriod } from '../utils/ids.js'
import { badRequest, conflict, ApiError } from '../utils/errors.js'
import * as accounts from './accounts.js'
import * as taxEngine from './taxEngine.js'
import * as risk from './risk.js'
import { getConfig } from './configStore.js'
import { notify, notifyMany, notifyWithSms } from './notify.js'
import { escrow, einvoice } from '../integrations/index.js'
import { centsToYuan } from '../utils/money.js'

const qSettlement = db.prepare(`SELECT * FROM settlements WHERE task_id = ?`)
const qSaveLegs = db.prepare(`UPDATE settlements SET legs_done = ?, invoice_no = COALESCE(?, invoice_no) WHERE id = ?`)
const qFail = db.prepare(`UPDATE settlements SET attempts = ?, last_error = ?, status = ? WHERE id = ?`)

function assertNotPaused() {
  if (getConfig('settlementPaused')) {
    throw new ApiError(503, 'SETTLEMENT_PAUSED', '平台结算通道维护中，请稍后再试（应急开关已启用）')
  }
}

/**
 * 验收并结算（入口）。校验 + 建单 + 尝试推进。
 * 外部通道异常时抛 502，单据已落库，Job 会自动重试。
 */
export async function acceptAndSettle(task, company) {
  assertNotPaused()
  // —— 争议锁：争议处理中的任务冻结资金既不解冻也不结算 ——
  if (task.dispute_id) throw conflict('DISPUTE_LOCKED', '该任务存在处理中的争议，结算已冻结，请等待争议处理完成')

  // —— 四流硬校验（系统级事前阻断）——
  if (!task.sub_order_no) throw badRequest('NO_WORK_ORDER', '四流校验失败：无签约分包工单不可结算')
  if (!task.deliverable) throw badRequest('NO_DELIVERABLE', '四流校验失败：无交付物不可验收')
  if (task.status !== 'delivered') throw conflict('BAD_STATUS', '当前状态不可验收')

  const existing = qSettlement.get(task.id)
  if (existing) {
    if (existing.status === 'done') throw conflict('ALREADY_SETTLED', '该任务已结算')
    throw conflict('SETTLING', '该任务结算处理中，请勿重复操作')
  }

  const worker = getWorker(task.worker_id)

  // —— B线（个体户）发票流硬校验：须有「未被驳回」的进项发票 ——
  // 仅看附件存在会被作废票占位绕过；这里以进项台账状态为准（被运营驳回 rejected 的票不计）。
  if (worker.subject_type === 'soletrader') {
    const inv = db.prepare(`SELECT 1 FROM input_invoices WHERE task_id = ? AND status != 'rejected'`).get(task.id)
    if (!inv) {
      throw badRequest('NO_INPUT_INVOICE', '四流校验失败：个体工商户零工须先向平台上传有效进项发票（B线进项凭证）方可结算')
    }
  }

  const settlementId = createSettlementRecord(task, company, worker, task.sub_price, null)

  // —— 阶段2：推进外部腿并完成 ——
  const s = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(settlementId)
  const result = await processSettlement(s)
  if (!result.ok) {
    throw new ApiError(502, 'SETTLE_PENDING', '银行分账通道异常，结算已受理，系统将自动重试完成，请稍后查看')
  }
  return result.data
}

/**
 * 按争议裁决结算（争议执行专用）：
 * 零工按裁决金额计酬（ruledGross ≤ 分包价），企业按比例承担承揽价，剩余冻结资金解冻退回。
 * 跳过交付物校验（裁决即结算依据），仍按主体标签算税。
 */
export async function settleWithRuling(task, company, ruledGross, disputeNo) {
  assertNotPaused()
  if (ruledGross <= 0 || ruledGross > task.sub_price) throw badRequest('BAD_RULING_AMOUNT', '裁决金额须大于0且不超过分包价')
  const existing = qSettlement.get(task.id)
  if (existing) {
    if (existing.status === 'done') throw conflict('ALREADY_SETTLED', '该任务已结算')
    throw conflict('SETTLING', '该任务结算处理中')
  }
  const worker = getWorker(task.worker_id)
  const settlementId = createSettlementRecord(task, company, worker, ruledGross, disputeNo)
  const s = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(settlementId)
  const result = await processSettlement(s)
  if (!result.ok) {
    throw new ApiError(502, 'SETTLE_PENDING', '银行分账通道异常，裁决结算已受理，系统将自动重试完成')
  }
  return result.data
}

function getWorker(workerId) {
  return db.prepare(`
    SELECT u.id, u.name, p.subject_type FROM users u JOIN worker_profiles p ON p.user_id = u.id
    WHERE u.id = ?
  `).get(workerId)
}

/** 阶段1：算税定格 + 落预结算单据（幂等屏障，重试不重算） */
function createSettlementRecord(task, company, worker, gross, disputeNo) {
  const period = currentPeriod()
  // 部分结算：企业按比例承担承揽价，平台毛利同比例缩减
  const ratio = gross / task.sub_price
  const margin = Math.round((task.price - task.sub_price) * ratio)
  let tax = 0, vat = 0, method = 'business_income'
  let incomeType = 'business', consecutiveMonths = null
  if (worker.subject_type === 'person') {
    const r = taxEngine.calcWithholding(worker.id, gross, period)
    tax = r.tax
    vat = r.vat
    method = 'cumulative'
    consecutiveMonths = r.detail.months
    // 所得项目分类：命中连续性劳务类目白名单 → 连续性劳务报酬；否则其他劳务报酬
    const whitelist = getConfig('continuousLaborCategories')
    incomeType = whitelist.includes(task.category) ? 'labor_continuous' : 'labor_other'
  }
  const net = gross - tax - vat
  const confirmNo = genNo('QR')
  const voucherNo = method === 'cumulative' && tax > 0 ? genNo('TAX') : null
  const ruledGross = disputeNo ? gross : null

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO settlements (task_id, confirm_no, worker_id, company_id, gross, tax, vat, net, margin, method, income_type, consecutive_months, tax_voucher_no, ruled_gross)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.id, confirmNo, worker.id, company.id, gross, tax, vat, net, margin, method, incomeType, consecutiveMonths, voucherNo, ruledGross)
  return lastInsertRowid
}

/**
 * 推进一笔结算单据：补齐未完成的外部腿 → 本地闭环。
 * 可被 accept 主流程与重试 Job 共用，按腿幂等。
 */
export async function processSettlement(s) {
  // 幂等重读：以库内最新单据为准，避免用陈旧快照重复推进腿、覆盖 legs_done；已完成直接返回缓存结果（防并发双推进）
  s = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(s.id)
  if (!s) return { ok: false, error: '结算单不存在' }
  if (s.status === 'done') {
    return {
      ok: true,
      data: {
        confirmNo: s.confirm_no,
        invoice: { no: s.invoice_no, amount: s.gross + s.margin, taxRate: getConfig('outputVatRate') },
        settlement: { workerNet: s.net, tax: s.tax, vat: s.vat, platformFee: s.margin }
      }
    }
  }
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(s.task_id)
  const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(s.company_id)
  const legs = JSON.parse(s.legs_done)
  let invoiceNo = s.invoice_no
  // 企业实际承担额 = 零工计酬 + 平台毛利（正常结算等于承揽价；部分结算按比例）
  const charged = s.gross + s.margin

  const saveLegs = newInvoiceNo => {
    qSaveLegs.run(JSON.stringify(legs), newInvoiceNo ?? null, s.id)
  }

  try {
    if (!legs.includes('net')) {
      await escrow.transfer({
        from: `company:${s.company_id}`, to: `worker:${s.worker_id}`,
        amountCents: s.net, purpose: `分包款结算 ${s.confirm_no}`, idemKey: `${s.confirm_no}:net`
      })
      legs.push('net'); saveLegs()
    }
    if (s.tax + s.vat > 0 && !legs.includes('tax')) {
      await escrow.transfer({
        from: `company:${s.company_id}`, to: 'platform:tax',
        amountCents: s.tax + s.vat, purpose: `代扣税费 ${s.confirm_no}`, idemKey: `${s.confirm_no}:tax`
      })
      legs.push('tax'); saveLegs()
    }
    if (s.margin > 0 && !legs.includes('margin')) {
      await escrow.transfer({
        from: `company:${s.company_id}`, to: 'platform:revenue',
        amountCents: s.margin, purpose: `平台服务费 ${s.confirm_no}`, idemKey: `${s.confirm_no}:margin`
      })
      legs.push('margin'); saveLegs()
    }
    if (!legs.includes('invoice')) {
      const issued = await einvoice.issue({
        title: company.company_name, taxNo: company.license_no,
        amountCents: charged, item: '*现代服务*灵活用工服务费'
      })
      invoiceNo = issued.invoiceNo
      legs.push('invoice'); saveLegs(invoiceNo)
    }

    finalizeSettlement(s, task, company, invoiceNo)

    const outputVatRate = getConfig('outputVatRate')
    return {
      ok: true,
      data: {
        confirmNo: s.confirm_no,
        invoice: { no: invoiceNo, amount: charged, taxRate: outputVatRate },
        settlement: { workerNet: s.net, tax: s.tax, vat: s.vat, platformFee: s.margin }
      }
    }
  } catch (err) {
    const attempts = s.attempts + 1
    const RETRY_CAP = 8  // 与 jobs/settlementRetry.js 的自动重试上限一致
    const failed = attempts >= 3
    qFail.run(attempts, String(err.message).slice(0, 200), failed ? 'failed' : 'pending', s.id)
    // 首次跌入 failed（===3）告警一次；达自动重试上限（===CAP，此后 Job 不再自动重试）再告警一次。
    // 否则 attempts 4→8 的恶化无任何新信号，运营易错过，进而结算永远 done 不了、连带争议永久卡 ruled。
    if (failed && (attempts === 3 || attempts === RETRY_CAP)) {
      const capReached = attempts >= RETRY_CAP
      risk.raiseAlert('高', '结算异常',
        `任务#${s.task_id}（确认单 ${s.confirm_no}）分账重试 ${attempts} 次仍失败：${err.message}。${capReached ? '已达自动重试上限，停止自动重试，请财务核查银行通道后手工重推（该任务资金仍冻结中）。' : '请财务人工核查银行通道后手工重推。'}`, 'company', s.company_id)
      const financeAdmins = db.prepare(`
        SELECT u.id FROM users u JOIN admin_roles r ON r.id = u.admin_role_id
        WHERE u.role = 'admin' AND u.status = 'active' AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%flow:read%')
      `).all()
      notifyMany(financeAdmins.map(a => a.id), 'risk', '结算分账多次失败',
        `任务#${s.task_id} 确认单 ${s.confirm_no} 银行分账重试失败${capReached ? '已达自动重试上限，请立即人工重推' : '，请人工处理'}。`)
    }
    return { ok: false, error: err.message }
  }
}

/** 本地闭环（单事务）：账务划转 + 税务记录 + 发票落库 + 任务/单据完结 */
function finalizeSettlement(s, task, company, invoiceNo) {
  const outputVatRate = getConfig('outputVatRate')
  const period = s.created_at.slice(0, 7)
  const charged = s.gross + s.margin
  const refund = task.price - charged
  let finalized = false
  db.transaction(() => {
    // 幂等护栏：并发双 finalize（手工重推与重试 Job 撞同一单）时，已 done 直接跳过，
    // 杜绝重复划账（worker 二次入账/平台二次收税费）与把已完成单状态打回 pending/failed。
    if (db.prepare(`SELECT status FROM settlements WHERE id = ?`).get(s.id).status === 'done') return
    // 部分结算（争议裁决）：未结算部分先解冻退回企业可用余额
    if (refund > 0) {
      accounts.unfreeze('company', s.company_id, refund, task.id, `争议裁决部分结算，剩余解冻退回：${task.title}`)
    }
    accounts.settleOut('company', s.company_id, charged, task.id, `验收结算：${task.title}`)
    accounts.credit('worker', s.worker_id, s.net, 'settle_in', task.id, `分包款入账：${task.title}`)
    if (s.tax + s.vat > 0) accounts.credit('platform_tax', 0, s.tax + s.vat, 'tax_in', task.id, `代扣个税/代办增值税：${task.title}`)
    if (s.margin > 0) accounts.credit('platform_revenue', 0, s.margin, 'revenue_in', task.id, `平台服务费：${task.title}`)

    db.prepare(`
      INSERT INTO tax_records (worker_id, task_id, company_id, gross, tax, vat, net, method, income_type, consecutive_months, period, tax_voucher_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.worker_id, task.id, s.company_id, s.gross, s.tax, s.vat, s.net, s.method, s.income_type, s.consecutive_months, period, s.tax_voucher_no)

    db.prepare(`
      INSERT INTO invoices (no, company_id, task_id, amount, tax_rate, item, confirm_no)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceNo, s.company_id, task.id, charged, outputVatRate, '*现代服务*灵活用工服务费', s.confirm_no)

    db.prepare(`UPDATE tasks SET status = 'settled', confirm_no = ?, settled_at = datetime('now','localtime') WHERE id = ?`)
      .run(s.confirm_no, task.id)
    db.prepare(`UPDATE settlements SET status = 'done', done_at = datetime('now','localtime') WHERE id = ?`).run(s.id)
    finalized = true
  })()
  // 并发下已被另一路径完成 → 跳过通知与结算后风控，避免重复触达/重复预警/重复阈值锁
  if (!finalized) return

  const workerName = db.prepare(`SELECT name FROM users WHERE id = ?`).get(s.worker_id).name
  notifyWithSms(s.worker_id, 'settle', '任务已验收结算',
    `「${task.title}」已验收合格，分包款 ¥${(s.net / 100).toFixed(2)} 已结算至您的账户${s.tax + s.vat > 0 ? `（已代扣税费 ¥${((s.tax + s.vat) / 100).toFixed(2)}）` : ''}。`,
    'sms_settled', { taskTitle: task.title, amount: centsToYuan(s.net) })

  risk.postSettlementChecks({
    workerId: s.worker_id,
    workerName,
    companyId: s.company_id,
    companyName: company.company_name,
    period
  })
  risk.amlChecks({ workerId: s.worker_id, workerName, amountCents: s.net, kind: 'settle' })
}

/** 人工重推 failed 结算单（运营端核查银行侧后调用，权限 flow:write + step-up 复验） */
export async function retrySettlement(settlementId) {
  const s = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(settlementId)
  if (!s) throw badRequest('NOT_FOUND', '结算单不存在')
  if (s.status === 'done') throw conflict('ALREADY_SETTLED', '该结算单已完成')
  db.prepare(`UPDATE settlements SET status = 'pending', attempts = 0, last_error = NULL WHERE id = ?`).run(s.id)
  const fresh = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(s.id)
  return processSettlement(fresh)
}
