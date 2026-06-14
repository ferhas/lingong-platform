// E2E 全角色浏览器巡检：Chrome headless + CDP。
// 登录各角色注入 localStorage token → 遍历所有路由 → 捕获 console.error / 未捕获异常 / API 4xx-5xx / 加载失败 → 逐页截图 → 输出 e2e-shots/report.json。
// 用法: node scripts/e2e-walk.mjs [apiBase] [rolesCSV]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const API = (process.argv[2] || 'http://127.0.0.1:3000') + '/api/v1'
const ONLY = (process.argv[3] || '').split(',').filter(Boolean)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const OUT = path.resolve(process.cwd(), 'e2e-shots')
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function login(phone, password) {
  const res = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) })
  const d = await res.json().catch(() => ({}))
  if (!d.token) throw new Error('login failed ' + phone + ': ' + JSON.stringify(d))
  return d
}

const admin = await login('13800000001', 'Admin@123456')
const company = await login('13700000001', 'Company@123')

let ROLES = [
  {
    name: 'admin', origin: process.env.ADMIN_ORIGIN || 'http://localhost:5174',
    storage: { gigwork_admin_token: admin.token, gigwork_admin_user: JSON.stringify(admin.user), ...(admin.refreshToken ? { gigwork_admin_refresh: admin.refreshToken } : {}) },
    routes: ['/dashboard', '/companies', '/workers', '/risk', '/quality', '/tax', '/invoices', '/archives', '/integrations', '/flows', '/funds-orders', '/configs', '/delivery-specs', '/legal', '/users', '/audit', '/disputes', '/tickets', '/skills', '/input-invoices', '/finance', '/exports', '/events', '/system-health', '/templates', '/help-admin', '/credentials', '/security', '/password']
  },
  {
    name: 'company', origin: process.env.COMPANY_ORIGIN || 'http://localhost:5173',
    storage: { token: company.token, user: JSON.stringify(company.user), ...(company.refreshToken ? { refreshToken: company.refreshToken } : {}) },
    routes: ['/dashboard', '/tasks', '/publish', '/batch-publish', '/funds', '/statement', '/invoices', '/disputes', '/tickets', '/contracts', '/members', '/profile', '/password']
  }
]
if (ONLY.length) ROLES = ROLES.filter(r => ONLY.includes(r.name))

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-proxy-server', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/chrome-e2e-${Date.now()}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })

async function getWs() {
  for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } catch {} await sleep(300) }
  throw new Error('no chrome cdp')
}
const ws = new WebSocket(await getWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let msgId = 0; const pending = new Map(); let buf = []
const NOISE = [/ResizeObserver loop/, /favicon\.ico/, /\[Vue Router warn\]/, /Download the Vue Devtools/]
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  const p = m.params
  if (m.method === 'Runtime.exceptionThrown') { const d = p.exceptionDetails; buf.push({ type: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text }) }
  else if (m.method === 'Runtime.consoleAPICalled') { if (p.type === 'error' || p.type === 'warning') buf.push({ type: 'console.' + p.type, text: (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ') }) }
  else if (m.method === 'Log.entryAdded') { const en = p.entry; if (en.level === 'error') buf.push({ type: 'log.error', text: en.text, url: en.url }) }
  else if (m.method === 'Network.responseReceived') { const r = p.response; if (r.status >= 400) buf.push({ type: 'http', status: r.status, url: r.url }) }
  else if (m.method === 'Network.loadingFailed') { if (!p.canceled) buf.push({ type: 'loadfail', text: p.errorText }) }
}
function send(method, params = {}) { const id = ++msgId; return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
async function nav(url, settle = 2800) { await send('Page.navigate', { url }); await sleep(settle) }
const clean = t => (t || '').replace(/\s+/g, ' ').trim()
const isNoise = t => NOISE.some(re => re.test(t || ''))

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable')

const report = []
for (const role of ROLES) {
  await nav(role.origin + '/login', 1500)
  const setters = Object.entries(role.storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`).join(';')
  await send('Runtime.evaluate', { expression: setters })
  for (const route of role.routes) {
    buf = []
    await nav(role.origin + route)
    const title = (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result?.result?.value
    const body = (await send('Runtime.evaluate', { expression: '(document.body&&document.body.innerText||"").replace(/\\s+/g," ").trim().slice(0,80)', returnByValue: true })).result?.result?.value
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const out = `${role.name}_${route.replace(/\//g, '_') || 'root'}.png`
    if (shot.result) fs.writeFileSync(path.join(OUT, out), Buffer.from(shot.result.data, 'base64'))
    const problems = buf.filter(b => {
      if (b.type === 'console.warning') return false
      if (b.type === 'http') return /\/api\//.test(b.url || '')
      if (isNoise(b.text)) return false
      return true
    }).map(b => ({ ...b, text: clean(b.text) }))
    if (!body || body.length < 4) problems.push({ type: 'blank', text: `页面空白/未渲染 body="${body}"` })
    report.push({ role: role.name, route, title, body, problems })
    const flag = problems.length ? '✗' : '✓'
    console.log(`${flag} ${role.name} ${route}  [${clean(title)}]  body="${body}"  problems=${problems.length}`)
    for (const pr of problems.slice(0, 6)) console.log(`     · ${pr.type} ${pr.status || ''} ${clean(pr.text || pr.url).slice(0, 170)}`)
  }
}
ws.close(); chrome.kill()
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const total = report.reduce((a, r) => a + r.problems.length, 0)
console.log(`\n==== 巡检完成：${report.length} 页，问题 ${total} 处 ====`)
for (const b of report.filter(r => r.problems.length)) console.log(`  ✗ ${b.role} ${b.route} (${b.problems.length})`)
