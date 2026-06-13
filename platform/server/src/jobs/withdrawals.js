// 提现处理：申请单 → 存管行出金（凭绑卡协议号）→ 到账划扣 / 失败解冻退回。
// 终态收尾统一走 escrowEvents.handleWithdrawalResult（与银行异步回调共用，幂等）。
// 全局提现应急开关开启时跳过本轮。
import db from '../db.js'
import { escrow } from '../integrations/index.js'
import { handleWithdrawalResult } from '../services/escrowEvents.js'
import { getConfig } from '../services/configStore.js'

export async function runWithdrawals() {
  if (getConfig('withdrawalPaused')) return { paused: 1 }
  const applied = db.prepare(`SELECT * FROM withdrawals WHERE status = 'applied' ORDER BY id`).all()
  let done = 0, failed = 0
  for (const w of applied) {
    db.prepare(`UPDATE withdrawals SET status = 'processing' WHERE id = ?`).run(w.id)
    try {
      const member = w.member_no
        ? db.prepare(`SELECT * FROM escrow_members WHERE member_no = ?`).get(w.member_no)
        : null
      const txn = await escrow.transfer({
        from: `worker:${w.worker_id}`,
        // 生产：出金目标为绑卡协议号（不传卡号明文）；兼容旧单：掩码卡号仅作摘要
        to: member?.bind_card_token ? `card:${member.bind_card_token}` : `bank:${w.bank_card}`,
        amountCents: w.amount, purpose: `零工提现 WD${w.id}`, idemKey: `withdrawal:${w.id}`
      })
      handleWithdrawalResult({ withdrawalId: w.id, success: true, escrowTxnNo: txn.txnNo })
      done++
    } catch (err) {
      handleWithdrawalResult({ withdrawalId: w.id, success: false, failReason: err.message })
      failed++
    }
  }
  return { scanned: applied.length, done, failed }
}
