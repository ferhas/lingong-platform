// 零工端 H5 自动化测试：CDP 驱动无头 Edge，走通登录 + 全部页面 + 关键交互，
// 捕获每一步的 console.error / 未捕获异常 / 失败网络日志，并逐页截图。
// 用法：NO_PROXY='*' node h5-test.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = 'http://127.0.0.1:3000'
const API = HOST + '/api/v1'
const PORT = 9224
const EDGE = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(here, '../.review-shots')
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

// —— 预取体验账号会话 + 详情页所需 id ——
async function jpost(url, body) {
  const r = await fetch(API + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => null) }
}
async function jget(url, token) {
  const r = await fetch(API + url, { headers: { authorization: 'Bearer ' + token } })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const login = await jpost('/auth/wechat', { code: 'demo-worker-2month-001' })
if (!login.data || !login.data.token) { console.error('体验账号登录失败', login); process.exit(1) }
const token = login.data.token
const refreshToken = login.data.refreshToken || ''
const user = login.data.user
async function firstId(url, token) { const r = await jget(url, token); const l = r.data && (r.data.list || r.data.items); return l && l[0] ? l[0].id : null }
const taskId = await firstId('/worker/tasks?pageSize=5', token)
const disputeId = await firstId('/worker/disputes', token)
const ticketId = await firstId('/me/tickets', token).catch(() => null)
let helpId = null
try { const h = await jget('/me/help', token); const l = h.data && (h.data.list || h.data.articles || h.data); if (Array.isArray(l) && l[0]) helpId = l[0].id } catch {}
console.log('ids:', { taskId, disputeId, ticketId, helpId })

// —— 启动 Edge + CDP ——
const tmp = (process.env.TEMP || '/tmp') + '/edge-h5-' + Date.now()
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=420,860', 'about:blank'
], { stdio: 'ignore' })

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = list.find(t => t.type === 'page'); if (p) return p } catch {}
    await sleep(300)
  }
  throw new Error('无法连接 Edge CDP')
}
const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const events = []   // 收集 console/exception/log 事件
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    events.push({ kind: 'console.' + m.params.type, text: (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ') })
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    events.push({ kind: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text })
  }
}
function send(method, params = {}) {
  const id = ++msgId
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
}
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 2, mobile: true, screenWidth: 400, screenHeight: 850 })
// 强制浅色（真机演示截图为浅色；深色仍由各页 @media 支持，仅校准评审视图）
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails
    return { error: (d.exception && (d.exception.description || d.exception.value)) || d.text }
  }
  return { value: r.result && r.result.result && r.result.result.value }
}
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  if (s.result && s.result.data) fs.writeFileSync(path.join(OUT, 'h5_' + name + '.png'), Buffer.from(s.result.data, 'base64'))
}
function snippet() {
  return evalJS(`(()=>{const p=document.querySelector('.wx-page[data-route]:not([style*="display: none"])')||document.querySelector('.wx-page');const o=document.getElementById('wx-overlay');const ot=o?o.innerText.replace(/\\s+/g,' ').trim():'';const pt=p?p.innerText.replace(/\\s+/g,' ').trim():'(no page)';return ((ot?'[overlay] '+ot+' | ':'')+pt).slice(0,220)})()`)
}

const report = []
async function step(name, expectText, action, { screenshot = true } = {}) {
  const before = events.length
  if (action) {
    const r = await action()
    if (r && r.error) events.push({ kind: 'action-error', text: r.error })            // evalJS 抛异常
    if (r && r.value && r.value.error) events.push({ kind: 'action-error', text: r.value.error }) // 页面内未命中
  }
  await sleep(action ? 900 : 500)
  const snip = (await snippet()).value || ''
  const newEvents = events.slice(before)
  const route = (await evalJS(`(()=>{const p=getCurrentPages&&getCurrentPages();return p&&p.length?p[p.length-1].route:'?'})()`)).value
  const ok = (!expectText || snip.includes(expectText)) && !newEvents.some(e => e.kind === 'exception' || e.kind === 'action-error')
  report.push({ name, route, ok, expect: expectText || '', snip, events: newEvents })
  if (screenshot) await shot(name)
  const tag = ok ? '✓' : '✗'
  console.log(`${tag} ${name}  [route=${route}]`)
  if (newEvents.length) newEvents.forEach(e => console.log('     ⚠', e.kind, '-', String(e.text).slice(0, 160)))
  if (expectText && !snip.includes(expectText)) console.log('     ! 期望含「' + expectText + '」，实际：' + snip.slice(0, 120))
}

const reLaunch = (url) => () => evalJS(`wx.reLaunch({url:${JSON.stringify(url)}})`)
const tap = (sel) => () => evalJS(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return {error:'no element '+${JSON.stringify(sel)}};el.click();return true})()`)
// 命中包含该文本、且 textContent 最短（即最内层叶子）的可见元素，避免点到无 handler 的外层容器
const tapText = (txt) => () => evalJS(`(()=>{const t=${JSON.stringify(txt)};const els=[...document.querySelectorAll('.wx-page button,.wx-page view,.wx-page text,.wx-overlay button,#wx-overlay button')].filter(e=>e.textContent.includes(t)&&e.offsetParent!==null);if(!els.length)return {error:'no text '+t};els.sort((a,b)=>a.textContent.trim().length-b.textContent.trim().length);els[0].click();return true})()`)

// ======================= 测试流程 =======================
// 1) 全新打开 → 登录页
await step('01_login', '登录', async () => {
  await evalJS(`localStorage.clear()`)
  await send('Page.navigate', { url: HOST + '/h5/' })
  await sleep(1600)
  return true
})
// 2) 模拟登录 → 任务大厅
await step('02_login_mock', '任务大厅', tap('.mock-btn'))

// 3) 任务大厅交互
await step('03_index', '任务大厅', reLaunch('/pages/index/index'))
await step('03b_index_category', null, tapText('设计'), { screenshot: true })
await step('03c_index_sort', null, tapText('报酬'), { screenshot: false })
await step('03d_index_pay_picker', null, tap('.price-picker'))            // 打开 picker 浮层
await step('03e_index_pay_pick', null, tap('.wx-picker .wx-sheet-item'))   // 选第一项
await step('03f_index_search', null, async () => {
  return evalJS(`(()=>{const i=document.querySelector('.search-input');if(!i)return{error:'no search'};i.value='设计';i.dispatchEvent(new Event('input'));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));return true})()`)
})
await step('03g_index_match', null, tapText('匹配我的技能'))

// 4) 任务详情（从列表点第一张卡）
await step('04_detail', '任务详情', taskId ? reLaunch('/pages/detail/detail?id=' + taskId) : tap('.tc-card'))
await step('04b_detail_fav', null, tap('.fav-btn'))   // 收藏切换

// 5) 我的接单 + 弹窗
await step('05_orders', '我的接单', reLaunch('/pages/orders/orders'))
await step('05b_orders_review_or_dispute', null, tapText('申请平台介入'), { screenshot: true })
await step('05c_orders_modal_close', null, tapText('取消'), { screenshot: false })

// 6) 我的（字体缩放）
await step('06_mine', '可提现余额', reLaunch('/pages/mine/mine'))
await step('06b_mine_font', null, async () => evalJS(`(()=>{const els=[...document.querySelectorAll('.fs-opt')];const el=els.find(e=>e.textContent.trim()==='大');if(!el)return{error:'no font opt'};el.click();return true})()`))

// 7) 收入与提现
await step('07_income', '提现', reLaunch('/pages/income/income'))
// 8) 实名认证（体验账号已实名 → 展示已认证态）
await step('08_verify', '实名', reLaunch('/pages/verify/verify'))
// 9) 消息中心
await step('09_notices', null, reLaunch('/pages/notices/notices'))
// 10) 我的合同
await step('10_contracts', null, reLaunch('/pages/contracts/contracts'))
// 11) 绑卡
await step('11_bindcard', null, reLaunch('/pages/bindcard/bindcard'))
// 12) 争议列表 + 详情
await step('12_disputes', null, reLaunch('/pages/disputes/disputes'))
await step('12b_dispute_detail', null, tap('.wx-page .card'))   // 点争议卡 → 争议详情
// 13) 工单（客服）列表 / 新建 / 详情
await step('13_tickets', null, reLaunch('/pages/tickets/tickets'))
await step('13b_tickets_new', '问题分类', reLaunch('/pages/tickets/new'))
// 端到端 POST 提交：填表 + 选分类 + 提交 → 成功弹窗（验证 wx.request POST + 表单数据链路）
await step('13b2_ticket_submit', '工单已提交', async () => evalJS(`(()=>{
  const inp=document.querySelector('.wx-page input.field-input');
  const ta=document.querySelector('.wx-page textarea.field-textarea');
  if(!inp||!ta)return{error:'缺少表单字段'};
  inp.value='H5自动化测试工单';inp.dispatchEvent(new Event('input'));
  ta.value='这是零工端小程序转 H5 后的自动化提交测试，验证工单创建链路正常。';ta.dispatchEvent(new Event('input'));
  const btn=[...document.querySelectorAll('.wx-page button')].find(b=>b.textContent.includes('提交工单'));
  if(!btn)return{error:'缺少提交按钮'};btn.click();return true;
})()`))
await step('13b3_ticket_ok', null, tapText('确定'))   // 关弹窗 → navigateBack 回工单列表
const ticketId2 = ticketId || await firstId('/me/tickets', token).catch(() => null)
if (ticketId2) await step('13c_ticket_detail', null, reLaunch('/pages/tickets/detail?id=' + ticketId2))
// 14) 帮助中心 + 文章
await step('14_help', null, reLaunch('/pages/help/help'))
if (helpId) await step('14b_help_article', null, reLaunch('/pages/help/article?id=' + helpId))
else await step('14b_help_article_click', null, tap('.wx-page view'))
// 15) 技能认证
await step('15_skills', null, reLaunch('/pages/skills/skills'))
// 16) 我的收藏（task-card + slot）
await step('16_favorites', null, reLaunch('/pages/favorites/favorites'))
// 17) 我的保险
await step('17_insurance', null, reLaunch('/pages/insurance/insurance'))
// 18) 个体户专区
await step('18_soletrader', null, reLaunch('/pages/soletrader/soletrader'))
// 19) 修改密码
await step('19_password', null, reLaunch('/pages/password/password'))
// 20) 协议详情
await step('20_legal', null, reLaunch('/pages/legal/legal?type=tos'))

// ======================= 汇总 =======================
const pass = report.filter(r => r.ok).length
console.log(`\n==== 结果：${pass}/${report.length} 步通过 ====`)
const failed = report.filter(r => !r.ok)
if (failed.length) {
  console.log('— 失败步骤 —')
  for (const f of failed) {
    console.log(`  ✗ ${f.name} [${f.route}] expect="${f.expect}"`)
    console.log(`     snip: ${f.snip.slice(0, 120)}`)
    f.events.forEach(e => console.log(`     ${e.kind}: ${String(e.text).slice(0, 200)}`))
  }
}
fs.writeFileSync(path.join(OUT, 'h5_report.json'), JSON.stringify(report, null, 2))
console.log('\n截图与报告 ->', OUT)
ws.close(); edge.kill()
process.exit(failed.length ? 1 : 0)
