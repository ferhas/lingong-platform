// 数据库备份：VACUUM INTO 生成一致性快照（WAL 模式安全），保留最近 14 份
// 用法：node scripts/backup.mjs    （生产建议配 cron：0 2 * * * node /app/scripts/backup.mjs）
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dbPath = process.env.DB_PATH || fileURLToPath(new URL('../data/gigwork.db', import.meta.url))
const backupDir = process.env.BACKUP_DIR || fileURLToPath(new URL('../backups', import.meta.url))
fs.mkdirSync(backupDir, { recursive: true })

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const target = path.join(backupDir, `gigwork-${stamp}.db`)

const db = new Database(dbPath, { readonly: false })
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
db.close()
console.log(`备份完成：${target}（${(fs.statSync(target).size / 1024).toFixed(0)} KB）`)

// 轮转：仅保留最近 14 份
const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('gigwork-') && f.endsWith('.db')).sort()
for (const old of backups.slice(0, Math.max(0, backups.length - 14))) {
  fs.rmSync(path.join(backupDir, old))
  console.log(`轮转删除：${old}`)
}
