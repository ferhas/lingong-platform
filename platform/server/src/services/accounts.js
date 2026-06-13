import db from '../db.js'
import { badRequest } from '../utils/errors.js'

const qGet = db.prepare(`SELECT * FROM accounts WHERE owner_type = ? AND owner_id = ?`)
const qCreate = db.prepare(`INSERT INTO accounts (owner_type, owner_id) VALUES (?, ?)`)
const qUpdate = db.prepare(`UPDATE accounts SET balance = ?, frozen = ? WHERE id = ?`)
const qFlow = db.prepare(`
  INSERT INTO fund_flows (account_id, type, amount, balance_after, ref_type, ref_id, remark)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

export function ensureAccount(ownerType, ownerId) {
  let acc = qGet.get(ownerType, ownerId)
  if (!acc) {
    qCreate.run(ownerType, ownerId)
    acc = qGet.get(ownerType, ownerId)
  }
  return acc
}

export function getAccount(ownerType, ownerId) {
  return ensureAccount(ownerType, ownerId)
}

function apply(acc, { balanceDelta = 0, frozenDelta = 0, type, amount, refType = null, refId = null, remark = '' }) {
  const balance = acc.balance + balanceDelta
  const frozen = acc.frozen + frozenDelta
  if (balance < 0) throw badRequest('INSUFFICIENT_BALANCE', '账户余额不足')
  if (frozen < 0) throw badRequest('FROZEN_UNDERFLOW', '冻结金额异常')
  if (balance - frozen < 0) throw badRequest('INSUFFICIENT_AVAILABLE', '可用余额不足')
  qUpdate.run(balance, frozen, acc.id)
  qFlow.run(acc.id, type, amount, balance, refType, refId, remark)
  return { ...acc, balance, frozen }
}

export function recharge(ownerType, ownerId, cents, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { balanceDelta: cents, type: 'recharge', amount: cents, remark })
}

export function freeze(ownerType, ownerId, cents, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { frozenDelta: cents, type: 'freeze', amount: cents, refType: 'task', refId, remark })
}

export function unfreeze(ownerType, ownerId, cents, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { frozenDelta: -cents, type: 'unfreeze', amount: cents, refType: 'task', refId, remark })
}

/** 结算划扣：解冻并扣款 */
export function settleOut(ownerType, ownerId, cents, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { balanceDelta: -cents, frozenDelta: -cents, type: 'settle_out', amount: cents, refType: 'task', refId, remark })
}

export function credit(ownerType, ownerId, cents, type, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { balanceDelta: cents, type, amount: cents, refType: 'task', refId, remark })
}

export function withdraw(ownerType, ownerId, cents, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { balanceDelta: -cents, type: 'withdraw', amount: cents, remark })
}

/** 提现冻结金额的最终划扣（解冻+出账，对账归类为 withdraw） */
export function withdrawFrozen(ownerType, ownerId, cents, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { balanceDelta: -cents, frozenDelta: -cents, type: 'withdraw', amount: cents, refType: 'withdrawal', refId, remark })
}

/** 通用冻结/解冻（带自定义 refType） */
export function freezeRef(ownerType, ownerId, cents, refType, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { frozenDelta: cents, type: 'freeze', amount: cents, refType, refId, remark })
}

export function unfreezeRef(ownerType, ownerId, cents, refType, refId, remark) {
  const acc = ensureAccount(ownerType, ownerId)
  return apply(acc, { frozenDelta: -cents, type: 'unfreeze', amount: cents, refType, refId, remark })
}

export function listFlows(accountId, page = 1, pageSize = 20) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM fund_flows WHERE account_id = ?`).get(accountId).n
  const list = db.prepare(`SELECT * FROM fund_flows WHERE account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(accountId, pageSize, (page - 1) * pageSize)
  return { list, total }
}
