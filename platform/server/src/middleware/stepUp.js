// 敏感操作 step-up 复验：已绑定 2FA 的账号执行高敏操作时须携带 X-TOTP-Code 头。
// 生产可开启 adminStepUpRequired，对未绑定 2FA 的账号直接拒绝敏感操作（强制先绑定，消除保护缺口）。
// 供 admin / adminOps 等多处复用。
import db from '../db.js'
import { forbidden } from '../utils/errors.js'
import { verifyTotp } from '../utils/totp.js'
import { getConfig } from '../services/configStore.js'

export function stepUp(req, _res, next) {
  const u = db.prepare(`SELECT totp_enabled, totp_secret FROM users WHERE id = ?`).get(req.user.id)
  if (!u?.totp_enabled) {
    // 生产开启 adminStepUpRequired 后：未绑定 2FA 的运营账号禁止执行敏感操作（重置密码/角色/资金等），
    // 强制其先在「安全设置」绑定动态码——绑定端点(/2fa/setup、/2fa/enable)不经本中间件，无死锁。
    if (getConfig('adminStepUpRequired')) {
      return next(forbidden('该敏感操作要求已绑定动态码(2FA)：请先在「安全设置」绑定动态码后重试'))
    }
    return next()
  }
  const code = req.headers['x-totp-code']
  if (!code || !verifyTotp(u.totp_secret, String(code))) {
    return next(forbidden('敏感操作须二次验证：请在请求头携带有效的动态码（X-TOTP-Code）'))
  }
  next()
}
