// 数据治理：已读通知清理、审计日志归档、孤儿上传文件清理
import fs from 'node:fs'
import db from '../db.js'
import * as storage from '../services/storage.js'

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

  return { notificationsDeleted: n1, auditArchived: n2, orphansDeleted: orphans.length }
}
