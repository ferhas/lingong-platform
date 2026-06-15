// 桌面宽视口(默认1300px) + 主题(THEME=dark|light)逐页截图，复现/验证：
//   1) 底部导航在桌面浏览器是否被拉宽（手机框 480px，导航是否溢出到全屏）
//   2) 深色配色是否协调
// 用法：NO_PROXY='*' THEME=dark ORIGIN=http://127.0.0.1:3000 node dark-shots.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const ORIGIN = (process.env.ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '')
const API = (process.env.API_BASE || ORIGIN) + '/api/v1'
const THEME = process.env.THEME || 'dark'
const W = +(process.env.W || 1300), H = +(process.env.H || 920)
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = +(process.env.PORT || 9231)
const BASE = process.env.BASE || (ORIGIN.includes('127.0.0.1') ? '/h5/' : '/')
const TAG = process.env.TAG || (THEME + '_' + (ORIGIN.includes('127.0.0.1') ? 'local' : 'prod'))
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.review-shots/dark'); fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const arr = v => Array.isArray(v) ? v : (v?.list ?? [])
const jget = async (u, t) => { const r = await fetch(API + u, { headers: { authorization: 'Bearer ' + t } }); return r.json().catch(() => null) }

const r0 = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13900000001', password: 'Demo@123456' }) })
const sess = await r0.json()
if (!sess.token) { console.error('登录失败', sess); process.exit(1) }
console.log('登录:', sess.user.name, '| 主题:', THEME, '| 视口:', W + 'x' + H, '| 源:', ORIGIN)
const hall = arr(await jget('/worker/tasks?pageSize=50', sess.token))
const detailId = hall[0]?.id
// 子页 ID（容错：取不到就跳过该子页）
const firstId = async (u) => { const r = arr(await jget(u, sess.token)); return r[0]?.id }
const disputeId = await firstId('/worker/disputes')
const ticketId = await firstId('/me/tickets')
const orderId = (arr(await jget('/worker/orders?pageSize=50', sess.token)).find(o => /working|in_progress|accepted|delivering/i.test(o.status)) || {}).id
let helpId = null; try { const h = await jget('/me/help', sess.token); const l = h?.list || h?.articles || h; if (Array.isArray(l) && l[0]) helpId = l[0].id } catch {}

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${(process.env.TEMP || '/tmp')}/chrome-dark-${PORT}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' })
async function tgt() { for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p } catch {} await sleep(300) } throw new Error('no cdp') }
const ws = new WebSocket((await tgt()).webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let mid = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}) => { const id = ++mid; return new Promise(res => { pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJS = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); return r.result?.result?.value }
const shot = async n => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(OUT, `${TAG}_${n}.png`), Buffer.from(s.result.data, 'base64')) }
await send('Page.enable'); await send('Runtime.enable')
// 桌面真实视口（非移动模拟），这样手机框 480px 居中、导航若溢出可见
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

await send('Page.navigate', { url: ORIGIN + BASE }); await sleep(1500)
await evalJS(`localStorage.setItem('wx:token',${JSON.stringify(JSON.stringify(sess.token))});localStorage.setItem('wx:user',${JSON.stringify(JSON.stringify(sess.user))});localStorage.setItem('wx:refreshToken',${JSON.stringify(JSON.stringify(sess.refreshToken || ''))});localStorage.setItem('wx:theme_pref',${JSON.stringify(JSON.stringify(THEME))})`)
await send('Page.navigate', { url: ORIGIN + BASE }); await sleep(2000)

const PAGES = [
  ['index', '/pages/index/index'], ['orders', '/pages/orders/orders'], ['mine', '/pages/mine/mine'],
  ['income', '/pages/income/income'], ['verify', '/pages/verify/verify'], ['notices', '/pages/notices/notices'],
  ['contracts', '/pages/contracts/contracts'], ['disputes', '/pages/disputes/disputes'], ['skills', '/pages/skills/skills'],
  ['insurance', '/pages/insurance/insurance'], ['soletrader', '/pages/soletrader/soletrader'], ['help', '/pages/help/help'],
  ['favorites', '/pages/favorites/favorites'], ['bindcard', '/pages/bindcard/bindcard'], ['legal', '/pages/legal/legal'],
  ['password', '/pages/password/password'], ['tickets', '/pages/tickets/tickets'],
]
if (detailId) PAGES.push(['detail', '/pages/detail/detail?id=' + detailId])
PAGES.push(['tickets_new', '/pages/tickets/new'])
if (disputeId) PAGES.push(['dispute_detail', '/pages/disputes/detail?id=' + disputeId])
if (ticketId) PAGES.push(['ticket_detail', '/pages/tickets/detail?id=' + ticketId])
if (helpId) PAGES.push(['help_article', '/pages/help/article?id=' + helpId])
if (orderId) PAGES.push(['deliver', '/pages/deliver/deliver?id=' + orderId])

for (const [n, p] of PAGES) {
  await evalJS(`wx.reLaunch({url:${JSON.stringify(p)}})`)
  await sleep(1100)
  await shot(n)
  // 量一下 tab-shell 与手机框的宽度，给出量化结论
  const m = await evalJS(`(()=>{const sh=document.querySelector('.tab-shell');const app=document.getElementById('wx-app');if(!sh)return null;const a=app.getBoundingClientRect(),s=sh.getBoundingClientRect();return {app:Math.round(a.width),appLeft:Math.round(a.left),tab:Math.round(s.width),tabLeft:Math.round(s.left)}})()`)
  console.log(`  ${n}${m ? `  框宽=${m.app}@${m.appLeft}  导航宽=${m.tab}@${m.tabLeft}${m.tab > m.app + 2 ? '  ⚠拉宽' : ''}` : ''}`)
}
ws.close(); chrome.kill()
console.log(`\n截图输出 → ${OUT}  (前缀 ${TAG}_)`)
process.exit(0)
