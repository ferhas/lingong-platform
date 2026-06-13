// 结算重试：推进停留在 pending 的结算单据（外部通道恢复后自动补齐分账/开票）。
// 全局结算应急开关开启时跳过本轮。
import db from '../db.js'
import { processSettlement } from '../services/settlement.js'
import { getConfig } from '../services/configStore.js'

export async function runSettlementRetry() {
  if (getConfig('settlementPaused')) return { paused: 1 }
  const pending = db.prepare(`SELECT * FROM settlements WHERE status = 'pending' AND attempts < 3 ORDER BY id`).all()
  let done = 0, failed = 0
  for (const s of pending) {
    const r = await processSettlement(s)
    if (r.ok) done++
    else failed++
  }
  return { scanned: pending.length, done, failed }
}
