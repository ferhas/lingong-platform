// 线上零工端 H5 巡检（通过域名）：生产禁用 mock 登录，改用手机号+密码登录拿 token 注入 wx:token，
// 然后遍历页面 + 报名/提现。用法：NO_PROXY='*' node h5-live.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const ORIGIN = process.env.WORKER_ORIGIN || 'https://lingong-worker.eexb.com'
const API = (process.env.API_BASE || 'https://lingong-api.eexb.com') + '/api/v1'
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9227
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.review-shots'); fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const arr = v => Array.isArray(v) ? v : (v?.list ?? [])
const jget = async (u, t) => { const r = await fetch(API + u, { headers: { authorization: 'Bearer ' + t } }); return r.json().catch(() => null) }
const r0 = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13900000001', password: 'Demo@123456' }) })
const sess = await r0.json()
if (!sess.token) { console.error('登录失败', sess); process.exit(1) }
console.log('登录:', sess.user.name, sess.user.phone)
const hall = arr(await jget('/worker/tasks?pageSize=50', sess.token))
let applyId = null
for (const t of hall) { const d = await jget('/worker/tasks/' + t.id, sess.token); if (d && !d.applied && !d.hasApplied && d.status === 'recruiting') { applyId = t.id; break } }
const wdBefore = arr(await jget('/worker/withdrawals', sess.token)).length

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${(process.env.TEMP || '/tmp')}/chrome-h5live-${Date.now()}`, '--window-size=420,860', 'about:blank'], { stdio: 'ignore' })
async function tgt() { for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p } catch {} await sleep(300) } throw new Error('no cdp') }
const ws = new WebSocket((await tgt()).webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let mid = 0; const pend = new Map(); let evs = []
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return } if (m.method === 'Runtime.exceptionThrown') evs.push('exception:' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') evs.push('console.error:' + (m.params.args || []).map(a => a.value ?? a.description).join(' ')) }
const send = (method, params = {}) => { const id = ++mid; return new Promise(res => { pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJS = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : { value: r.result?.result?.value } }
const shot = async n => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(OUT, 'h5live_' + n + '.png'), Buffer.from(s.result.data, 'base64')) }
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 2, mobile: true })
const reLaunch = url => evalJS(`wx.reLaunch({url:${JSON.stringify(url)}})`)
const route = async () => (await evalJS(`(()=>{const p=getCurrentPages&&getCurrentPages();return p&&p.length?p[p.length-1].route:'?'})()`)).value
const tapText = txt => evalJS(`(()=>{const t=${JSON.stringify(txt)};const els=[...document.querySelectorAll('.wx-page button,.wx-page view,.wx-page text,#wx-overlay button,.wx-overlay button')].filter(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(!els.length)return{error:'no '+t};els.sort((a,b)=>a.textContent.trim().length-b.textContent.trim().length);els[0].click();return true})()`)
const report = []
async function step(name, page) { evs = []; await reLaunch(page); await sleep(1300); const rt = await route(); const ok = rt === page.replace(/^\//, '').split('?')[0] && !evs.some(e => e.startsWith('exception')); report.push({ name, route: rt, ok, evs: evs.slice() }); await shot(name); console.log(`${ok ? '✓' : '✗'} ${name} [${rt}]${evs.length ? ' ⚠' + evs.join(';').slice(0, 120) : ''}`) }

// 注入登录态（runtime 映射 wx.setStorageSync→localStorage['wx:'+k]）
await send('Page.navigate', { url: ORIGIN + '/' }); await sleep(2000)
await evalJS(`localStorage.setItem('wx:token',${JSON.stringify(JSON.stringify(sess.token))});localStorage.setItem('wx:user',${JSON.stringify(JSON.stringify(sess.user))});localStorage.setItem('wx:refreshToken',${JSON.stringify(JSON.stringify(sess.refreshToken || ''))})`)
await send('Page.navigate', { url: ORIGIN + '/' }); await sleep(2000)

// 遍历页面
for (const [n, p] of [['index', '/pages/index/index'], ['mine', '/pages/mine/mine'], ['income', '/pages/income/income'], ['orders', '/pages/orders/orders'], ['verify', '/pages/verify/verify'], ['notices', '/pages/notices/notices'], ['contracts', '/pages/contracts/contracts'], ['disputes', '/pages/disputes/disputes'], ['skills', '/pages/skills/skills'], ['insurance', '/pages/insurance/insurance'], ['soletrader', '/pages/soletrader/soletrader'], ['help', '/pages/help/help']]) await step(n, p)

// 报名（写操作 via 域名）
if (applyId) {
  evs = []; await reLaunch('/pages/detail/detail?id=' + applyId); await sleep(1500)
  await tapText('立即报名'); await sleep(900); await tapText('确定'); await sleep(400); await tapText('继续'); await sleep(1200)
  await shot('apply')
  const d = await jget('/worker/tasks/' + applyId, sess.token)
  report.push({ name: '报名(apply)', ok: !!(d && (d.applied || d.hasApplied)), route: 'detail' })
  console.log(`${(d && (d.applied || d.hasApplied)) ? '✓' : '✗'} 报名(apply) task=${applyId}`)
}
// 提现（写操作 via 域名）
{
  evs = []; await reLaunch('/pages/income/income'); await sleep(1500)
  await tapText('提现'); await sleep(900)
  await evalJS(`(()=>{const i=[...document.querySelectorAll('.wx-page input,.wx-overlay input,#wx-overlay input')].find(e=>e.offsetParent!==null);if(i){const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'100');i.dispatchEvent(new Event('input',{bubbles:true}))}return !!i})()`); await sleep(500)
  await tapText('确认提现'); await sleep(900); await tapText('确定'); await sleep(1200)
  await shot('withdraw')
  const wdAfter = arr(await jget('/worker/withdrawals', sess.token)).length
  report.push({ name: '提现(withdraw +1)', ok: wdAfter > wdBefore, route: 'income' })
  console.log(`${wdAfter > wdBefore ? '✓' : '✗'} 提现(withdraw) ${wdBefore}→${wdAfter}`)
}
ws.close(); chrome.kill()
const pass = report.filter(r => r.ok).length
console.log(`\n==== 线上零工端 H5：${pass}/${report.length} 通过 ====`)
fs.writeFileSync(path.join(OUT, 'h5live_report.json'), JSON.stringify(report, null, 2))
process.exit(0)
