// ============================================================================
// 规模化体验数据生成器（bigSeed）：直写库 + 回填 90 天时间戳，造出"运行约三个月、50+ 用户"的平台级数据。
// 模式同 demoSeed：复用真实算税引擎(累计预扣)、账户流水回放(账务自洽)、电子合同/保单/发票齐全。
// 用法：cd platform/server && node src/bigSeed.js   （生产环境拒绝执行；建议服务器停机时运行）
// 幂等：清理上轮 bigSeed 数据（企业 phone LIKE '181000000%'、零工 phone LIKE '152000000%'），不动 admin / acceptance / demo 数据。
// ============================================================================
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import db from './db.js'
import { getConfig } from './services/configStore.js'
import { renderContract, recordAgreements } from './services/contractText.js'
import * as taxEngine from './services/taxEngine.js'
import { mulRate, centsToYuan } from './utils/money.js'

if (process.env.NODE_ENV === 'production') { console.error('[bigSeed] 生产环境禁止生成体验数据，已中止。'); process.exit(1) }
db.pragma('busy_timeout = 15000')

const NOW = new Date(), DAY = 86400000
const pad = n => String(n).padStart(2, '0')
const dayAgo = (n, h = 10, m = 0) => { const d = new Date(NOW.getTime() - n * DAY); d.setHours(h, m, Math.floor((n * 7) % 60), 0); return d }
const dayAhead = n => new Date(NOW.getTime() + n * DAY)
const fmtDT = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const fmtD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fmtP = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
let SEQ = 500000
const bizNo = (p, d = NOW) => `${p}${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${SEQ++}`
const yuan = y => Math.round(y * 100)
const MARGIN_RATE = getConfig('platformMarginRate')
const subOf = c => mulRate(c, 1 - MARGIN_RATE)
const OFFLINE = getConfig('offlineCategories')
const CONT = getConfig('continuousLaborCategories')
const insFor = cat => { const off = OFFLINE.includes(cat); return { plan: off ? '高保额方案' : '基础方案', premium: (off ? getConfig('insurancePremiumHigh') : getConfig('insurancePremiumBase')) * 100 } }
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
function insert(table, obj) { const k = Object.keys(obj); return db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => obj[x])).lastInsertRowid }
const hashOf = o => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex')
const insertFlow = (accId, type, amt, bal, rt, rid, remark, t) => insert('fund_flows', { account_id: accId, type, amount: amt, balance_after: bal, ref_type: rt, ref_id: rid, remark, created_at: fmtDT(t instanceof Date ? t : new Date(t)) })
const pickPay = c => (['视频'].includes(c) ? '按件' : ['配送', '安装', '施工'].includes(c) ? '按单' : '按成果')
const descOf = (t, c) => `${t}。${c}类承揽任务，按交付标准完成并提供源文件/成果；工具自备、时间自主、不接受考勤，成果不合格不计酬。`

// —— 清理上轮 ——
function cleanup() {
  const userIds = db.prepare(`SELECT id FROM users WHERE phone LIKE '181000000%' OR phone LIKE '152000000%'`).all().map(r => r.id)
  if (!userIds.length) return
  const L = ids => ids.length ? `(${ids.join(',')})` : '(0)'
  const companyIds = db.prepare(`SELECT id FROM companies WHERE user_id IN ${L(userIds)}`).all().map(r => r.id)
  const taskIds = db.prepare(`SELECT id FROM tasks WHERE company_id IN ${L(companyIds)} OR worker_id IN ${L(userIds)}`).all().map(r => r.id)
  const accountIds = db.prepare(`SELECT id FROM accounts WHERE (owner_type='company' AND owner_id IN ${L(companyIds)}) OR (owner_type='worker' AND owner_id IN ${L(userIds)})`).all().map(r => r.id)
  const disputeIds = db.prepare(`SELECT id FROM disputes WHERE task_id IN ${L(taskIds)}`).all().map(r => r.id)
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    const run = s => db.prepare(s).run()
    run(`DELETE FROM dispute_events WHERE dispute_id IN ${L(disputeIds)}`)
    run(`DELETE FROM disputes WHERE id IN ${L(disputeIds)}`)
    run(`DELETE FROM task_attachments WHERE task_id IN ${L(taskIds)}`)
    run(`DELETE FROM applications WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM dispatches WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM contracts WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)} OR company_id IN ${L(companyIds)}`)
    run(`DELETE FROM invoices WHERE task_id IN ${L(taskIds)}`)
    run(`DELETE FROM tax_records WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM insurance_policies WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM settlements WHERE task_id IN ${L(taskIds)}`)
    run(`DELETE FROM claims WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM reviews WHERE task_id IN ${L(taskIds)} OR reviewer_id IN ${L(userIds)} OR reviewee_id IN ${L(userIds)}`)
    run(`DELETE FROM input_invoices WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM task_favorites WHERE task_id IN ${L(taskIds)} OR worker_id IN ${L(userIds)}`)
    run(`DELETE FROM callbacks WHERE task_id IN ${L(taskIds)}`)
    run(`DELETE FROM withdrawals WHERE worker_id IN ${L(userIds)}`)
    run(`DELETE FROM worker_skills WHERE worker_id IN ${L(userIds)}`)
    run(`DELETE FROM worker_secrets WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM notifications WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM agreements WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM user_settings WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM login_logs WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM refresh_tokens WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM audit_logs WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM message_logs WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id IN ${L(userIds)})`)
    run(`DELETE FROM tickets WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM recharge_orders WHERE company_id IN ${L(companyIds)}`)
    run(`DELETE FROM api_credentials WHERE company_id IN ${L(companyIds)}`)
    run(`DELETE FROM payroll_names WHERE company_id IN ${L(companyIds)}`)
    run(`DELETE FROM company_members WHERE user_id IN ${L(userIds)} OR company_id IN ${L(companyIds)}`)
    run(`DELETE FROM worker_profiles WHERE user_id IN ${L(userIds)}`)
    run(`DELETE FROM escrow_members WHERE (owner_type='company' AND owner_id IN ${L(companyIds)}) OR (owner_type='worker' AND owner_id IN ${L(userIds)})`)
    run(`DELETE FROM fund_flows WHERE account_id IN ${L(accountIds)}`)
    run(`DELETE FROM accounts WHERE id IN ${L(accountIds)}`)
    run(`DELETE FROM tasks WHERE id IN ${L(taskIds)}`)
    run(`DELETE FROM companies WHERE id IN ${L(companyIds)}`)
    db.prepare(`DELETE FROM login_attempts WHERE phone LIKE '181000000%' OR phone LIKE '152000000%'`).run()
    run(`DELETE FROM users WHERE id IN ${L(userIds)}`)
  })()
  db.pragma('foreign_keys = ON')
  console.log(`[bigSeed] 已清理上轮：${userIds.length} 账号`)
}

// —— 数据池 ——
const CITIES = ['南宁', '柳州', '桂林', '玉林', '北海', '钦州', '梧州', '贵港']
const CO_NAMES = ['云栖电商科技', '数擎信息技术', '极光文化传媒', '知行教育咨询', '优鲜供应链管理', '邕创设计顾问', '海丝跨境电商', '智汇人力资源', '星河数字营销', '匠心软件开发', '绿野生鲜配送', '博远会展服务']
const INDUS = ['电商零售', '互联网技术', '文化传媒', '教育咨询', '供应链', '设计服务', '跨境电商', '人力资源', '数字营销', '软件开发', '生鲜配送', '会展服务']
const SURNAME = '王李张刘陈杨黄赵周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢'.split('')
const GIVEN = ['伟', '芳', '娜', '敏', '静', '强', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '霞', '平', '刚', '桂英', '建国', '晓燕', '志远', '雪松', '海燕', '丽娟', '문浩', '思远', '梓涵', '一鸣']
const CATS = ['设计', '翻译', '文案', '视频', '技术', '安装', '配送', '施工']
const PRICE = { 设计: [800, 4500], 翻译: [700, 2600], 文案: [700, 2000], 视频: [1200, 6800], 技术: [2000, 9000], 安装: [500, 1200], 配送: [400, 900], 施工: [1500, 3000] }
const cityFor = cat => (OFFLINE.includes(cat) || ['配送', '施工'].includes(cat)) ? pick(CITIES) : '远程'
const randPrice = cat => { const [a, b] = PRICE[cat]; return Math.round((a + Math.random() * (b - a)) / 100) * 100 }
const TITLE_TPL = { 设计: ['电商主图设计', '品牌VI规范设计', 'Banner设计', '海报设计', 'UI界面设计', '宣传册排版'], 翻译: ['英文手册翻译', '日语邮件翻译', '商务合同翻译', '技术文档翻译'], 文案: ['公众号推文撰写', '种草文案撰写', '直播脚本撰写', '品牌故事文案'], 视频: ['短视频剪辑', '产品三维动画', '宣传片剪辑', '课程剪辑'], 技术: ['小程序前端开发', 'H5活动页开发', '官网改版开发', '后端接口开发'], 安装: ['自助设备安装调试', '门店设备巡检'], 配送: ['生鲜配送排线', '同城即时配送'], 施工: ['活动物料搭建', '展位施工'] }
const titleFor = cat => `${pick(TITLE_TPL[cat])}（${rnd(3, 30)}${cat === '视频' ? '条' : cat === '设计' ? '张' : '项'}）`

cleanup()
const passHash = bcrypt.hashSync('Demo@123456', 8)
const companyEvents = [], creditsByWorker = new Map()
const companyRows = [], workerRows = []

db.transaction(() => {
  // —— 企业 ——
  CO_NAMES.forEach((nm, i) => {
    const phone = '181000000' + pad(i + 1).slice(-2)
    const createdAt = fmtDT(dayAgo(rnd(70, 89), 9))
    const city = CITIES[i % CITIES.length]
    const approved = i !== 11 // 最后一家保持待审核
    const userId = insert('users', { role: 'company', phone, password_hash: passHash, name: pick(SURNAME) + '经理', status: 'active', created_at: createdAt })
    const companyId = insert('companies', {
      user_id: userId, company_name: `${city}${nm}有限公司`, license_no: '91' + rnd(450100, 450900) + 'MA' + crypto.randomBytes(3).toString('hex').toUpperCase() + rnd(10, 99),
      industry: INDUS[i], contact_phone: phone, contact_email: `hr${i + 1}@demo181.com`, risk_level: '低', risk_note: '',
      status: approved ? 'approved' : 'pending', review_note: approved ? '资质齐全，准入通过' : '', master_contract_no: approved ? bizNo('ZCL', dayAgo(70)) : null,
      invite_code: 'INV18' + pad(i + 1), esign_authorized: approved ? 1 : 0, esign_auth_at: approved ? createdAt : null, created_at: createdAt
    })
    insert('company_members', { user_id: userId, company_id: companyId, member_role: 'owner', created_at: createdAt })
    const accId = insert('accounts', { owner_type: 'company', owner_id: companyId, balance: 0, frozen: 0 })
    if (approved) insert('escrow_members', { owner_type: 'company', owner_id: companyId, member_no: bizNo('EMC', dayAgo(70)), sub_acct_no: '6650' + String(100000 + companyId), status: 'opened', created_at: createdAt })
    recordAgreements(userId)
    companyRows.push({ id: companyId, userId, name: `${city}${nm}有限公司`, accId, approved })
  })
  const approvedCos = companyRows.filter(c => c.approved)

  // —— 零工 ——
  const usedNames = new Set()
  for (let i = 0; i < 48; i++) {
    let name; do { name = pick(SURNAME) + pick(GIVEN) } while (usedNames.has(name)); usedNames.add(name)
    const phone = '152000000' + pad(i + 1).slice(-2)
    const regDaysAgo = rnd(5, 88)
    const createdAt = fmtDT(dayAgo(regDaysAgo, 9))
    const kind = i < 40 ? 'person' : i < 45 ? 'sole_trader' : 'unverified'
    const userId = insert('users', { role: 'worker', phone, password_hash: passHash, name, status: 'active', created_at: createdAt })
    if (kind !== 'unverified') {
      const frameNo = bizNo('FBK', dayAgo(regDaysAgo))
      insert('worker_profiles', {
        user_id: userId, verified: 1, real_name: name, id_card_masked: '4501**********' + rnd(1000, 9999), bank_card_masked: '6217 **** **** ' + rnd(1000, 9999),
        subject_type: kind === 'sole_trader' ? 'soletrader' : 'person', frame_contract_no: frameNo, locked: 0, verified_at: fmtDT(dayAgo(regDaysAgo, 11)),
        credit_score: rnd(580, 790), face_verified: 1
      })
      insert('contracts', { type: 'frame_sub', no: frameNo, party_a: '平台', party_b: name, worker_id: userId, content_hash: hashOf({ frameNo, userId }), esign_id: 'ESIGN' + SEQ++, content: renderContract('frame_sub', { partyB: name, contractNo: frameNo, date: fmtD(dayAgo(regDaysAgo)), hash: 'big' }), signed_at: fmtDT(dayAgo(regDaysAgo, 11)) })
      insert('escrow_members', { owner_type: 'worker', owner_id: userId, member_no: bizNo('EMW', dayAgo(regDaysAgo)), sub_acct_no: '6650' + String(900000 + userId), bind_card_token: 'BCT' + crypto.randomBytes(5).toString('hex'), card_masked: '6217 **** **** ' + rnd(1000, 9999), status: 'card_bound', created_at: fmtDT(dayAgo(regDaysAgo, 12)) })
    } else {
      insert('worker_profiles', { user_id: userId, verified: 0, subject_type: 'person', locked: 0, credit_score: 600 })
    }
    recordAgreements(userId)
    workerRows.push({ id: userId, name, kind, regDaysAgo, accId: insert('accounts', { owner_type: 'worker', owner_id: userId, balance: 0, frozen: 0 }) })
  }
  const personWorkers = workerRows.filter(w => w.kind === 'person')

  // —— 任务工厂 ——
  function makeTask({ title, category, city, priceYuan, status, createdAt, deadline, company, workerId = null }) {
    const price = yuan(priceYuan), sub = subOf(price), no = bizNo('GD', new Date(createdAt))
    const taskId = insert('tasks', { company_id: company.id, title, category, trade: null, city, pay_method: pickPay(category), price, sub_price: sub, deadline, description: descOf(title, category), standard: '按交付标准验收，成果不合格不计酬；验收通过后由存管银行结算。', status, worker_id: workerId, task_order_no: no, created_at: createdAt })
    insert('contracts', { type: 'work_order', no, party_a: company.name, party_b: '平台', company_id: company.id, task_id: taskId, content_hash: hashOf({ no, title, price }), esign_id: 'ESIGN' + SEQ++, content: renderContract('work_order', { partyA: company.name, contractNo: no, date: fmtD(new Date(createdAt)), taskTitle: title, category, payMethod: pickPay(category), price: priceYuan.toFixed(2), deadline, standard: '见任务描述', hash: 'big' }), signed_at: createdAt })
    companyEvents.push({ accId: company.accId, time: new Date(createdAt), type: 'freeze', amount: price, taskId, remark: `发布任务冻结：${title}` })
    return { taskId, price, sub }
  }
  function hire({ taskId, sub, company, worker, hiredAt, category, source = 'apply' }) {
    const subNo = bizNo('FB', new Date(hiredAt)), ins = insFor(category), policyNo = bizNo('BD', new Date(hiredAt))
    db.prepare(`UPDATE tasks SET sub_order_no=?, policy_no=? WHERE id=?`).run(subNo, policyNo, taskId)
    insert('contracts', { type: 'sub_order', no: subNo, party_a: '平台', party_b: worker.name, company_id: company.id, worker_id: worker.id, task_id: taskId, content_hash: hashOf({ subNo, taskId, sub }), esign_id: 'ESIGN' + SEQ++, content: renderContract('sub_order', { partyB: worker.name, contractNo: subNo, date: fmtD(new Date(hiredAt)), taskTitle: db.prepare(`SELECT title FROM tasks WHERE id=?`).get(taskId).title, payMethod: '按成果', subPrice: centsToYuan(sub).toFixed(2), policyNo, hash: 'big' }), signed_at: hiredAt })
    insert('insurance_policies', { policy_no: policyNo, task_id: taskId, worker_id: worker.id, plan: ins.plan, premium: ins.premium, status: 'active', created_at: hiredAt })
    insert('applications', { task_id: taskId, worker_id: worker.id, status: 'hired', source, created_at: fmtDT(new Date(new Date(hiredAt).getTime() - DAY)) })
    return { policyNo }
  }

  // —— 为每个 person 零工排定结算订单（按时间早→晚，保证累计预扣口径）——
  const settledInfos = []
  personWorkers.forEach(w => {
    const count = pick([0, 1, 1, 2, 2, 3, 3, 4, 5, 6])
    const days = []
    for (let k = 0; k < count; k++) days.push(rnd(3, Math.max(4, w.regDaysAgo - 2)))
    days.sort((a, b) => b - a) // 早→晚
    days.forEach((settledDaysAgo, order) => {
      const category = pick(CATS), city = cityFor(category), priceYuan = randPrice(category)
      const company = pick(approvedCos)
      const createdAt = fmtDT(dayAgo(settledDaysAgo + 7, 10)), hiredAt = fmtDT(dayAgo(settledDaysAgo + 6, 15))
      const deliveredAt = fmtDT(dayAgo(settledDaysAgo + 2, 16)), settledDate = dayAgo(settledDaysAgo, 11), settledAt = fmtDT(settledDate)
      const { taskId, price, sub } = makeTask({ title: titleFor(category), category, city, priceYuan, status: 'settled', createdAt, deadline: fmtD(dayAgo(settledDaysAgo + 1)), company, workerId: w.id })
      const { policyNo } = hire({ taskId, sub, company, worker: w, hiredAt, category })
      db.prepare(`UPDATE tasks SET deliverable=?, delivered_at=? WHERE id=?`).run('成品已交付（含源文件/网盘链接）', deliveredAt, taskId)
      const period = fmtP(settledDate)
      const { tax, vat } = taxEngine.calcWithholding(w.id, sub, period)
      const months = db.prepare(`SELECT COUNT(DISTINCT period) n FROM tax_records WHERE worker_id=? AND period<=?`).get(w.id, period).n + 1
      const net = sub - tax - vat, confirmNo = bizNo('QR', settledDate), invoiceNo = bizNo('FP', settledDate), voucherNo = tax > 0 ? bizNo('TAX', settledDate) : null
      const incomeType = CONT.includes(category) ? 'labor_continuous' : 'labor_other'
      insert('settlements', { task_id: taskId, confirm_no: confirmNo, worker_id: w.id, company_id: company.id, gross: sub, tax, vat, net, margin: price - sub, method: 'cumulative', income_type: incomeType, consecutive_months: months, tax_voucher_no: voucherNo, invoice_no: invoiceNo, legs_done: JSON.stringify(['net', 'tax', 'margin', 'invoice']), status: 'done', attempts: 0, created_at: settledAt, done_at: settledAt })
      insert('tax_records', { worker_id: w.id, task_id: taskId, company_id: company.id, gross: sub, tax, vat, net, method: 'cumulative', income_type: incomeType, consecutive_months: months, period, tax_voucher_no: voucherNo, created_at: settledAt })
      insert('invoices', { no: invoiceNo, company_id: company.id, task_id: taskId, amount: price, tax_rate: getConfig('outputVatRate'), item: '*现代服务*灵活用工服务费', confirm_no: confirmNo, status: 'issued', issued_at: settledAt })
      db.prepare(`UPDATE tasks SET confirm_no=?, settled_at=? WHERE id=?`).run(confirmNo, settledAt, taskId)
      companyEvents.push({ accId: company.accId, time: settledDate, type: 'settle_out', amount: price, taskId, remark: `验收结算：${db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId).title}` })
      if (!creditsByWorker.has(w.id)) creditsByWorker.set(w.id, [])
      creditsByWorker.get(w.id).push({ time: settledDate, amt: net, taskId })
      if (order % 3 !== 2) insert('reviews', { task_id: taskId, reviewer_role: 'company', reviewer_id: company.userId, reviewee_id: w.id, score: rnd(4, 5), tags: JSON.stringify(['按时交付', '质量过硬']), comment: '交付质量高，沟通顺畅。', created_at: fmtDT(dayAgo(Math.max(0, settledDaysAgo - 1), 9)) })
      settledInfos.push({ taskId, category, settledDaysAgo, company, worker: w, policyNo })
    })
  })

  // —— 进行中 / 待验收 / 招募中 ——
  for (let i = 0; i < 16; i++) { const w = pick(personWorkers), company = pick(approvedCos), cat = pick(CATS), h = rnd(1, 6); const { taskId, sub } = makeTask({ title: titleFor(cat), category: cat, city: cityFor(cat), priceYuan: randPrice(cat), status: 'working', createdAt: fmtDT(dayAgo(h + 2, 10)), deadline: fmtD(dayAhead(rnd(4, 15))), company, workerId: w.id }); hire({ taskId, sub, company, worker: w, hiredAt: fmtDT(dayAgo(h, 15)), category: cat }) }
  for (let i = 0; i < 12; i++) { const w = pick(personWorkers), company = pick(approvedCos), cat = pick(CATS), h = rnd(2, 8); const { taskId, sub } = makeTask({ title: titleFor(cat), category: cat, city: cityFor(cat), priceYuan: randPrice(cat), status: 'delivered', createdAt: fmtDT(dayAgo(h + 2, 10)), deadline: fmtD(dayAhead(rnd(2, 6))), company, workerId: w.id }); hire({ taskId, sub, company, worker: w, hiredAt: fmtDT(dayAgo(h, 15)), category: cat }); db.prepare(`UPDATE tasks SET deliverable=?, delivered_at=? WHERE id=?`).run('首版已交付，待企业验收。', fmtDT(dayAgo(rnd(1, 3), 16)), taskId) }
  const applicants = workerRows.filter(w => w.kind !== 'unverified')
  for (let i = 0; i < 30; i++) { const company = pick(approvedCos), cat = pick(CATS); const { taskId } = makeTask({ title: titleFor(cat), category: cat, city: cityFor(cat), priceYuan: randPrice(cat), status: 'recruiting', createdAt: fmtDT(dayAgo(rnd(1, 38), 9 + (i % 8))), deadline: fmtD(dayAhead(rnd(5, 30))), company }); const n = rnd(1, 5); const seen = new Set(); for (let k = 0; k < n; k++) { const a = pick(applicants); if (seen.has(a.id)) continue; seen.add(a.id); insert('applications', { task_id: taskId, worker_id: a.id, status: 'applied', source: 'apply', created_at: fmtDT(dayAgo(rnd(1, 20), 14)) }) } }

  // —— 提现（按到账余额，留缓冲）+ 账户流水回放 ——
  workerRows.forEach(w => {
    const credits = (creditsByWorker.get(w.id) || []).sort((a, b) => a.time - b.time)
    const events = credits.map(c => ({ time: c.time, kind: 'credit', amt: c.amt, refId: c.taskId, remark: '分包款入账' }))
    const totalNet = credits.reduce((s, c) => s + c.amt, 0)
    if (totalNet > 50000 && Math.random() < 0.85) {
      const member = db.prepare(`SELECT member_no, card_masked FROM escrow_members WHERE owner_type='worker' AND owner_id=?`).get(w.id)
      let pool = totalNet - 30000, lastCreditDaysAgo = Math.min(...credits.map(c => Math.round((NOW - c.time) / DAY)))
      const tranches = rnd(1, 3)
      for (let t = 0; t < tranches && pool > 30000; t++) {
        const amt = Math.floor((pool * (t === tranches - 1 ? 1 : 0.5)) / 10000) * 10000
        if (amt < 20000) break
        const applyDaysAgo = Math.max(1, lastCreditDaysAgo - rnd(0, 3) - t * rnd(3, 8))
        const applyT = dayAgo(applyDaysAgo, 14)
        const done = applyDaysAgo > 2 || Math.random() < 0.6
        if (done) {
          const wid = insert('withdrawals', { worker_id: w.id, amount: amt, bank_card: member.card_masked, status: 'done', escrow_txn_no: bizNo('ETX', applyT), member_no: member.member_no, created_at: fmtDT(applyT), done_at: fmtDT(dayAgo(applyDaysAgo - 1, 16)) })
          events.push({ time: applyT, kind: 'wd_freeze', amt, refId: wid, remark: `提现申请冻结 WD${wid}` })
          events.push({ time: dayAgo(applyDaysAgo - 1, 16), kind: 'wd_pay', amt, refId: wid, remark: `提现出金 WD${wid}` })
        } else {
          const wid = insert('withdrawals', { worker_id: w.id, amount: amt, bank_card: member.card_masked, status: 'applied', member_no: member.member_no, created_at: fmtDT(applyT) })
          events.push({ time: applyT, kind: 'wd_freeze', amt, refId: wid, remark: `提现申请冻结 WD${wid}` })
        }
        pool -= amt
      }
    }
    events.sort((a, b) => a.time - b.time)
    let bal = 0, frozen = 0
    for (const e of events) {
      if (e.kind === 'credit') { bal += e.amt; insertFlow(w.accId, 'settle_in', e.amt, bal, 'task', e.refId, e.remark, e.time) }
      else if (e.kind === 'wd_freeze') { frozen += e.amt; insertFlow(w.accId, 'freeze', e.amt, bal, 'withdrawal', e.refId, e.remark, e.time) }
      else if (e.kind === 'wd_pay') { bal -= e.amt; frozen -= e.amt; insertFlow(w.accId, 'withdraw', e.amt, bal, 'withdrawal', e.refId, e.remark, e.time) }
    }
    db.prepare(`UPDATE accounts SET balance=?, frozen=? WHERE id=?`).run(bal, frozen, w.accId)
  })

  // —— 企业账户回放（充值覆盖冻结 + 缓冲）——
  companyRows.forEach(c => {
    const evs = companyEvents.filter(e => e.accId === c.accId)
    if (!evs.length && !c.approved) return
    const totalFreeze = evs.filter(e => e.type === 'freeze').reduce((s, e) => s + e.amount, 0)
    const recharge = totalFreeze + yuan(rnd(50000, 200000))
    const stream = [{ time: dayAgo(69, 10), type: 'recharge', amount: recharge, remark: '存管户充值（银行存管虚拟户）' }, ...evs].sort((a, b) => a.time - b.time)
    let bal = 0, frozen = 0
    for (const e of stream) {
      if (e.type === 'recharge') { bal += e.amount; insertFlow(c.accId, 'recharge', e.amount, bal, null, null, e.remark, e.time) }
      else if (e.type === 'freeze') { frozen += e.amount; insertFlow(c.accId, 'freeze', e.amount, bal, 'task', e.taskId, e.remark, e.time) }
      else if (e.type === 'settle_out') { bal -= e.amount; frozen -= e.amount; insertFlow(c.accId, 'settle_out', e.amount, bal, 'task', e.taskId, e.remark, e.time) }
    }
    db.prepare(`UPDATE accounts SET balance=?, frozen=? WHERE id=?`).run(bal, frozen, c.accId)
  })

  // —— 争议（部分历史已结案 + 少量进行中）——
  settledInfos.filter((_, i) => i % 17 === 0).slice(0, 10).forEach((s, k) => {
    const open = k >= 5 // 前 5 条已结案，其余保留为仲裁举证(arbitrating)中
    const did = insert('disputes', { no: bizNo('DS', dayAgo(s.settledDaysAgo + 4)), task_id: s.taskId, type: 'acceptance', initiator_role: 'worker', initiator_id: s.worker.id, claim: '成果已按标准交付，申请平台介入核验并按约结算。', claim_amount: subOf(db.prepare('SELECT price FROM tasks WHERE id=?').get(s.taskId).price), status: open ? 'arbitrating' : 'closed', ruling_type: open ? null : 'full_pay', ruling_amount: open ? null : subOf(db.prepare('SELECT price FROM tasks WHERE id=?').get(s.taskId).price), ruling_note: open ? null : '交付物符合标准，裁决全额结算。', created_at: fmtDT(dayAgo(s.settledDaysAgo + 4, 10)), ruled_at: open ? null : fmtDT(dayAgo(s.settledDaysAgo + 1, 15)), closed_at: open ? null : fmtDT(dayAgo(s.settledDaysAgo, 16)) })
    insert('dispute_events', { dispute_id: did, actor_role: 'worker', actor_id: s.worker.id, action: 'create', content: '发起验收争议，已上传交付物。', attachment_ids: '[]', created_at: fmtDT(dayAgo(s.settledDaysAgo + 4, 12)) })
    if (!open) insert('dispute_events', { dispute_id: did, actor_role: 'admin', actor_id: 0, action: 'rule', content: '核验通过，裁决全额结算。', attachment_ids: '[]', created_at: fmtDT(dayAgo(s.settledDaysAgo + 1, 12)) })
  })
  // —— 理赔（线下任务）——
  settledInfos.filter(s => OFFLINE.includes(s.category) && s.policyNo).slice(0, 6).forEach((s, k) => insert('claims', { policy_no: s.policyNo, task_id: s.taskId, worker_id: s.worker.id, description: '现场作业意外受伤，已就医，申请意外险理赔。', status: k % 3 === 0 ? 'reported' : 'closed', result: k % 3 === 0 ? null : '审核通过，已赔付医疗费用。', created_at: fmtDT(dayAgo(s.settledDaysAgo + 1, 14)), closed_at: k % 3 === 0 ? null : fmtDT(dayAgo(Math.max(0, s.settledDaysAgo - 2), 11)) }))
  // —— 技能认证 ——
  personWorkers.forEach(w => { if (Math.random() < 0.6) { const sk = pick(['UI设计', '平面设计', '短视频剪辑', '文案策划', '前端开发', '笔译']); insert('worker_skills', { worker_id: w.id, skill: sk, level: pick(['初级', '中级', '高级']), status: Math.random() < 0.8 ? 'verified' : 'pending', verify_note: '证书核验通过', verified_by: 1, created_at: fmtDT(dayAgo(rnd(3, 60), 10)) }) } })
  // —— 客服工单 ——
  for (let i = 0; i < 8; i++) { const w = pick(workerRows); const cat = pick(['提现未到账咨询', '实名认证问题', '发票申请咨询', '任务结算疑问']); const tid = insert('tickets', { no: bizNo('TK', dayAgo(rnd(1, 40))), user_id: w.id, category: '账户与资金', priority: 'normal', title: cat, status: i % 3 === 0 ? 'open' : 'closed', created_at: fmtDT(dayAgo(rnd(1, 40), 11)) }); insert('ticket_messages', { ticket_id: tid, sender: 'user', sender_id: w.id, content: '您好，咨询一下相关问题，麻烦处理。', created_at: fmtDT(dayAgo(rnd(1, 40), 11)) }) }
  // —— 通知（每个零工 1~3 条）——
  workerRows.forEach(w => { const n = rnd(1, 3); for (let k = 0; k < n; k++) insert('notifications', { user_id: w.id, type: pick(['settle', 'hired', 'withdraw', 'review']), title: pick(['任务已验收结算', '已被录用', '提现到账', '收到企业评价']), body: '系统通知：请在对应页面查看详情。', read: Math.random() < 0.5 ? 1 : 0, created_at: fmtDT(dayAgo(rnd(1, 60), 13)) }) })
})()

// —— 复核 ——
const neg = db.prepare(`SELECT COUNT(*) n FROM accounts WHERE balance - frozen < 0`).get().n
const u = db.prepare(`SELECT COUNT(*) n FROM users`).get().n
const w = db.prepare(`SELECT COUNT(*) n FROM users WHERE role='worker'`).get().n
const co = db.prepare(`SELECT COUNT(*) n FROM companies`).get().n
const t = db.prepare(`SELECT COUNT(*) n FROM tasks`).get().n
const st = db.prepare(`SELECT COUNT(*) n FROM settlements`).get().n
const wd = db.prepare(`SELECT COUNT(*) n FROM withdrawals`).get().n
const months = db.prepare(`SELECT COUNT(DISTINCT period) n FROM tax_records`).get().n
console.log(`\n══════════ bigSeed 完成 ══════════`)
console.log(`用户 ${u}（零工 ${w} / 企业 ${co}）  任务 ${t}  结算 ${st}  提现 ${wd}  税务月份跨度 ${months}`)
console.log(`可用余额为负的账户：${neg}（应为 0）`)
console.log(`零工登录：152000000xx / Demo@123456   企业登录：181000000xx / Demo@123456`)
