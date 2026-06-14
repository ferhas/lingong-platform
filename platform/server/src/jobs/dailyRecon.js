// T+1 按日对账：银行存管回执 vs 平台对外资金动作，逐日比对并留痕，差异自动预警。
// v5：总额轧差升级为逐笔核销 —— 金额多重集合相消后的剩余项落 recon_diffs 明细
//（bank_only=银行有平台无，疑似掉单需补落；platform_only=平台有银行无，指令未达需重推），
// 财务在运营端"对账差异工作台"逐笔处置，3 个工作日内平账。
import db from '../db.js'
import { raiseAlert } from '../services/risk.js'

export function runDailyRecon(day) {
  if (!day) {
    const d = new Date(Date.now() - 86400000)
    day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const bankTxns = db.prepare(`
    SELECT txn_no, amount, purpose FROM escrow_txns WHERE date(created_at) = ?
  `).all(day)
  const platformFlows = db.prepare(`
    SELECT f.id, f.amount, f.remark, f.type, f.ref_id FROM fund_flows f
    WHERE f.type IN ('recharge','settle_out','withdraw') AND date(f.created_at) = ?
  `).all(day)

  const bank = { n: bankTxns.length, total: bankTxns.reduce((s, t) => s + t.amount, 0) }
  const platform = { n: platformFlows.length, total: platformFlows.reduce((s, f) => s + f.amount, 0) }
  const diff = bank.total - platform.total
  const status = diff === 0 ? 'balanced' : 'mismatch'

  db.prepare(`
    INSERT INTO reconciliation_daily (day, bank_total, bank_txns, platform_total, platform_flows, diff, status, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(day) DO UPDATE SET bank_total=excluded.bank_total, bank_txns=excluded.bank_txns,
      platform_total=excluded.platform_total, platform_flows=excluded.platform_flows,
      diff=excluded.diff, status=excluded.status, checked_at=excluded.checked_at
  `).run(day, bank.total, bank.n, platform.total, platform.n, diff, status)

  let diffItems = 0
  if (status === 'mismatch') {
    // 逐笔核销：按金额多重集合相消，剩余项即差异明细（同日重跑先清除未处置项防重复）
    db.prepare(`DELETE FROM recon_diffs WHERE day = ? AND status = 'open'`).run(day)
    // 结算腿粒度对齐：银行侧每笔结算产生 net/tax/margin 三条 escrow_txns，而平台侧仅 1 条 settle_out(=charged)。
    // 逐笔核销前把 settle_out 拆成与银行腿同口径的三条（实发/税费/服务费），避免不平日把正常结算误判为多条幻影差异。
    const platformItems = []
    for (const f of platformFlows) {
      if (f.type === 'settle_out' && f.ref_id) {
        const s = db.prepare(`SELECT net, tax, vat, margin FROM settlements WHERE task_id = ?`).get(f.ref_id)
        if (s) {
          if (s.net > 0) platformItems.push({ id: f.id, amount: s.net, remark: `${f.remark}·实发` })
          if (s.tax + s.vat > 0) platformItems.push({ id: f.id, amount: s.tax + s.vat, remark: `${f.remark}·税费` })
          if (s.margin > 0) platformItems.push({ id: f.id, amount: s.margin, remark: `${f.remark}·服务费` })
          continue
        }
      }
      platformItems.push({ id: f.id, amount: f.amount, remark: f.remark })
    }
    const platformPool = new Map() // amount → item 列表
    for (const f of platformItems) {
      if (!platformPool.has(f.amount)) platformPool.set(f.amount, [])
      platformPool.get(f.amount).push(f)
    }
    const insertDiff = db.prepare(`
      INSERT INTO recon_diffs (day, side, ref_no, amount, detail) VALUES (?, ?, ?, ?, ?)
    `)
    for (const t of bankTxns) {
      const pool = platformPool.get(t.amount)
      if (pool && pool.length) {
        pool.pop() // 金额可相消，视为匹配
      } else {
        insertDiff.run(day, 'bank_only', t.txn_no, t.amount, t.purpose)
        diffItems++
      }
    }
    for (const pool of platformPool.values()) {
      for (const f of pool) {
        insertDiff.run(day, 'platform_only', `FLOW-${f.id}`, f.amount, f.remark)
        diffItems++
      }
    }
    raiseAlert('高', '对账差异',
      `${day} 日终对账不平：银行侧 ¥${(bank.total / 100).toFixed(2)}（${bank.n}笔） vs 平台侧 ¥${(platform.total / 100).toFixed(2)}（${platform.n}笔），差异 ¥${(diff / 100).toFixed(2)}，已生成 ${diffItems} 条逐笔差异，请财务在对账差异工作台处置（3个工作日内平账）。`)
  }
  return { day, diff, status, diffItems }
}
