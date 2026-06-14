import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { z } from 'zod'
import db from '../db.js'
import config from '../config.js'
import { signToken, authenticate } from '../middleware/auth.js'
import { getPermissions, getMembership } from '../middleware/rbac.js'
import { unauthorized, conflict, badRequest, locked } from '../utils/errors.js'
import { ensureAccount } from '../services/accounts.js'
import { rateIndustry } from '../services/risk.js'
import { logAction } from '../services/audit.js'
import { code2session } from '../integrations/wechat.js'
import { genTempPassword } from '../utils/ids.js'
import { recordAgreements, getLegalDoc } from '../services/contractText.js'
import { readableText } from '../utils/textQuality.js'
import jwt from 'jsonwebtoken'
import { requestCode, verifyCode, SMS_SCENES } from '../services/sms.js'
import { verifyTotp } from '../utils/totp.js'

const router = Router()

// —— 刷新令牌：随机串只存哈希，默认7天有效（生产可经 REFRESH_TOKEN_DAYS 缩短以降低泄露窗口），可吊销，刷新即轮换 ——
const REFRESH_DAYS = Math.max(1, Number(process.env.REFRESH_TOKEN_DAYS || 7))
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex')

function issueRefreshToken(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString()
  db.prepare(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`)
    .run(userId, hashToken(token), expiresAt)
  return token
}

function issueSession(user) {
  // 企业端成员角色随会话一并下发（登录/2FA/刷新令牌均经此处），
  // 避免静默刷新令牌后前端 user.memberRole 短暂缺失导致角色门禁失准。
  const responseUser = { ...user }
  if (user.role === 'company') {
    responseUser.memberRole = getMembership(user.id)?.member_role ?? null
  }
  return { token: signToken(user), refreshToken: issueRefreshToken(user.id), user: responseUser }
}

const phoneSchema = z.string().regex(/^1\d{10}$/, '手机号格式不正确')
const personNameSchema = readableText('姓名', z.string().min(1).max(30))
const companyNameSchema = readableText('企业名称', z.string().min(4).max(60))
const industrySchema = readableText('所属行业', z.string().min(2).max(30))
// 生产级密码策略：≥10位且同时包含字母与数字
export const passwordSchema = z.string()
  .min(10, '密码至少10位')
  .max(64)
  .regex(/[A-Za-z]/, '密码须包含字母')
  .regex(/\d/, '密码须包含数字')

// 注册必须明示同意《平台服务协议》与《隐私政策》（agree=true），同意版本留痕
const agreeSchema = z.literal(true, { errorMap: () => ({ message: '请先阅读并同意平台服务协议与隐私政策' }) })

// —— 短信验证码下发：注册/登录场景免登录；提现/绑卡/改密场景须登录并使用本人手机号 ——
router.post('/sms-code', async (req, res, next) => {
  try {
    const { phone, scene } = z.object({
      phone: phoneSchema.optional(),
      scene: z.enum(SMS_SCENES)
    }).parse(req.body)
    let targetPhone = phone
    if (!['register', 'login'].includes(scene)) {
      const header = req.headers.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : null
      if (!token) throw unauthorized('该场景须登录后获取验证码')
      const payload = jwt.verify(token, config.jwtSecret)
      const u = db.prepare(`SELECT phone FROM users WHERE id = ?`).get(payload.sub)
      if (!u) throw unauthorized()
      targetPhone = u.phone
    }
    if (!targetPhone) throw badRequest('PHONE_REQUIRED', '请提供手机号')
    res.json(await requestCode(targetPhone, scene))
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') return next(unauthorized())
    next(err)
  }
})

const registerSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('worker'),
    phone: phoneSchema,
    password: passwordSchema,
    name: personNameSchema,
    agree: agreeSchema,
    smsCode: z.string().optional(),
    inviteCode: z.string().max(20).optional()
  }),
  z.object({
    role: z.literal('company'),
    phone: phoneSchema,
    password: passwordSchema,
    name: personNameSchema,
    companyName: companyNameSchema,
    licenseNo: z.string().min(8).max(30),
    industry: industrySchema,
    agree: agreeSchema
  })
])

router.post('/register', (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body)
    const exists = db.prepare(`SELECT id FROM users WHERE phone = ?`).get(body.phone)
    if (exists) throw conflict('PHONE_EXISTS', '该手机号已注册')
    // 提供验证码即校验（前端默认走验证码注册；保留无码兼容供联调）
    if (body.smsCode) verifyCode(body.phone, 'register', body.smsCode)

    // 企业邀请码（冷启动定向邀请）：注册即绑定来源企业
    let invitedBy = null
    if (body.role === 'worker' && body.inviteCode) {
      const inviter = db.prepare(`SELECT id FROM companies WHERE invite_code = ?`).get(body.inviteCode)
      if (!inviter) throw badRequest('BAD_INVITE_CODE', '邀请码无效')
      invitedBy = inviter.id
    }

    const hash = bcrypt.hashSync(body.password, 10)
    const txn = db.transaction(() => {
      const { lastInsertRowid: userId } = db.prepare(
        `INSERT INTO users (role, phone, password_hash, name) VALUES (?, ?, ?, ?)`
      ).run(body.role, body.phone, hash, body.name)

      if (body.role === 'worker') {
        db.prepare(`INSERT INTO worker_profiles (user_id, invited_by_company_id) VALUES (?, ?)`).run(userId, invitedBy)
        ensureAccount('worker', userId)
      } else {
        const { level, note } = rateIndustry(body.industry)
        const { lastInsertRowid: companyId } = db.prepare(`
          INSERT INTO companies (user_id, company_name, license_no, industry, risk_level, risk_note)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, body.companyName, body.licenseNo, body.industry, level, note)
        ensureAccount('company', companyId)
        // 注册者即企业 owner 成员
        db.prepare(`INSERT INTO company_members (user_id, company_id, member_role) VALUES (?, ?, 'owner')`)
          .run(userId, companyId)
      }
      return userId
    })
    const userId = txn()
    recordAgreements(userId)
    logAction(userId, 'register', body.role)
    const user = { id: userId, role: body.role, phone: body.phone, name: body.name }
    res.status(201).json(issueSession(user))
  } catch (err) {
    next(err)
  }
})

// —— 登录（带防爆破：连续失败锁定）——
const qAttempt = db.prepare(`SELECT * FROM login_attempts WHERE phone = ?`)
const qUpsertAttempt = db.prepare(`
  INSERT INTO login_attempts (phone, fail_count, locked_until) VALUES (?, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until
`)
const qClearAttempt = db.prepare(`DELETE FROM login_attempts WHERE phone = ?`)

router.post('/login', (req, res, next) => {
  try {
    const { phone, password } = z.object({ phone: z.string(), password: z.string() }).parse(req.body)

    const attempt = qAttempt.get(phone)
    if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
      throw locked(`登录失败次数过多，请于 ${attempt.locked_until} 后重试`)
    }

    const row = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone)
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      const fails = (attempt?.fail_count ?? 0) + 1
      const lockedUntil = fails >= config.loginMaxFails
        ? new Date(Date.now() + config.loginLockMinutes * 60000).toISOString()
        : null
      qUpsertAttempt.run(phone, fails >= config.loginMaxFails ? 0 : fails, lockedUntil)
      throw unauthorized(lockedUntil
        ? `登录失败次数过多，账号已锁定 ${config.loginLockMinutes} 分钟`
        : '手机号或密码错误')
    }
    if (row.status !== 'active') throw locked('账号已被停用，请联系平台运营')

    qClearAttempt.run(phone)
    // 运营端 2FA：已绑定动态码的账号须二段验证
    if (row.role === 'admin' && row.totp_enabled) {
      const tmpToken = jwt.sign({ sub: row.id, scope: 'totp' }, config.jwtSecret, { expiresIn: '5m' })
      return res.json({ needTotp: true, tmpToken })
    }
    const user = { id: row.id, role: row.role, phone: row.phone, name: row.name }
    logAction(row.id, 'login', row.role)
    db.prepare(`INSERT INTO login_logs (user_id, ip, ua) VALUES (?, ?, ?)`)
      .run(row.id, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200))
    res.json(issueSession(user))
  } catch (err) {
    next(err)
  }
})

// —— 2FA 二段验证（密码通过后凭 tmpToken + 动态码换取会话）——
router.post('/totp', (req, res, next) => {
  try {
    const { tmpToken, code } = z.object({ tmpToken: z.string(), code: z.string().length(6) }).parse(req.body)
    let payload
    try {
      payload = jwt.verify(tmpToken, config.jwtSecret)
    } catch {
      throw unauthorized('验证会话已过期，请重新登录')
    }
    if (payload.scope !== 'totp') throw unauthorized()
    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(payload.sub)
    if (!row || row.status !== 'active' || !row.totp_enabled) throw unauthorized()
    if (!verifyTotp(row.totp_secret, code)) throw unauthorized('动态码不正确')
    const user = { id: row.id, role: row.role, phone: row.phone, name: row.name }
    logAction(row.id, 'login', `${row.role}(2fa)`)
    db.prepare(`INSERT INTO login_logs (user_id, ip, ua) VALUES (?, ?, ?)`)
      .run(row.id, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200))
    res.json(issueSession(user))
  } catch (err) {
    next(err)
  }
})

// —— 刷新访问令牌（轮换：旧 refreshToken 即刻吊销）——
router.post('/refresh', (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(32) }).parse(req.body)
    const row = db.prepare(`SELECT * FROM refresh_tokens WHERE token_hash = ?`).get(hashToken(refreshToken))
    if (!row || row.revoked || new Date(row.expires_at) < new Date()) {
      throw unauthorized('刷新令牌无效或已过期，请重新登录')
    }
    const u = db.prepare(`SELECT id, role, phone, name, status FROM users WHERE id = ?`).get(row.user_id)
    if (!u || u.status !== 'active') throw unauthorized('账号不可用')
    db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE id = ?`).run(row.id)
    res.json(issueSession({ id: u.id, role: u.role, phone: u.phone, name: u.name }))
  } catch (err) {
    next(err)
  }
})

// —— 微信小程序登录（零工端）——
// 已绑定 openid：直接登录；未绑定：携带 phone+name 即注册并绑定（首次登录补手机号），
// 仅携带 code 且未绑定时返回 404 提示走注册流程。
router.post('/wechat', async (req, res, next) => {
  try {
    const body = z.object({
      code: z.string().min(4),
      phone: phoneSchema.optional(),
      name: personNameSchema.optional(),
      agree: z.boolean().optional()
    }).parse(req.body)

    const session = await code2session(body.code)
    if (!session.ok) throw badRequest('WECHAT_FAILED', session.message)

    let row = db.prepare(`SELECT * FROM users WHERE wx_openid = ?`).get(session.openid)
    if (!row && body.phone) {
      // 手机号已注册零工 → 绑定 openid；未注册 → 创建账号（随机强密码，后续可改密）
      row = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(body.phone)
      if (row) {
        if (row.role !== 'worker') throw badRequest('ROLE_MISMATCH', '该手机号不是零工账号')
        db.prepare(`UPDATE users SET wx_openid = ? WHERE id = ?`).run(session.openid, row.id)
      } else {
        if (!body.name) throw badRequest('NAME_REQUIRED', '首次登录请填写姓名')
        if (body.agree !== true) throw badRequest('AGREE_REQUIRED', '请先阅读并同意平台服务协议与隐私政策')
        const tempPw = genTempPassword()
        const txn = db.transaction(() => {
          const { lastInsertRowid: userId } = db.prepare(
            `INSERT INTO users (role, phone, password_hash, name, wx_openid) VALUES ('worker', ?, ?, ?, ?)`
          ).run(body.phone, bcrypt.hashSync(tempPw, 10), body.name, session.openid)
          db.prepare(`INSERT INTO worker_profiles (user_id) VALUES (?)`).run(userId)
          ensureAccount('worker', userId)
          return userId
        })
        const userId = txn()
        recordAgreements(userId)
        row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId)
        logAction(userId, 'register', 'worker(wechat)')
      }
    }
    if (!row) {
      return res.status(404).json({ error: { code: 'NEED_BIND', message: '该微信尚未绑定账号，请补充手机号完成注册' } })
    }
    if (row.status !== 'active') throw locked('账号已被停用，请联系平台运营')

    const user = { id: row.id, role: row.role, phone: row.phone, name: row.name }
    logAction(row.id, 'login', 'wechat')
    res.json(issueSession(user))
  } catch (err) {
    next(err)
  }
})

// —— 公开协议文本（注册页免登录查看）——
router.get('/legal/:type', (req, res, next) => {
  try {
    if (!['tos', 'privacy'].includes(req.params.type)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '文书不存在' } })
    }
    const doc = getLegalDoc(req.params.type)
    res.json({ type: doc.type, title: doc.title, version: doc.version, content: doc.content })
  } catch (err) {
    next(err)
  }
})

// —— 登出：吊销当前用户全部刷新令牌 ——
router.post('/logout', authenticate, (req, res) => {
  db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`).run(req.user.id)
  logAction(req.user.id, 'logout', '')
  res.json({ ok: true })
})

// —— 当前用户（含权限与企业成员角色，供前端控制菜单/按钮）——
router.get('/me', authenticate, (req, res) => {
  const row = db.prepare(`SELECT id, role, phone, name, totp_enabled FROM users WHERE id = ?`).get(req.user.id)
  if (!row) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '用户不存在' } })
  const result = { id: row.id, role: row.role, phone: row.phone, name: row.name }
  if (row.role === 'admin') {
    result.permissions = getPermissions(row.id)
    result.totpEnabled = !!row.totp_enabled
    const roleRow = db.prepare(`
      SELECT r.name FROM users u JOIN admin_roles r ON r.id = u.admin_role_id WHERE u.id = ?
    `).get(row.id)
    result.roleName = roleRow?.name ?? null
  }
  if (row.role === 'company') {
    const m = getMembership(row.id)
    result.memberRole = m?.member_role ?? null
  }
  res.json(result)
})

// —— 修改密码（全角色）——
router.post('/change-password', authenticate, (req, res, next) => {
  try {
    const { oldPassword, newPassword } = z.object({
      oldPassword: z.string(),
      newPassword: passwordSchema
    }).parse(req.body)
    const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user.id)
    if (!bcrypt.compareSync(oldPassword, row.password_hash)) {
      throw badRequest('WRONG_PASSWORD', '原密码不正确')
    }
    if (oldPassword === newPassword) {
      throw badRequest('SAME_PASSWORD', '新密码不能与原密码相同')
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
      .run(bcrypt.hashSync(newPassword, 10), req.user.id)
    // 改密即失效本人全部刷新令牌：任何端的旧会话都无法再凭 refreshToken 续期（防止改密后旧会话存活）
    db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`).run(req.user.id)
    logAction(req.user.id, 'change_password', '')
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
