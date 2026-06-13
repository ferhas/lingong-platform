// 权限体系：运营端 RBAC（角色 → 权限点）+ 企业端成员角色（owner/operator/finance）
import db from '../db.js'
import { forbidden } from '../utils/errors.js'

const qRole = db.prepare(`
  SELECT r.permissions FROM users u JOIN admin_roles r ON r.id = u.admin_role_id WHERE u.id = ?
`)

export function getPermissions(userId) {
  const row = qRole.get(userId)
  if (!row) return []
  return JSON.parse(row.permissions)
}

export function hasPermission(perms, perm) {
  return perms.includes('*') || perms.includes(perm)
}

/** 运营端细粒度权限：requirePermission('tax:declare') */
export const requirePermission = perm => (req, _res, next) => {
  const perms = getPermissions(req.user.id)
  if (!hasPermission(perms, perm)) {
    return next(forbidden(`缺少权限：${perm}`))
  }
  req.permissions = perms
  next()
}

const qMember = db.prepare(`SELECT * FROM company_members WHERE user_id = ?`)

export function getMembership(userId) {
  return qMember.get(userId)
}

/** 企业端成员角色门禁：requireCompanyRole('owner','finance') */
export const requireCompanyRole = (...roles) => (req, _res, next) => {
  const m = getMembership(req.user.id)
  if (!m) return next(forbidden('非企业成员'))
  if (!roles.includes(m.member_role)) {
    return next(forbidden(`当前成员角色（${m.member_role}）无权执行此操作`))
  }
  req.membership = m
  next()
}
