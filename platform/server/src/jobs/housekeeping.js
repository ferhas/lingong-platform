// 数据治理：已读通知清理、审计日志归档、孤儿上传文件清理、明文待核验信息清理、强制登记阈值锁
import fs from 'node:fs'
import db from '../db.js'
import * as storage from '../services/storage.js'
import { getConfig } from '../services/configStore.js'
import { notify } from '../services/notify.js'
import { raiseAlert } from '../services/risk.js'
import { rolling12mStartPeriod } from '../utils/ids.js'

export function runHousekeeping() {
  // 已读通知 > 90 天删除
  const n1 = db.prepare(`
    DELETE FROM notifications WHERE read = 1 AND created_at < datetime('now', 'localtime', '-90 days')
  `).run().changes

  // 审计日志 > 180 天归档
  const n2 = db.transaction(() => {
    const moved = db.prepare(`
      INSERT INTO audit_logs_archive (id, user_id, action, detail, created_at)
      SELECT id, user_id, action, detail, created_at FROM audit_logs
      WHERE created_at < datetime('now', 'localtime', '-180 days')
    `).run().changes
    db.prepare(`DELETE FROM audit_logs WHERE created_at < datetime('now', 'localtime', '-180 days')`).run()
    return moved
  })()

  // 孤儿上传（>7天未关联任何任务附件）物理删除
  const orphans = db.prepare(`
    SELECT u.* FROM uploads u
    LEFT JOIN task_attachments a ON a.upload_id = u.id
    WHERE a.id IS NULL AND u.created_at < datetime('now', 'localtime', '-7 days')
  `).all()
  for (const o of orphans) {
    try { fs.rmSync(storage.resolvePath(o.path), { force: true }) } catch {}
    db.prepare(`DELETE FROM uploads WHERE id = ?`).run(o.id)
  }

  // 实名三段式中断遗留的明文待核验信息（含身份证号/银行卡号明文）：>1天未完成核验即抹除（PII 最小留存）
  const piiCleared = db.prepare(`
    UPDATE user_settings SET value = json_remove(value, '$.pendingVerify'), updated_at = datetime('now','localtime')
    WHERE json_extract(value, '$.pendingVerify') IS NOT NULL
      AND updated_at < datetime('now','localtime','-1 day')
  `).run().changes

  // 强制市场主体登记：自然人滚动12个月累计收入达阈值 → 锁定接单（reason=threshold，完成个体户登记后可自助解锁）
  // 配置 forceRegisterRolling12m 单位为元，tax_records.gross 为分，比较前换算。
  const thresholdCents = Number(getConfig('forceRegisterRolling12m')) * 100
  // 与 risk.js#postSettlementChecks 共用同一滚动12月窗口口径（日历月），消除"365天 vs 日历月"漂移
  const sincePeriod = rolling12mStartPeriod()
  const overThreshold = db.prepare(`
    SELECT p.user_id, COALESCE(SUM(r.gross), 0) AS gross FROM worker_profiles p
    JOIN tax_records r ON r.worker_id = p.user_id AND r.period >= ?
    WHERE p.subject_type = 'person' AND p.locked = 0
    GROUP BY p.user_id HAVING gross >= ?
  `).all(sincePeriod, thresholdCents)
  for (const w of overThreshold) {
    db.prepare(`UPDATE worker_profiles SET locked = 1, lock_reason = 'threshold' WHERE user_id = ?`).run(w.user_id)
    notify(w.user_id, 'guide', '接单已达强制登记阈值',
      '您近12个月在本平台累计收入已达强制市场主体登记阈值，自然人接单已暂时锁定。完成个体工商户登记（我的-个体户登记）后即可自动恢复接单。')
    raiseAlert('中', '强制登记阈值',
      `零工#${w.user_id} 近12个月累计收入达强制市场主体登记阈值，已锁定自然人接单并引导其登记个体户`, 'worker', w.user_id)
  }

  return {
    notificationsDeleted: n1, auditArchived: n2, orphansDeleted: orphans.length,
    pendingVerifyCleared: piiCleared, forceRegisterLocked: overThreshold.length
  }
}
