// 存管银行异步事件处理器：入金确认 / 提现终态。
// 同时被 webhook 回调与（开发态）模拟支付端点调用，全部幂等。
import db from '../db.js'
import * as accounts from './accounts.js'
import { notifyCompany, notifyWithSms } from './notify.js'
import { raiseAlert } from './risk.js'
import { centsToYuan } from '../utils/money.js'

/**
 * 入金确认（银行回调驱动入账：本地余额是银行子账户的镜像）。
 * 幂等：充值单已 paid 直接返回。
 */
export function handleRechargePaid({ orderNo, escrowTxnNo, amount }) {
  const order = db.prepare(`SELECT * FROM recharge_orders WHERE no = ?`).get(orderNo)
  if (!order) throw new Error(`充值单不存在：${orderNo}`)
  if (order.status === 'paid') return { ok: true, duplicated: true }
  if (order.status === 'expired') throw new Error(`充值单已过期：${orderNo}`)
  if (amount != null && Number(amount) !== order.amount) {
    raiseAlert('高', '充值金额不符',
      `充值单 ${orderNo} 申报金额 ¥${centsToYuan(order.amount)} 与银行入金 ¥${centsToYuan(Number(amount))} 不一致，已挂起，请财务人工核实`, 'company', order.company_id)
    throw new Error(`入金金额与充值单不符：${orderNo}`)
  }
  db.transaction(() => {
    db.prepare(`UPDATE recharge_orders SET status = 'paid', escrow_txn_no = ?, paid_at = datetime('now','localtime') WHERE id = ?`)
      .run(escrowTxnNo ?? null, order.id)
    // 银行侧入金流水落库（对账数据源；webhook 携带的银行流水号优先）
    db.prepare(`INSERT OR IGNORE INTO escrow_txns (txn_no, from_acct, to_acct, amount, purpose, idem_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(escrowTxnNo || `BK-${orderNo}`, `bank:company:${order.company_id}`, `escrow:company:${order.company_id}`,
        order.amount, `企业存管户充值 ${orderNo}`, `recharge:${orderNo}`)
    accounts.recharge('company', order.company_id, order.amount, `存管户充值到账（充值单 ${orderNo}）`)
  })()
  notifyCompany(order.company_id, 'recharge', '充值已到账',
    `充值单 ${orderNo} 入金 ¥${centsToYuan(order.amount)} 已确认到账，可用余额已更新。`)
  return { ok: true, amount: order.amount }
}

/**
 * 提现终态（成功划扣 / 失败解冻退回）。
 * 幂等：单据非 processing 状态直接返回。
 */
export function handleWithdrawalResult({ withdrawalId, success, escrowTxnNo, failReason }) {
  const w = db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(withdrawalId)
  if (!w) throw new Error(`提现单不存在：${withdrawalId}`)
  if (w.status !== 'processing' && w.status !== 'applied') return { ok: true, duplicated: true, status: w.status }

  if (success) {
    db.transaction(() => {
      accounts.withdrawFrozen('worker', w.worker_id, w.amount, w.id, `提现到账：${w.bank_card}`)
      db.prepare(`UPDATE withdrawals SET status = 'done', escrow_txn_no = ?, done_at = datetime('now','localtime') WHERE id = ?`)
        .run(escrowTxnNo ?? w.escrow_txn_no, w.id)
    })()
    notifyWithSms(w.worker_id, 'settle', '提现已到账',
      `提现 ¥${centsToYuan(w.amount)} 已转入 ${w.bank_card}。`,
      'sms_withdraw_done', { amount: centsToYuan(w.amount), cardTail: String(w.bank_card).slice(-4) })
  } else {
    db.transaction(() => {
      accounts.unfreezeRef('worker', w.worker_id, w.amount, 'withdrawal', w.id, '提现失败解冻退回')
      db.prepare(`UPDATE withdrawals SET status = 'failed', fail_reason = ?, done_at = datetime('now','localtime') WHERE id = ?`)
        .run(String(failReason || '银行通道异常').slice(0, 200), w.id)
    })()
    notifyWithSms(w.worker_id, 'risk', '提现失败',
      `提现 ¥${centsToYuan(w.amount)} 因银行通道异常失败，金额已退回余额，请稍后重试。`,
      'sms_withdraw_failed', { amount: centsToYuan(w.amount) })
    raiseAlert('中', '提现异常', `提现单 WD${w.id}（零工#${w.worker_id}，¥${centsToYuan(w.amount)}）出金失败：${failReason}`, 'worker', w.worker_id)
  }
  return { ok: true, status: success ? 'done' : 'failed' }
}
