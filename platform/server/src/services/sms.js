// 短信验证码服务：发送频控（同号同场景60s/次、单号10条/天）+ 错误计数（5次错废码）
import crypto from 'node:crypto'
import db from '../db.js'
import { badRequest } from '../utils/errors.js'
import { sms } from '../integrations/index.js'
import { sendTemplateSms } from './notify.js'

export const SMS_SCENES = ['register', 'login', 'withdraw', 'bindcard', 'changepw']

const CODE_TTL_MINUTES = 5
const RESEND_SECONDS = 60
const DAILY_MAX = 10

const qGet = db.prepare(`SELECT * FROM sms_codes WHERE phone = ? AND scene = ?`)
const qUpsert = db.prepare(`
  INSERT INTO sms_codes (phone, scene, code, expires_at, attempts, sent_count, last_sent_at)
  VALUES (?, ?, ?, ?, 0, ?, datetime('now','localtime'))
  ON CONFLICT(phone, scene) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at,
    attempts = 0, sent_count = excluded.sent_count, last_sent_at = excluded.last_sent_at
`)
const qDelete = db.prepare(`DELETE FROM sms_codes WHERE phone = ? AND scene = ?`)

export async function requestCode(phone, scene) {
  if (!SMS_SCENES.includes(scene)) throw badRequest('BAD_SCENE', '不支持的验证码场景')
  if (!/^1\d{10}$/.test(phone)) throw badRequest('BAD_PHONE', '手机号格式不正确')

  const existing = qGet.get(phone, scene)
  if (existing) {
    const sinceLast = (Date.now() - new Date(existing.last_sent_at).getTime()) / 1000
    if (sinceLast < RESEND_SECONDS) {
      throw badRequest('SMS_TOO_FREQUENT', `发送过于频繁，请 ${Math.ceil(RESEND_SECONDS - sinceLast)} 秒后重试`)
    }
  }
  const todaySent = db.prepare(`
    SELECT COALESCE(SUM(sent_count),0) AS n FROM sms_codes WHERE phone = ? AND date(last_sent_at) = date('now','localtime')
  `).get(phone).n
  if (todaySent >= DAILY_MAX) throw badRequest('SMS_DAILY_LIMIT', '今日验证码发送次数已达上限')

  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0')
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60000).toISOString()
  qUpsert.run(phone, scene, code, expiresAt, (existing?.sent_count ?? 0) + 1)
  await sendTemplateSms(phone, 'sms_verify_code', { code, minutes: CODE_TTL_MINUTES }, null)
  // 开发/测试环境回显验证码便于联调；生产仅经短信下发
  return process.env.NODE_ENV === 'production' ? { sent: true } : { sent: true, devCode: code }
}

export function verifyCode(phone, scene, code) {
  const row = qGet.get(phone, scene)
  if (!row) throw badRequest('SMS_CODE_INVALID', '请先获取验证码')
  if (new Date(row.expires_at) < new Date()) {
    qDelete.run(phone, scene)
    throw badRequest('SMS_CODE_EXPIRED', '验证码已过期，请重新获取')
  }
  if (row.attempts >= 5) {
    qDelete.run(phone, scene)
    throw badRequest('SMS_CODE_INVALID', '验证码错误次数过多，请重新获取')
  }
  if (row.code !== String(code)) {
    db.prepare(`UPDATE sms_codes SET attempts = attempts + 1 WHERE phone = ? AND scene = ?`).run(phone, scene)
    throw badRequest('SMS_CODE_WRONG', '验证码不正确')
  }
  qDelete.run(phone, scene)
  return true
}

export { sms as smsAdapter }
