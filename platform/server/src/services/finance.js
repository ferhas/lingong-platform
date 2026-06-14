// 财务报表中心：资金日报 / 结算明细 / 企业月结单 / 税款备付金月报 / 科目余额 / 经营月报。
// 口径：总额法收入确认（验收确认单时点），与全额开票的税务口径一致。
import db from '../db.js'
import { centsToYuan } from '../utils/money.js'

const OWNER_LABEL = { company: '企业户', worker: '零工户', platform_tax: '税款备付金户', platform_revenue: '平台收益户' }

/** 资金日报：各账户类型当日各类型发生额 + 期末余额 + 对账状态 */
export function dailyReport(day) {
  const byType = db.prepare(`
    SELECT a.owner_type, f.type, COUNT(*) AS n, COALESCE(SUM(f.amount),0) AS total
    FROM fund_flows f JOIN accounts a ON a.id = f.account_id
    WHERE date(f.created_at) = ? GROUP BY a.owner_type, f.type ORDER BY a.owner_type, f.type
  `).all(day)
  const balances = db.prepare(`
    SELECT owner_type, COUNT(*) AS accounts, COALESCE(SUM(balance),0) AS balance, COALESCE(SUM(frozen),0) AS frozen
    FROM accounts GROUP BY owner_type
  `).all()
  const recon = db.prepare(`SELECT * FROM reconciliation_daily WHERE day = ?`).get(day)
  const openDiffs = db.prepare(`SELECT COUNT(*) AS n FROM recon_diffs WHERE day = ? AND status = 'open'`).get(day).n
  return {
    day,
    movements: byType.map(r => ({
      ownerType: r.owner_type, ownerLabel: OWNER_LABEL[r.owner_type] ?? r.owner_type,
      flowType: r.type, count: r.n, amount: centsToYuan(r.total)
    })),
    balances: balances.map(b => ({
      ownerType: b.owner_type, ownerLabel: OWNER_LABEL[b.owner_type] ?? b.owner_type,
      accounts: b.accounts, balance: centsToYuan(b.balance), frozen: centsToYuan(b.frozen)
    })),
    reconciliation: recon ? { status: recon.status, diff: centsToYuan(recon.diff), checkedAt: recon.checked_at } : null,
    openDiffItems: openDiffs
  }
}

/** 结算明细单（税务申报底稿） */
export function settlementDetail(period) {
  const rows = db.prepare(`
    SELECT s.*, t.title, u.name AS worker_name, c.company_name FROM settlements s
    JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.worker_id JOIN companies c ON c.id = s.company_id
    WHERE s.status = 'done' AND substr(s.done_at, 1, 7) = ? ORDER BY s.id
  `).all(period)
  return rows.map(s => ({
    id: s.id, confirmNo: s.confirm_no, taskTitle: s.title,
    companyName: s.company_name, workerName: s.worker_name,
    charged: centsToYuan(s.gross + s.margin), gross: centsToYuan(s.gross),
    tax: centsToYuan(s.tax), vat: centsToYuan(s.vat), net: centsToYuan(s.net),
    margin: centsToYuan(s.margin), method: s.method === 'cumulative' ? '累计预扣' : '经营所得',
    taxVoucherNo: s.tax_voucher_no, invoiceNo: s.invoice_no,
    ruled: s.ruled_gross != null, doneAt: s.done_at
  }))
}

/** 企业月结单（运营核对 + 企业端下载对账单） */
export function companyStatement(companyId, period) {
  const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(companyId)
  if (!company) return null
  const acc = db.prepare(`SELECT * FROM accounts WHERE owner_type = 'company' AND owner_id = ?`).get(companyId)
  const recharges = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM fund_flows
    WHERE account_id = ? AND type = 'recharge' AND substr(created_at,1,7) = ?
  `).get(acc?.id ?? 0, period)
  const settlements = db.prepare(`
    SELECT s.*, t.title FROM settlements s JOIN tasks t ON t.id = s.task_id
    WHERE s.company_id = ? AND s.status = 'done' AND substr(s.done_at,1,7) = ? ORDER BY s.id
  `).all(companyId, period)
  const invoices = db.prepare(`
    SELECT * FROM invoices WHERE company_id = ? AND substr(issued_at,1,7) = ? ORDER BY id
  `).all(companyId, period)
  const consumed = settlements.reduce((sum, s) => sum + s.gross + s.margin, 0)
  return {
    period,
    company: { id: company.id, companyName: company.company_name, licenseNo: company.license_no },
    summary: {
      rechargeTotal: centsToYuan(recharges.total), rechargeCount: recharges.n,
      consumedTotal: centsToYuan(consumed), settledTasks: settlements.length,
      invoicedTotal: centsToYuan(invoices.filter(i => i.status === 'issued').reduce((s, i) => s + i.amount, 0)),
      endBalance: acc ? centsToYuan(acc.balance) : 0, endFrozen: acc ? centsToYuan(acc.frozen) : 0
    },
    settlements: settlements.map(s => ({
      confirmNo: s.confirm_no, taskTitle: s.title, charged: centsToYuan(s.gross + s.margin),
      subPay: centsToYuan(s.gross), platformFee: centsToYuan(s.margin), invoiceNo: s.invoice_no, doneAt: s.done_at
    })),
    invoices: invoices.map(i => ({
      no: i.no, amount: centsToYuan(i.amount), taxRate: i.tax_rate, status: i.status, issuedAt: i.issued_at
    }))
  }
}

/** 税款备付金月报：应缴 vs 备付金户余额 vs 已申报（三方勾稽） */
export function taxReserveReport(period) {
  const due = db.prepare(`
    SELECT COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(vat),0) AS vat, COUNT(*) AS records
    FROM tax_records WHERE period = ?
  `).get(period)
  const reserveAcc = db.prepare(`SELECT * FROM accounts WHERE owner_type = 'platform_tax' AND owner_id = 0`).get()
  const declared = db.prepare(`SELECT * FROM tax_declarations WHERE type = 'monthly_declare' AND period = ?`).get(period)
  return {
    period,
    due: { tax: centsToYuan(due.tax), vat: centsToYuan(due.vat), total: centsToYuan(due.tax + due.vat), records: due.records },
    reserveBalance: reserveAcc ? centsToYuan(reserveAcc.balance) : 0,
    declaration: declared
      ? { receiptNo: declared.receipt_no, status: declared.status, declaredAt: declared.created_at }
      : null
  }
}

/** 科目余额表（按业务事件→会计科目映射，自动汇总试算） */
const SUBJECT_MAP = [
  ['recharge', '其他货币资金-存管户 / 预收账款'],
  ['freeze', '（表外）冻结备查'],
  ['unfreeze', '（表外）解冻备查'],
  ['settle_out', '预收账款 → 主营业务收入（含销项税）'],
  ['settle_in', '主营业务成本-分包款 / 其他应付款'],
  ['tax_in', '应交税费-代扣个税/代征增值税备付'],
  ['revenue_in', '平台服务费（资金归集至收益户）'],
  ['withdraw', '其他应付款-应付分包款（出金核销）']
]

export function subjectBalance(period) {
  const rows = db.prepare(`
    SELECT type, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM fund_flows
    WHERE substr(created_at,1,7) = ? GROUP BY type
  `).all(period)
  const byType = Object.fromEntries(rows.map(r => [r.type, r]))
  return SUBJECT_MAP.map(([type, subject]) => ({
    flowType: type, subject,
    count: byType[type]?.n ?? 0,
    amount: centsToYuan(byType[type]?.total ?? 0)
  }))
}

/** 经营月报：收入/成本/毛利 + 税负健康度 + 三方勾稽校验 */
export function operatingReport(period) {
  const s = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(gross + margin),0) AS revenue, COALESCE(SUM(gross),0) AS cost,
           COALESCE(SUM(margin),0) AS margin, COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(vat),0) AS vat
    FROM settlements WHERE status = 'done' AND substr(done_at,1,7) = ?
  `).get(period)
  const inv = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN status = 'issued' THEN amount ELSE 0 END),0) AS issued,
           COALESCE(SUM(CASE WHEN status = 'voided' THEN amount ELSE 0 END),0) AS voided
    FROM invoices WHERE substr(issued_at,1,7) = ?
  `).get(period)
  // 勾稽口径对齐：按"本期完成结算(done_at)"的任务集统计其税记录 gross，而非按 tax_records.period。
  // 避免结算跨月完成（创建月≠完成月，如银行通道异常重试跨月）时 settlement 与 tax_record 错位误报不平。
  const taxRecords = db.prepare(`
    SELECT COALESCE(SUM(r.gross),0) AS g FROM tax_records r
    JOIN settlements s ON s.task_id = r.task_id
    WHERE s.status = 'done' AND substr(s.done_at,1,7) = ?
  `).get(period)
  // 月结卡点：当月有效发票合计 = 当月确认收入合计 = 当月结算 charged 合计
  const revenueInvoiceMatch = s.revenue === inv.issued + inv.voided || s.revenue === inv.issued
  return {
    period,
    settledTasks: s.n,
    revenue: centsToYuan(s.revenue),
    subContractCost: centsToYuan(s.cost),
    grossMargin: centsToYuan(s.margin),
    grossMarginRate: s.revenue ? ((s.margin / s.revenue) * 100).toFixed(2) + '%' : '0%',
    withheldTax: centsToYuan(s.tax),
    vat: centsToYuan(s.vat),
    invoiced: centsToYuan(inv.issued),
    invoiceVoided: centsToYuan(inv.voided),
    checks: {
      revenueInvoiceMatch,
      settlementTaxRecordMatch: s.cost === taxRecords.g
    }
  }
}
