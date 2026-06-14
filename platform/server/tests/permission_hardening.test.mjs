// 权限提权防护回归测试：以「持 user:manage 的非超管自定义角色」为攻击者视角，验证
//  - 无法借建号/改角色/建角色/改角色定义获得「全部权限(*)」（自我提权）
//  - 无法停用/启用/重置/改动「超级管理员」账号
//  - 但仍保留对零工/企业账号与非超管角色的治理能力（账号封禁不被误伤）
//  - 改密吊销本人全部刷新令牌（D）
//  - /admin/system-health 按 integration:read 鉴权（G，与页面/菜单一致）
// 独立临时库、进程内启动，无需外部依赖。
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `gigwork-ph-${Date.now()}.db`)
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `gigwork-ph-up-${Date.now()}`)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.NODE_ENV = 'test'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')
const bcrypt = (await import('bcryptjs')).default

const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`INSERT INTO users (role, phone, password_hash, name, admin_role_id) VALUES ('admin', '13800000001', ?, '平台运营', ?)`)
  .run(bcrypt.hashSync('Admin@123456', 10), superRole.id)

const server = app.listen(0)
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`

let passed = 0
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`) }

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const ct = res.headers.get('content-type') || ''
  return { status: res.status, data: ct.includes('json') ? await res.json().catch(() => null) : await res.text() }
}

try {
  let r = await api('POST', '/auth/login', { body: { phone: '13800000001', password: 'Admin@123456' } })
  const adminToken = r.data.token
  const superUserId = db.prepare(`SELECT id FROM users WHERE phone = '13800000001'`).get().id
  const superRoleId = superRole.id

  console.log('— 准备：超管创建「账号管理员」自定义角色与账号 —')
  r = await api('POST', '/admin/roles', { token: adminToken, body: { name: '账号管理员', permissions: ['user:read', 'user:manage'] } })
  ok('超管创建 user:manage 自定义角色（201）', r.status === 201)
  const acctRoleId = r.data.id
  r = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13800000091', name: '账号管理员', roleId: acctRoleId } })
  ok('超管创建账号管理员用户（201）', r.status === 201)
  const mgrPw = r.data.tempPassword
  r = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13800000092', name: '目标管理员', roleId: acctRoleId } })
  const targetAdminId = r.data.userId
  r = await api('POST', '/auth/login', { body: { phone: '13800000091', password: mgrPw } })
  const mgrToken = r.data.token
  ok('账号管理员登录成功（未绑2FA时 stepUp 放行）', r.status === 200 && !!mgrToken)

  console.log('— 提权防护：user:manage 无法获得「全部权限(*)」—')
  r = await api('POST', '/admin/users', { token: mgrToken, body: { phone: '13800000093', name: '新超管', roleId: superRoleId } })
  ok('建号时分配超管角色被拒（403）', r.status === 403)
  r = await api('PATCH', `/admin/users/${targetAdminId}/role`, { token: mgrToken, body: { roleId: superRoleId } })
  ok('把他人改为超管角色被拒（403）', r.status === 403)
  r = await api('POST', '/admin/roles', { token: mgrToken, body: { name: '坏超管', permissions: ['*'] } })
  ok('创建含 * 的角色被拒（403）', r.status === 403)
  r = await api('PATCH', `/admin/roles/${acctRoleId}`, { token: mgrToken, body: { permissions: ['user:read', 'user:manage', '*'] } })
  ok('把自身所属角色编辑为含 * 被拒（403）', r.status === 403)

  console.log('— 超管账号保护：非超管不能攻击超管账号 —')
  r = await api('POST', `/admin/users/${superUserId}/reset-password`, { token: mgrToken })
  ok('重置超管密码被拒（403）', r.status === 403)
  r = await api('POST', `/admin/users/${superUserId}/disable`, { token: mgrToken })
  ok('停用超管账号被拒（403）', r.status === 403)
  r = await api('PATCH', `/admin/users/${superUserId}/role`, { token: mgrToken, body: { roleId: acctRoleId } })
  ok('改超管账号角色被拒（403）', r.status === 403)

  console.log('— 既有能力保留：非超管可治理非超管角色与零工账号 —')
  r = await api('POST', '/admin/roles', { token: mgrToken, body: { name: '客服小组', permissions: ['ticket:read', 'ticket:manage'] } })
  ok('创建普通自定义角色成功（201）', r.status === 201)
  const csRoleId = r.data.id
  r = await api('PATCH', `/admin/users/${targetAdminId}/role`, { token: mgrToken, body: { roleId: csRoleId } })
  ok('把他人改为普通角色成功（200）', r.status === 200)
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000077', password: 'Test@123456', name: '测试零工', agree: true } })
  const workerId = r.data.user.id
  r = await api('POST', `/admin/users/${workerId}/disable`, { token: mgrToken })
  ok('账号管理员封禁零工账号成功（200，账号治理不被误伤）', r.status === 200)
  r = await api('POST', `/admin/users/${workerId}/enable`, { token: mgrToken })
  ok('账号管理员恢复零工账号成功（200）', r.status === 200)
  r = await api('POST', `/admin/users/${workerId}/reset-password`, { token: mgrToken })
  ok('账号管理员重置零工密码成功（200）', r.status === 200 && !!r.data.tempPassword)

  console.log('— 超管不受限：可分配超管角色 —')
  r = await api('PATCH', `/admin/users/${targetAdminId}/role`, { token: adminToken, body: { roleId: superRoleId } })
  ok('超管可将他人提升为超管（200）', r.status === 200)

  console.log('— 改密吊销刷新令牌（D）—')
  r = await api('POST', '/auth/register', { body: { role: 'worker', phone: '13900000078', password: 'Test@123456', name: '改密零工', agree: true } })
  const w2Token = r.data.token
  r = await api('POST', '/auth/refresh', { body: { refreshToken: r.data.refreshToken } })
  ok('改密前刷新令牌可用（200）', r.status === 200)
  const w2Rt2 = r.data.refreshToken
  await api('POST', '/auth/change-password', { token: w2Token, body: { oldPassword: 'Test@123456', newPassword: 'NewPass@123456' } })
  r = await api('POST', '/auth/refresh', { body: { refreshToken: w2Rt2 } })
  ok('改密后刷新令牌被吊销（401）', r.status === 401)

  console.log('— system-health 按 integration:read 鉴权（G）—')
  r = await api('POST', '/admin/roles', { token: adminToken, body: { name: '运维只读', permissions: ['integration:read'] } })
  const opsRoleId = r.data.id
  r = await api('POST', '/admin/users', { token: adminToken, body: { phone: '13800000094', name: '运维', roleId: opsRoleId } })
  const opsPw = r.data.tempPassword
  r = await api('POST', '/auth/login', { body: { phone: '13800000094', password: opsPw } })
  const opsToken = r.data.token
  r = await api('GET', '/admin/system-health', { token: opsToken })
  ok('integration:read 角色可访问 system-health（200，原 dashboard:read 不一致已修复）', r.status === 200)
  r = await api('GET', '/admin/system-health', { token: mgrToken })
  ok('无 integration:read 的账号管理员访问 system-health 被拒（403）', r.status === 403)

  console.log(`\n✅ 权限提权防护回归测试 ${passed} 项通过`)
  server.close()
  process.exit(0)
} catch (err) {
  console.error('\n❌ 测试失败:', err.message)
  server.close()
  process.exit(1)
}
