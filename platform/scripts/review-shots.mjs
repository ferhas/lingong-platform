// UI/UX 审查截图工具：登录取 token → CDP 驱动无头 Edge → 全页截图（桌面+移动）
// 用法: node scripts/review-shots.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const API = 'http://127.0.0.1:3000/api/v1'
const OUT = 'D:/code/零工/lingong-platform/platform/.review-shots'
const PORT = 9223
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
fs.mkdirSync(OUT, { recursive: true })

async function api(url, body) {
  const res = await fetch(API + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}
async function getMe(token) {
  const res = await fetch(API + '/auth/me', { headers: { authorization: `Bearer ${token}` } })
  return res.json()
}

// —— 取登录态 ——
const adminLogin = await api('/auth/login', { phone: '13800000001', password: 'Admin@123456' })
const adminMe = await getMe(adminLogin.token)
const companyLogin = await api('/auth/login', { phone: '13700000001', password: 'Company@123' })
const companyMe = await getMe(companyLogin.token)
console.log('admin perms:', JSON.stringify(adminMe.permissions), 'company role:', companyMe.memberRole)

const THEME = process.env.SHOT_THEME || '' // '', 'light', 'dark'
const SUF = process.env.SHOT_SUFFIX || ''

const APPS = [
  {
    name: 'company',
    origin: 'http://localhost:5173',
    themeKey: 'gw-company-theme',
    storage: {
      token: companyLogin.token,
      refreshToken: companyLogin.refreshToken || '',
      user: JSON.stringify({ ...companyLogin.user, ...companyMe })
    },
    pages: [
      'dashboard', 'tasks', 'publish', 'batch-publish', 'funds', 'statement',
      'invoices', 'disputes', 'tickets', 'contracts', 'members', 'profile', 'password'
    ],
    mobilePages: ['dashboard', 'tasks', 'publish', 'funds']
  },
  {
    name: 'admin',
    origin: 'http://localhost:5174',
    themeKey: 'gw-admin-theme',
    storage: {
      gigwork_admin_token: adminLogin.token,
      gigwork_admin_refresh: adminLogin.refreshToken || '',
      gigwork_admin_user: JSON.stringify({ ...adminLogin.user, ...adminMe })
    },
    pages: [
      'dashboard', 'companies', 'workers', 'risk', 'quality', 'tax', 'invoices',
      'archives', 'integrations', 'flows', 'funds-orders', 'configs', 'legal',
      'users', 'audit', 'disputes', 'tickets', 'skills', 'input-invoices',
      'finance', 'exports', 'events', 'system-health', 'templates', 'help-admin',
      'credentials', 'security'
    ],
    mobilePages: ['dashboard', 'companies', 'risk']
  }
]

// —— 启动 Edge ——
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-proxy-server',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/edge-cdp-${Date.now()}`,
  '--disable-features=ForcedColors', '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(300)
  }
  throw new Error('无法连接 Edge CDP')
}

const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}) {
  const id = ++msgId
  return new Promise(res => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')

async function setViewport(w, h, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile,
    screenWidth: w, screenHeight: h
  })
}

async function navigate(url, settle = 2600) {
  await send('Page.navigate', { url })
  await sleep(settle)
}

const MEASURE = `(()=>{const sel=['.content','.main-content','.el-main','main','.page','#app'];let h=0;for(const s of sel){document.querySelectorAll(s).forEach(e=>{if(e.scrollHeight>h)h=e.scrollHeight})}return Math.max(h,document.documentElement.scrollHeight,document.body.scrollHeight)})()`

async function shootTight(outFile, width, mobile) {
  // 在常规视口测真实内容高度（内部滚动容器 scrollHeight）
  const r = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  let H = Math.ceil(r.result?.result?.value || 900)
  H = Math.min(Math.max(H + 24, 600), 8000)
  await setViewport(width, H, mobile)
  await sleep(550)
  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: H, scale: 1 }
  })
  if (!shot.result) { console.log('  !! no result', outFile); return }
  fs.writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'))
  console.log('  ✓', path.basename(outFile), `${width}x${H}`)
}

const storageWithTheme = app => (THEME ? { ...app.storage, [app.themeKey]: THEME } : app.storage)

for (const app of APPS) {
  // 先访问 login 写 localStorage（含主题）
  await setViewport(1440, 900, false)
  await navigate(app.origin + '/login', 1200)
  if (THEME) {
    await send('Runtime.evaluate', { expression: `localStorage.setItem(${JSON.stringify(app.themeKey)}, ${JSON.stringify(THEME)})` })
    await navigate(app.origin + '/login', 1200)
  }
  // 截登出态 login
  await shootTight(`${OUT}/${app.name}_login${SUF}.png`, 1440, false)
  const setters = Object.entries(storageWithTheme(app))
    .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`)
    .join(';')
  await send('Runtime.evaluate', { expression: setters })

  // 桌面端：常规视口导航，测高后紧凑全页
  for (const p of app.pages) {
    await setViewport(1440, 1000, false)
    await navigate(app.origin + '/' + p)
    await shootTight(`${OUT}/${app.name}_${p}${SUF}.png`, 1440, false)
  }
  // 移动端
  for (const p of app.mobilePages) {
    await setViewport(390, 900, true)
    await navigate(app.origin + '/' + p)
    await shootTight(`${OUT}/${app.name}_${p}_m${SUF}.png`, 390, true)
  }
}

ws.close()
edge.kill()
console.log('done ->', OUT)
