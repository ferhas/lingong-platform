import jwt from 'jsonwebtoken'
import config from '../config.js'
import db from '../db.js'
import { unauthorized, forbidden } from '../utils/errors.js'

const qStatus = db.prepare(`SELECT status FROM users WHERE id = ?`)

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return next(unauthorized())
  try {
    const payload = jwt.verify(token, config.jwtSecret)
    const row = qStatus.get(payload.sub)
    if (!row) return next(unauthorized('用户不存在'))
    if (row.status !== 'active') return next(forbidden('账号已被停用，请联系平台运营'))
    req.user = { id: payload.sub, role: payload.role, name: payload.name }
    next()
  } catch {
    next(unauthorized())
  }
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden())
  next()
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  )
}
