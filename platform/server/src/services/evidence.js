import db from '../db.js'
import { sha256 } from '../utils/ids.js'
import { centsToYuan } from '../utils/money.js'
import { verifyChain } from './audit.js'

// 审计动作 → 证据链时间轴的人话标签与所属环节
const ACTION_META = {
  task_publish:        { stage: '派单', label: '企业发布任务并电子签《任务工单》、冻结承揽款' },
  task_dispatch:       { stage: '派单', label: '企业向零工定向派单' },
  task_apply:          { stage: '抢单', label: '零工报名（主动抢单）' },
  task_withdraw_apply: { stage: '抢单', label: '零工取消报名' },
  dispatch_accept:     { stage: '抢单', label: '零工接受派单，电子签《分包工单》并投保' },
  dispatch_reject:     { stage: '抢单', label: '零工拒绝派单' },
  task_hire:           { stage: '抢单', label: '企业录用零工，电子签《分包工单》并投保' },
  task_deliver:        { stage: '单据验收', label: '零工上传交付物' },
  task_reject:         { stage: '单据验收', label: '企业驳回交付物' },
  task_accept:         { stage: '单据验收', label: '企业验收通过，出具《业务交易确认单》并触发存管分账/开票' },
  upload_input_invoice:{ stage: '单据管理', label: '零工（个体户）上传进项发票' },
  review_submit:       { stage: '单据验收', label: '提交互评' },
  dispute_create:      { stage: '单据验收', label: '发起争议' }
}

const CONTRACT_LABEL = {
  master: '总承揽框架合同', frame_sub: '零工框架分包协议',
  work_order: '任务工单', sub_order: '分包工单'
}

function maskIp(ip) {
  if (!ip) return null
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) return `${v4[1]}.${v4[2]}.*.*`
  return ip.length > 6 ? ip.slice(0, 6) + '****' : '****'
}

/**
 * 组装单个工单的完整证据链：操作留痕时间轴（谁/何时/何IP/何设备/何地，带防篡改哈希）
 * + 四流凭证（合同流/业务流/资金流/票据流，带单号与文件 SHA256）+ 完整性结论。
 * @param {number} taskId
 * @param {{full?:boolean}} opts full=运营端看原始 IP/UA；企业端 IP 脱敏
 */
export function buildTaskEvidence(taskId, { full = false } = {}) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
  if (!task) return null

  const company = db.prepare(`SELECT company_name, master_contract_no FROM companies WHERE id = ?`).get(task.company_id)
  const worker = task.worker_id ? db.prepare(`
    SELECT u.name, p.real_name, p.frame_contract_no, p.verified_at
    FROM users u JOIN worker_profiles p ON p.user_id = u.id WHERE u.id = ?
  `).get(task.worker_id) : null

  // —— 操作留痕时间轴（来自审计哈希链，按 taskId 精确归属）——
  const auditRows = db.prepare(`
    SELECT a.*, u.name AS user_name, u.role AS user_role
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE json_extract(a.detail_json, '$.taskId') = ?
    ORDER BY a.id ASC
  `).all(taskId)

  const timeline = auditRows.map(a => {
    const meta = ACTION_META[a.action] || { stage: '其他', label: a.action }
    return {
      id: a.id, at: a.created_at, action: a.action, stage: meta.stage, label: meta.label,
      actor: { userId: a.user_id, name: a.user_name || '系统', role: a.user_role || null },
      ip: full ? a.ip : maskIp(a.ip),
      userAgent: a.user_agent || null,
      geo: a.geo || null,
      hash: a.hash, detail: a.detail
    }
  })

  // —— 合同流（四级合同全链电子签，均带内容哈希 + 电子签ID）——
  const taskContracts = db.prepare(`
    SELECT type, no, content_hash, esign_id, signed_at FROM contracts WHERE task_id = ? ORDER BY id
  `).all(taskId)
  const contract = []
  if (company?.master_contract_no) {
    const m = db.prepare(`SELECT no, content_hash, esign_id, signed_at FROM contracts WHERE type='master' AND company_id = ? ORDER BY id LIMIT 1`).get(task.company_id)
    contract.push({ type: 'master', label: CONTRACT_LABEL.master, no: company.master_contract_no, contentHash: m?.content_hash || null, esignId: m?.esign_id || null, signedAt: m?.signed_at || null })
  }
  if (worker?.frame_contract_no) {
    const f = db.prepare(`SELECT no, content_hash, esign_id, signed_at FROM contracts WHERE type='frame_sub' AND no = ? LIMIT 1`).get(worker.frame_contract_no)
    contract.push({ type: 'frame_sub', label: CONTRACT_LABEL.frame_sub, no: worker.frame_contract_no, contentHash: f?.content_hash || null, esignId: f?.esign_id || null, signedAt: f?.signed_at || null })
  }
  for (const ct of taskContracts) {
    contract.push({ type: ct.type, label: CONTRACT_LABEL[ct.type] || ct.type, no: ct.no, contentHash: ct.content_hash, esignId: ct.esign_id, signedAt: ct.signed_at })
  }

  // —— 业务流（报名/派单 + 交付物快照 + 附件 SHA256 + 验收确认单 + 互评）——
  const applications = db.prepare(`
    SELECT a.source, a.status, a.created_at, COALESCE(p.real_name, u.name) AS name
    FROM applications a JOIN users u ON u.id = a.worker_id LEFT JOIN worker_profiles p ON p.user_id = a.worker_id
    WHERE a.task_id = ? ORDER BY a.id
  `).all(taskId)
  const dispatches = db.prepare(`
    SELECT status, note, reject_reason, created_at, responded_at FROM dispatches WHERE task_id = ? ORDER BY id
  `).all(taskId)
  const attachments = db.prepare(`
    SELECT ta.kind, ta.created_at, u.original_name, u.sha256, u.size, u.mime
    FROM task_attachments ta JOIN uploads u ON u.id = ta.upload_id
    WHERE ta.task_id = ? ORDER BY ta.id
  `).all(taskId).map(a => ({ kind: a.kind, name: a.original_name, sha256: a.sha256, size: a.size, mime: a.mime, at: a.created_at }))
  const reviews = db.prepare(`SELECT reviewer_role, score, created_at FROM reviews WHERE task_id = ? ORDER BY id`).all(taskId)
    .map(r => ({ role: r.reviewer_role, score: r.score, at: r.created_at }))
  let deliverableData = null
  try { deliverableData = task.deliverable_data ? JSON.parse(task.deliverable_data) : null } catch { deliverableData = null }

  const business = {
    applications: applications.map(a => ({ name: a.name, source: a.source, status: a.status, at: a.created_at })),
    dispatches,
    deliverable: task.deliverable || null,
    deliverableData,
    deliveredAt: task.delivered_at || null,
    attachments,
    confirmNo: task.confirm_no || null,
    settledAt: task.settled_at || null,
    reviews
  }

  // —— 资金流（任务相关的本地资金流水）——
  const fund = db.prepare(`
    SELECT id, type, amount, remark, created_at FROM fund_flows WHERE ref_type = 'task' AND ref_id = ? ORDER BY id
  `).all(taskId).map(f => ({ id: f.id, type: f.type, amount: centsToYuan(f.amount), remark: f.remark, at: f.created_at }))

  // —— 票据流（发票 + 完税凭证）——
  const inv = db.prepare(`SELECT no, amount, issued_at, status FROM invoices WHERE task_id = ? ORDER BY id LIMIT 1`).get(taskId)
  const taxRec = db.prepare(`SELECT tax_voucher_no, period FROM tax_records WHERE task_id = ? ORDER BY id LIMIT 1`).get(taskId)
  const settlement = db.prepare(`SELECT confirm_no, gross, tax, vat, net, margin, status, done_at FROM settlements WHERE task_id = ?`).get(taskId)
  const invoice = {
    no: inv?.no || null, amount: inv ? centsToYuan(inv.amount) : null, issuedAt: inv?.issued_at || null,
    status: inv?.status || null, taxVoucher: taxRec?.tax_voucher_no || null, taxPeriod: taxRec?.period || null
  }

  const insurance = db.prepare(`SELECT policy_no, plan, premium, status, created_at FROM insurance_policies WHERE task_id = ? ORDER BY id LIMIT 1`).get(taskId)

  // —— 四流完整性结论 ——
  const completeness = {
    contract: contract.some(c => c.type === 'sub_order'),
    business: !!(task.deliverable || deliverableData) && (task.status === 'settled' ? !!task.confirm_no : true),
    fund: fund.length > 0,
    invoice: !!invoice.no
  }
  completeness.allFour = completeness.contract && completeness.business && completeness.fund && completeness.invoice

  const flows = { contract, business: { deliverable: business.deliverable, confirmNo: business.confirmNo }, fund: fund.map(f => f.id), invoice: { no: invoice.no, taxVoucher: invoice.taxVoucher } }

  return {
    task: {
      id: task.id, title: task.title, category: task.category, trade: task.trade || null,
      city: task.city, status: task.status, price: centsToYuan(task.price), subPrice: centsToYuan(task.sub_price),
      createdAt: task.created_at, workOrderNo: task.task_order_no || null, subOrderNo: task.sub_order_no || null,
      policyNo: task.policy_no || null
    },
    company: company ? { companyName: company.company_name, masterContractNo: company.master_contract_no } : null,
    worker: worker ? { name: worker.real_name || worker.name, frameContractNo: worker.frame_contract_no, verifiedAt: worker.verified_at } : null,
    timeline,
    contract, business, fund, invoice,
    insurance: insurance ? { policyNo: insurance.policy_no, plan: insurance.plan, premium: centsToYuan(insurance.premium), status: insurance.status, at: insurance.created_at } : null,
    settlement: settlement ? {
      confirmNo: settlement.confirm_no, gross: centsToYuan(settlement.gross), tax: centsToYuan(settlement.tax),
      vat: centsToYuan(settlement.vat), net: centsToYuan(settlement.net), margin: centsToYuan(settlement.margin),
      status: settlement.status, doneAt: settlement.done_at
    } : null,
    completeness,
    evidenceHash: sha256(flows),
    chain: verifyChain()
  }
}
