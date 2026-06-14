// 零工端 H5 写操作 E2E：报名 / 提现 / 交付（Chrome CDP 驱动 + API 核实）。
// 用法：NO_PROXY='*' node h5-writes.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const HOST = 'http://127.0.0.1:3000', API = HOST + '/api/v1', PORT = 9226
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.review-shots'); fs.mkdirSync(OUT, { recursive: true })
const PNG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test-deliverable.png')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const jpost = async (u, b) => { const r = await fetch(API + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => null) } }
const jget = async (u, t) => { const r = await fetch(API + u, { headers: { authorization: 'Bearer ' + t } }); return { status: r.status, data: await r.json().catch(() => null) } }
const arr = v => Array.isArray(v) ? v : (v?.list ?? [])

const login = await jpost('/auth/wechat', { code: 'demo-worker-2month-001' })
const token = login.data.token
// 选一个未报名的大厅任务
const hall = arr((await jget('/worker/tasks?pageSize=50', token)).data)
let applyTaskId = null
for (const t of hall) { const d = await jget('/worker/tasks/' + t.id, token); if (d.data && !d.data.applied && !d.data.hasApplied && d.data.status === 'recruiting') { applyTaskId = t.id; break } }
applyTaskId = applyTaskId || hall[0]?.id
// 选一个进行中订单用于交付
const orders = arr((await jget('/worker/orders', token)).data)
const workingOrder = orders.find(o => o.status === 'working')
const wdBefore = arr((await jget('/worker/withdrawals', token)).data).length
console.log('apply task:', applyTaskId, '| working order:', workingOrder?.id, '| withdrawals before:', wdBefore)

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${(process.env.TEMP || '/tmp')}/chrome-h5w-${Date.now()}`, '--window-size=420,860', 'about:blank'], { stdio: 'ignore' })
async function tgt() { for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p } catch {} await sleep(300) } throw new Error('no cdp') }
const ws = new WebSocket((await tgt()).webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let mid = 0; const pend = new Map(); let evs = []
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return } if (m.method === 'Runtime.exceptionThrown') evs.push('exception:' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') evs.push('console.error:' + (m.params.args || []).map(a => a.value ?? a.description).join(' ')) }
const send = (method, params = {}) => { const id = ++mid; return new Promise(res => { pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJS = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : { value: r.result?.result?.value } }
const shot = async n => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(OUT, 'h5w_' + n + '.png'), Buffer.from(s.result.data, 'base64')) }
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 2, mobile: true })
const reLaunch = url => evalJS(`wx.reLaunch({url:${JSON.stringify(url)}})`)
const tapText = txt => evalJS(`(()=>{const t=${JSON.stringify(txt)};const els=[...document.querySelectorAll('.wx-page button,.wx-page view,.wx-page text,#wx-overlay button,.wx-overlay button')].filter(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(!els.length)return{error:'no text '+t};els.sort((a,b)=>a.textContent.trim().length-b.textContent.trim().length);els[0].click();return true})()`)
const results = []
async function check(name, cond) { results.push({ name, ok: cond, evs: evs.slice() }); console.log(`${cond ? '✓' : '✗'} ${name}${evs.length ? ' ⚠' + evs.join(';').slice(0, 160) : ''}`); evs = [] }

// 启动 + 模拟登录
await evalJS('localStorage.clear()'); await send('Page.navigate', { url: HOST + '/h5/' }); await sleep(1700)
await tapText('模拟登录'); await sleep(1500)

// 1) 报名
evs = []
await reLaunch('/pages/detail/detail?id=' + applyTaskId); await sleep(1500)
await tapText('立即报名'); await sleep(900)
await tapText('确定'); await sleep(400); await tapText('继续'); await sleep(1200)
await shot('apply')
const appliedNow = await jget('/worker/tasks/' + applyTaskId, token)
await check('报名 apply', !!(appliedNow.data && (appliedNow.data.applied || appliedNow.data.hasApplied)))

// 2) 提现
evs = []
await reLaunch('/pages/income/income'); await sleep(1500)
await tapText('提现'); await sleep(900)
await evalJS(`(()=>{const i=[...document.querySelectorAll('.wx-page input,.wx-overlay input,#wx-overlay input')].find(e=>e.offsetParent!==null);if(i){const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'100');i.dispatchEvent(new Event('input',{bubbles:true}))}return !!i})()`); await sleep(500)
await tapText('确认提现'); await sleep(900); await tapText('确定'); await sleep(1200)
await shot('withdraw')
const wdAfter = arr((await jget('/worker/withdrawals', token)).data).length
await check('提现 withdraw (+1)', wdAfter > wdBefore)

// 3) 交付
evs = []
if (workingOrder) {
  await reLaunch('/pages/deliver/deliver?id=' + workingOrder.id); await sleep(1500)
  await evalJS(`(()=>{const ta=[...document.querySelectorAll('.wx-page textarea')].find(e=>e.offsetParent!==null);if(ta){const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(ta,'成果已完成并上传，含源文件与说明文档，请验收。');ta.dispatchEvent(new Event('input',{bubbles:true}))}return !!ta})()`); await sleep(400)
  await tapText('添加'); await sleep(800) // 必填：上传成果预览图
  const cnt1 = await evalJS("document.querySelectorAll('input[type=file]').length")
  const fi = await send('Runtime.evaluate', { expression: "document.querySelector('input[type=file]')" })
  let setRes = 'no-input'
  if (fi.result?.result?.objectId) { try { await send('DOM.setFileInputFiles', { files: [PNG], objectId: fi.result.result.objectId }); setRes = 'set' } catch (e) { setRes = 'err:' + e.message }; await sleep(3000) }
  const upst = await evalJS("(()=>{try{const p=getCurrentPages();const pg=p[p.length-1];return JSON.stringify((pg.data.uploads||[]).map(u=>({l:u.label,n:(u.files||[]).length})))}catch(e){return 'e:'+e.message}})()")
  console.log('  deliver diag: inputCount=' + cnt1.value + ' setFile=' + setRes + ' uploads=' + upst.value)
  await shot('deliver_form')
  await tapText('提交交付'); await sleep(800); await tapText('确定'); await sleep(400); await tapText('继续'); await sleep(1500)
  await shot('deliver')
  const od = arr((await jget('/worker/orders', token)).data).find(o => o.id === workingOrder.id)
  await check('交付 deliver', od && (od.status === 'delivered'))
} else { console.log('（无进行中订单，跳过交付）') }

ws.close(); chrome.kill()
const pass = results.filter(r => r.ok).length
console.log(`\n==== H5 写操作：${pass}/${results.length} 通过 ====`)
fs.writeFileSync(path.join(OUT, 'h5writes_report.json'), JSON.stringify(results, null, 2))
process.exit(0)
