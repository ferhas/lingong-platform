// 文件存储适配层：本地磁盘实现；生产可替换为 OSS/S3（保持 save/resolvePath 签名不变）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import config from '../config.js'

const uploadDir = config.uploadDir
fs.mkdirSync(uploadDir, { recursive: true })

export function save(buffer, originalName) {
  const id = crypto.randomUUID()
  const ext = path.extname(originalName).slice(0, 10)
  const filename = id + ext
  const filePath = path.join(uploadDir, filename)
  fs.writeFileSync(filePath, buffer)
  return {
    id,
    storedPath: filename,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  }
}

export function resolvePath(storedPath) {
  const full = path.join(uploadDir, path.basename(storedPath))
  if (!full.startsWith(uploadDir)) throw new Error('非法路径')
  return full
}
