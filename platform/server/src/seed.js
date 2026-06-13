// 初始化运营超级管理员账号（幂等）。生产部署后第一时间修改密码。
import bcrypt from 'bcryptjs'
import db from './db.js'

const ADMIN_PHONE = process.env.ADMIN_PHONE || '13800000001'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123456'

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
const exists = db.prepare(`SELECT id, admin_role_id FROM users WHERE phone = ?`).get(ADMIN_PHONE)

if (exists) {
  if (!exists.admin_role_id) {
    db.prepare(`UPDATE users SET admin_role_id = ? WHERE id = ?`).run(superRole.id, exists.id)
    console.log(`管理员已存在（${ADMIN_PHONE}），已补齐超级管理员角色`)
  } else {
    console.log(`管理员已存在（${ADMIN_PHONE}），跳过`)
  }
} else {
  db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', ?, ?, '平台运营', ?)`)
    .run(ADMIN_PHONE, bcrypt.hashSync(ADMIN_PASSWORD, 10), superRole.id)
  console.log(`超级管理员已创建：${ADMIN_PHONE} / ${ADMIN_PASSWORD}`)
}
