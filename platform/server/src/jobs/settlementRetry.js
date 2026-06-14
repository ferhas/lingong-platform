// 结算重试：推进停留在 pending 的结算单据（外部通道恢复后自动补齐分账/开票）。
// 全局结算应急开关开启时跳过本轮。
import db from '../db.js'
import { processSettlement } from '../services/settlement.js'
import { getConfig } from '../services/configStore.js'

export async function runSettlementRetry() {
  if (getConfig('settlementPaused')) return { paused: 1 }
  // 有界自动恢复：除 pending 外，一并重推已转 failed 的单（外部通道长时间中断时 3 次内会被标 failed），
  // 直到 attempts 达上限(8)才彻底交人工，避免"failed 后资金永久卡在 company.frozen 无人自动捡"。
  const pending = db.prepare(`SELECT * FROM settlements WHERE status IN ('pending','failed') AND attempts < 8 ORDER BY id`).all()
  let done = 0, failed = 0
  for (const s of pending) {
    const r = await processSettlement(s)
    if (r.ok) done++
    else failed++
  }
  return { scanned: pending.length, done, failed }
}
