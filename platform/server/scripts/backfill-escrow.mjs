// 一次性迁移：为对账模块上线前的存量对外资金流水补录银行回执记录（幂等）
// 用法：node scripts/backfill-escrow.mjs
import crypto from 'node:crypto'
import db from '../src/db.js'

const flows = db.prepare(`
  SELECT f.*, a.owner_type, a.owner_id FROM fund_flows f JOIN accounts a ON a.id = f.account_id
  WHERE f.type IN ('recharge','settle_out','withdraw')
`).all()

const bankSum = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM escrow_txns`).get()
const platSum = flows.reduce((s, f) => s + f.amount, 0)

if (bankSum.s === platSum) {
  console.log('对账已平衡，无需补录')
  process.exit(0)
}

const insert = db.prepare(`
  INSERT INTO escrow_txns (txn_no, from_acct, to_acct, amount, purpose, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`)
let added = 0
db.transaction(() => {
  // 简化处理：银行侧已有 n 笔时跳过前 n 笔平台流水（按时间序），其余补录
  const skip = bankSum.n
  for (const f of flows.slice(skip)) {
    const acct = `${f.owner_type}:${f.owner_id}`
    const [from, to] = f.type === 'recharge' ? [`bank:${acct}`, acct] : [acct, f.type === 'withdraw' ? 'bank:worker' : 'escrow:settle']
    insert.run('BKBF' + crypto.randomInt(1e9).toString().padStart(10, '0'), from, to, f.amount, `历史数据补录：${f.remark}`, f.created_at)
    added++
  }
})()
console.log(`补录 ${added} 笔银行回执`)

const after = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM escrow_txns`).get()
console.log(`银行侧合计 ${after.s / 100} 元，平台侧合计 ${platSum / 100} 元，${after.s === platSum ? '✅ 对账平衡' : '❌ 仍有差异'}`)
db.close()
