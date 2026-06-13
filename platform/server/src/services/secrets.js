// 敏感凭据加密存储：AES-256-GCM 信封加密 + HMAC-SHA256 查重索引。
// 身份证号仅在投保/涉税报送等法定场景解密，解密行为必须写审计日志（由调用方负责）。
// 密钥来源：SECRETS_KEY 环境变量（生产必须独立配置，建议托管 KMS）；开发态从 JWT_SECRET 派生。
import crypto from 'node:crypto'
import config from '../config.js'
import db from '../db.js'
import { logAction } from './audit.js'

const keyMaterial = process.env.SECRETS_KEY || `${config.jwtSecret}:secrets-dev`
const encKey = crypto.createHash('sha256').update(keyMaterial + ':enc').digest()
const hmacKey = crypto.createHash('sha256').update(keyMaterial + ':hmac').digest()

export function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

export function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function hmacIndex(plain) {
  return crypto.createHmac('sha256', hmacKey).update(String(plain)).digest('hex')
}

/** 实名通过后存储身份证号密文（重复身份证号注册由 HMAC 唯一索引拦截） */
export function storeIdCard(userId, idCard) {
  db.prepare(`
    INSERT INTO worker_secrets (user_id, id_card_cipher, id_card_hmac) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET id_card_cipher = excluded.id_card_cipher, id_card_hmac = excluded.id_card_hmac
  `).run(userId, encrypt(idCard), hmacIndex(idCard))
}

export function idCardExists(idCard, exceptUserId = null) {
  const row = db.prepare(`SELECT user_id FROM worker_secrets WHERE id_card_hmac = ?`).get(hmacIndex(idCard))
  return !!row && row.user_id !== exceptUserId
}

/** 法定场景解密（投保/涉税报送），强制审计 */
export function readIdCard(userId, operatorId, purpose) {
  const row = db.prepare(`SELECT id_card_cipher FROM worker_secrets WHERE user_id = ?`).get(userId)
  if (!row) return null
  logAction(operatorId, 'pii_decrypt', `worker#${userId} purpose=${purpose}`)
  return decrypt(row.id_card_cipher)
}
