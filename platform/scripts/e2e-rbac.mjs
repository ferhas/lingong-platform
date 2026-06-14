// RBAC 验证：造受限运营角色(审核专员) + 企业子账号(operator/finance)，浏览器验证权限门禁。
// 断言：禁止页被重定向（pathname≠请求路径），允许页正常加载（pathname=请求路径）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'
const API = 'http://127.0.0.1:3000/api/v1'
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9355
const OUT = path.resolve(process.cwd(), 'e2e-shots'); fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, p, { token, body } = {}) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) } }
const login = async (phone, password) => { const r = await api('POST', '/auth/login', { body: { phone, password } }); return r.data }

const admin = await login('13800000001', 'Admin@123456')
const owner = await login('13700000001', 'Company@123')

// —— 造受限运营角色账号 ——
const roles = (await api('GET', '/admin/roles', { token: admin.token })).data.list
const reviewerRole = roles.find(r => r.name === '审核专员')
async function ensureAdmin(phone, name, roleId) {
  const c = await api('POST', '/admin/users', { token: admin.token, body: { phone, name, roleId } })
  if (c.status === 201) return login(phone, c.data.tempPassword)
  console.log(`  (${phone} 创建返回 ${c.status} ${JSON.stringify(c.data)})`); return null
}
async function ensureMember(phone, name, memberRole) {
  const c = await api('POST', '/company/members', { token: owner.token, body: { phone, name, memberRole } })
  if (c.status === 201) return login(phone, c.data.tempPassword)
  console.log(`  (${phone} 创建返回 ${c.status} ${JSON.stringify(c.data)})`); return null
}
const reviewer = reviewerRole ? await ensureAdmin('13800009001', '审核员小测', reviewerRole.id) : null
const operator = await ensureMember('13700009001', '运营小测', 'operator')
const finance = await ensureMember('13700009002', '财务小测', 'finance')
console.log('审核专员:', reviewer ? 'OK' : '无', '| operator:', operator ? 'OK' : '无', '| finance:', finance ? 'OK' : '无')
console.log('company member login 是否带 memberRole? operator.user=', JSON.stringify(operator?.user), ' finance.user=', JSON.stringify(finance?.user))

// —— 浏览器 ——
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-proxy-server', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/chrome-rbac-${Date.now()}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
async function getWs() { for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } catch {} await sleep(300) } throw new Error('no cdp') }
const ws = new WebSocket(await getWs()); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let mid = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}) => { const id = ++mid; return new Promise(res => { pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
const evalv = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Runtime.enable')
const nav = async (url, s = 2600) => { await send('Page.navigate', { url }); await sleep(s) }
async function setAuth(origin, kv) { await nav(origin + '/login', 1500); await evalv(Object.entries(kv).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`).join(';')) }

const report = []
async function assertRoute(label, origin, route, expectAllowed) {
  await nav(origin + route)
  const pathname = await evalv('location.pathname')
  const landed = pathname === route
  const ok = expectAllowed ? landed : !landed
  report.push({ label, route, expectAllowed, pathname, ok })
  console.log(`${ok ? '✓' : '✗'} ${label}  请求${route} → 实际${pathname}  (${expectAllowed ? '应可访问' : '应被拦截'})`)
}

// 审核专员：可 /companies、不可 /configs /tax /users
if (reviewer) {
  await setAuth('http://localhost:5174', { gigwork_admin_token: reviewer.token, gigwork_admin_user: JSON.stringify(reviewer.user) })
  await assertRoute('审核专员·企业审核', 'http://localhost:5174', '/companies', true)
  await assertRoute('审核专员·参数配置(禁)', 'http://localhost:5174', '/configs', false)
  await assertRoute('审核专员·用户管理(禁)', 'http://localhost:5174', '/users', false)
}
// 企业 finance：可 /funds，不可 /publish /batch-publish /members
if (finance) {
  await setAuth('http://localhost:5173', { token: finance.token, user: JSON.stringify({ ...finance.user, memberRole: 'finance' }) })
  await assertRoute('财务·资金账户', 'http://localhost:5173', '/funds', true)
  await assertRoute('财务·发布任务(禁)', 'http://localhost:5173', '/publish', false)
  await assertRoute('财务·成员管理(禁)', 'http://localhost:5173', '/members', false)
}
// 企业 operator：可 /publish，不可 /members
if (operator) {
  await setAuth('http://localhost:5173', { token: operator.token, user: JSON.stringify({ ...operator.user, memberRole: 'operator' }) })
  await assertRoute('运营·发布任务', 'http://localhost:5173', '/publish', true)
  await assertRoute('运营·成员管理(禁)', 'http://localhost:5173', '/members', false)
}
ws.close(); chrome.kill()
const pass = report.filter(r => r.ok).length
console.log(`\n==== RBAC：${pass}/${report.length} 断言通过 ====`)
fs.writeFileSync(path.join(OUT, 'rbac_report.json'), JSON.stringify(report, null, 2))
process.exit(0)
