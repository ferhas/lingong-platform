// E2E 写操作流（Chrome CDP）：企业端 发单→录用→验收、运营端 审核通过。
// 按 Element Plus 表单标签定位控件，逐步执行 + 截图 + 捕获 console.error/异常/API错误。
// 用法: node scripts/e2e-actions.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const API = (process.env.API_BASE || 'http://127.0.0.1:3000') + '/api/v1'
const CO = process.env.COMPANY_ORIGIN || CO+''
const AD = process.env.ADMIN_ORIGIN || AD+''
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9344
const OUT = path.resolve(process.cwd(), 'e2e-shots'); fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function login(phone, password) { const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) }); const d = await r.json(); if (!d.token) throw new Error('login ' + phone + ' ' + JSON.stringify(d)); return d }
const company = await login('13700000001', 'Company@123')
const admin = await login('13800000001', 'Admin@123456')

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-proxy-server', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/chrome-act-${Date.now()}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
async function getWs() { for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } catch {} await sleep(300) } throw new Error('no cdp') }
const ws = new WebSocket(await getWs()); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let msgId = 0; const pending = new Map(); let buf = []
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return } const p = m.params
  if (m.method === 'Runtime.exceptionThrown') buf.push({ t: 'exception', x: (p.exceptionDetails.exception && (p.exceptionDetails.exception.description || p.exceptionDetails.exception.value)) || p.exceptionDetails.text })
  else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') buf.push({ t: 'console.error', x: (p.args || []).map(a => a.value ?? a.description).join(' ') })
  else if (m.method === 'Network.responseReceived' && p.response.status >= 400 && /\/api\//.test(p.response.url)) buf.push({ t: 'http', x: p.response.status + ' ' + p.response.url.replace(/^https?:\/\/[^/]+/, '') }) }
const send = (method, params = {}) => { const id = ++msgId; return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJS = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }; return { value: r.result?.result?.value } }
const nav = async (url, s = 2600) => { await send('Page.navigate', { url }); await sleep(s) }
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable')
const report = []
async function shot(n) { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(OUT, 'act_' + n + '.png'), Buffer.from(s.result.data, 'base64')) }
const ONLY = (process.argv[2] || '').split(',').filter(Boolean)
async function step(name, fn) { if (ONLY.length && !ONLY.includes(name)) return; buf = []; let err = null; try { const r = await fn(); if (r?.error) err = r.error } catch (e) { err = e.message } await sleep(800)
  const probs = buf.filter(b => b.t === 'exception' || b.t === 'console.error' || b.t === 'http')
  const okFlag = (await evalJS(`!!document.querySelector('.el-message--success') || [...document.querySelectorAll('.el-dialog__title')].some(t=>/录用成功|结算单/.test(t.innerText||''))`)).value
  const errMsg = (await evalJS(`(document.querySelector('.el-message--error')?.innerText)||''`)).value
  await shot(name)
  const ok = !err && !probs.length && !errMsg
  report.push({ name, ok, okFlag, err, errMsg, probs })
  console.log(`${ok ? '✓' : '✗'} ${name}${okFlag ? ' [成功提示✓]' : ''}${err ? ' ERR:' + err : ''}${errMsg ? ' MSG:' + errMsg : ''}${probs.length ? ' ' + JSON.stringify(probs).slice(0, 200) : ''}`) }

// 注入登录态
async function setAuth(origin, kv) { await nav(origin + '/login', 1500); await evalJS(Object.entries(kv).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`).join(';')) }

// EP 表单辅助
const HELPERS = `
window.__lbl=(label)=>[...document.querySelectorAll('.el-form-item')].find(i=>i.querySelector('.el-form-item__label')?.textContent.includes(label));
window.__setInput=(label,val)=>{const it=window.__lbl(label);const el=it&&(it.querySelector('input,textarea'));if(!el)return {error:'no input '+label};const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return true};
window.__openSel=(label)=>{const it=window.__lbl(label);const s=it&&(it.querySelector('.el-select__wrapper')||it.querySelector('.el-select'));if(!s)return {error:'no select '+label};s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));s.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));s.click();return true};
window.__pickOpt=(text)=>{const dd=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.offsetParent!==null);const items=dd.flatMap(d=>[...d.querySelectorAll('.el-select-dropdown__item')]);const el=items.find(i=>i.textContent.trim().includes(text))||items[0];if(!el)return {error:'no option '+text};el.click();return true};
window.__clickText=(text,sel)=>{const els=[...document.querySelectorAll(sel||'button,.el-button,a,.el-radio-button')].filter(e=>e.offsetParent!==null&&e.textContent.includes(text));if(!els.length)return {error:'no text '+text};els.sort((a,b)=>a.textContent.trim().length-b.textContent.trim().length);els[0].click();return true};
window.__confirmDlg=()=>{const box=[...document.querySelectorAll('.el-message-box')].find(b=>b.offsetParent!==null);if(box){const b=box.querySelector('.el-button--primary');if(b){b.click();return true}}return false};
window.__setTA=(scope,val)=>{const ta=[...document.querySelectorAll(scope+' textarea')].find(e=>e.offsetParent!==null);if(!ta)return{error:'no ta '+scope};const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(ta,val);ta.dispatchEvent(new Event('input',{bubbles:true}));return true};
`
await evalJS(HELPERS) // 预热(导航后需重注)

// ===================== 企业端 =====================
await setAuth(CO+'', { token: company.token, user: JSON.stringify(company.user) })

// 1) 发布任务（表单）
await step('co_01_publish', async () => {
  await nav(CO+'/publish'); await evalJS(HELPERS)
  await evalJS(`window.__setInput('任务标题','UI自动化测试任务 主图设计10张')`)
  await evalJS(`window.__openSel('任务类目')`); await sleep(500); await evalJS(`window.__pickOpt('设计')`); await sleep(400)
  await evalJS(`window.__setInput('预算金额','1888')`); await sleep(400)
  const today = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
  await evalJS(`window.__setInput('截止日期',${JSON.stringify(today)})`); await sleep(300)
  await evalJS(`window.__setInput('任务描述','自动化测试：电商主图设计10张，提供PSD源文件，风格简洁明亮。')`)
  await evalJS(`window.__setInput('交付标准','尺寸800x800，提供PSD分层源文件，验收后结算。')`); await sleep(300)
  await evalJS(`window.__clickText('发布任务')`); await sleep(900)
  await evalJS(`window.__clickText('继续发布')`); await sleep(300) // ElMessageBox 确认
  return true
})

// 2) 录用（报名中任务 → 详情 → 录用）
await step('co_02_hire', async () => {
  await nav(CO+'/tasks'); await evalJS(HELPERS)
  await evalJS(`window.__clickText('报名中','.el-tabs__item,.el-radio-button,button')`); await sleep(800)
  await evalJS("(()=>{const a=[...document.querySelectorAll('a,.el-button')].filter(e=>e.offsetParent!==null&&/报名（[1-9]/.test(e.textContent));if(!a.length)return{error:'no task with applicants'};a[0].click();return true})()"); await sleep(1300) // 打开有报名者的任务详情
  const r = await evalJS(`window.__clickText('录用')`); await sleep(1000)
  await evalJS(`window.__clickText('继续录用')`); await sleep(1000)
  return r
})

// 3) 验收（待验收 → 验收 → 验收通过）
await step('co_03_accept', async () => {
  await nav(CO+'/tasks'); await evalJS(HELPERS)
  await evalJS(`window.__clickText('待验收','.el-tabs__item,.el-radio-button,button')`); await sleep(800)
  const r = await evalJS(`window.__clickText('验收')`); await sleep(1000)
  await evalJS(`window.__clickText('继续验收')`); await sleep(1200)
  return r
})

// ===================== 运营端 =====================
await setAuth(AD+'', { gigwork_admin_token: admin.token, gigwork_admin_user: JSON.stringify(admin.user) })

// 4) 审核通过待审企业
await step('admin_04_approve', async () => {
  await nav(AD+'/companies'); await evalJS(HELPERS)
  await evalJS(`window.__clickText('待审核','.el-tabs__item,.el-radio-button,button')`); await sleep(700)
  const r = await evalJS(`window.__clickText('通过')`); await sleep(900)
  // 弹窗可能要填审核意见
  await evalJS(`(()=>{const ta=[...document.querySelectorAll('.el-overlay textarea,.el-dialog textarea')].find(e=>e.offsetParent!==null);if(ta){const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(ta,'资质齐全，准入通过');ta.dispatchEvent(new Event('input',{bubbles:true}))}return true})()`); await sleep(300)
  await evalJS(`window.__clickText('确定')`); await sleep(300)
  await evalJS(`window.__clickText('确认')`); await sleep(300)
  return r
})

// 5) 争议裁决（仲裁举证 → 提交裁决 → 执行裁决）
await step('admin_05_dispute', async () => {
  await nav(AD+'/disputes'); await evalJS(HELPERS)
  await evalJS(`window.__clickText('仲裁举证','.el-radio-button,button')`); await sleep(800)
  const r = await evalJS(`window.__clickText('详情')`); await sleep(1300)
  await evalJS(`window.__setTA('.el-drawer','经核验交付物符合约定标准，裁决全额支付分包款，款项予以结算。')`); await sleep(300)
  await evalJS(`window.__clickText('提交裁决')`); await sleep(700); await evalJS(`window.__confirmDlg()`); await sleep(1300)
  await evalJS(`window.__clickText('执行裁决')`); await sleep(700); await evalJS(`window.__confirmDlg()`); await sleep(1300)
  return r
})

// 6) 税务批量申报缴款
await step('admin_06_tax', async () => {
  await nav(AD+'/tax'); await evalJS(HELPERS)
  const r = await evalJS(`window.__clickText('批量申报缴款')`); await sleep(700)
  await evalJS(`window.__confirmDlg()`); await sleep(1600)
  return r
})

ws.close(); chrome.kill()
fs.writeFileSync(path.join(OUT, 'actions_report.json'), JSON.stringify(report, null, 2))
const pass = report.filter(r => r.ok).length
console.log(`\n==== 动作流：${pass}/${report.length} 步无错误 ====`)
process.exit(0)
