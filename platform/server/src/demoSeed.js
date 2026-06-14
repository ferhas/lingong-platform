// ============================================================================
// 体验数据生成器（demoSeed）：直接写库 + 回填两个月时间戳，造出"已运行两个月"的零工端体验数据。
//
// 与 scripts/mock.mjs 的区别：mock.mjs 走 HTTP 真实业务流，但所有时间戳都是"当下"（只有当月数据，
// 不能演示近6个月收入曲线/累计预扣连续月份）。demoSeed 直接落库并把 created_at/settled_at/period 等
// 摊到最近 ~60 天，并复用真实算税引擎（taxEngine.calcWithholding）保证税额、连续月份、累计口径与线上一致。
//
// 用法：
//   cd platform/server
//   npm run demo            # 写入默认库（与 npm run dev 同一个 DB_PATH）
//   node src/demoSeed.js
//
// 幂等：每次运行先清理上轮 demo 数据（手机号前缀 139000000* 标识），再整体重建。
// 不触碰运营管理员与其它非 demo 数据。生产环境拒绝执行。
//
// 体验账号（零工）：手机号 13900000001 / 密码 Demo@123456 / 姓名 陈志远（已实名·已绑卡）
//   微信端"模拟登录"按钮使用固定 code，开发态确定性 openid 命中此账号（见下方 MOCK_CODE / DEMO_OPENID）。
// ============================================================================
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import db from './db.js'
import { getConfig } from './services/configStore.js'
import { renderContract, recordAgreements } from './services/contractText.js'
import * as taxEngine from './services/taxEngine.js'
import { mulRate, centsToYuan } from './utils/money.js'

if (process.env.NODE_ENV === 'production') {
  console.error('[demoSeed] 生产环境禁止生成体验数据，已中止。')
  process.exit(1)
}

// 若开发服务器正在运行并持有写锁，等待而非立即 SQLITE_BUSY
db.pragma('busy_timeout = 10000')

// —— 体验账号的微信登录凭据：固定 code → 开发态确定性 openid（与 integrations/wechat.js 口径一致）——
export const MOCK_CODE = 'demo-worker-2month-001'
const DEMO_OPENID = 'mock_' + crypto.createHash('sha256').update(MOCK_CODE).digest('hex').slice(0, 16)
const DEMO_PASSWORD = 'Demo@123456'

// ——————————————————————————— 时间工具 ———————————————————————————
const NOW = new Date()
const DAY = 86400000
const pad = n => String(n).padStart(2, '0')
function dayAgo(n, hour = 10, min = 0) {
  const d = new Date(NOW.getTime() - n * DAY)
  d.setHours(hour, min, Math.floor((n * 7) % 60), 0)
  return d
}
function dayAhead(n) { return new Date(NOW.getTime() + n * DAY) }
const fmtDT = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const fmtD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fmtP = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

// 业务单号：前缀 + 日期 + 自增序列（保证 UNIQUE，不依赖随机）
let SEQ = 100000
const bizNo = (prefix, d = NOW) => `${prefix}${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${SEQ++}`

const yuan = y => Math.round(y * 100) // 元 → 分
const MARGIN_RATE = getConfig('platformMarginRate')
const subOf = priceCents => mulRate(priceCents, 1 - MARGIN_RATE)
const OFFLINE = getConfig('offlineCategories')
const insFor = cat => {
  const off = OFFLINE.includes(cat)
  return { plan: off ? '高保额方案' : '基础方案', premium: (off ? getConfig('insurancePremiumHigh') : getConfig('insurancePremiumBase')) * 100 }
}

// 通用插入：返回 lastInsertRowid
function insert(table, obj) {
  const keys = Object.keys(obj)
  const stmt = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
  return stmt.run(...keys.map(k => obj[k])).lastInsertRowid
}

// ——————————————————————————— 清理上轮 demo 数据 ———————————————————————————
function cleanup() {
  const userIds = db.prepare(`SELECT id FROM users WHERE phone LIKE '139000000%'`).all().map(r => r.id)
  if (!userIds.length) return
  const inList = ids => ids.length ? `(${ids.join(',')})` : '(0)'
  const companyIds = db.prepare(`SELECT id FROM companies WHERE user_id IN ${inList(userIds)}`).all().map(r => r.id)
  const taskIds = db.prepare(`SELECT id FROM tasks WHERE company_id IN ${inList(companyIds)} OR worker_id IN ${inList(userIds)}`).all().map(r => r.id)
  const accountIds = db.prepare(`
    SELECT id FROM accounts WHERE (owner_type='company' AND owner_id IN ${inList(companyIds)})
       OR (owner_type='worker' AND owner_id IN ${inList(userIds)})`).all().map(r => r.id)
  const disputeIds = db.prepare(`SELECT id FROM disputes WHERE task_id IN ${inList(taskIds)}`).all().map(r => r.id)

  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    const run = sql => db.prepare(sql).run()
    run(`DELETE FROM dispute_events WHERE dispute_id IN ${inList(disputeIds)}`)
    run(`DELETE FROM disputes WHERE id IN ${inList(disputeIds)}`)
    run(`DELETE FROM task_attachments WHERE task_id IN ${inList(taskIds)}`)
    run(`DELETE FROM applications WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM dispatches WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM contracts WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)} OR company_id IN ${inList(companyIds)}`)
    run(`DELETE FROM invoices WHERE task_id IN ${inList(taskIds)}`)
    run(`DELETE FROM tax_records WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM insurance_policies WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM settlements WHERE task_id IN ${inList(taskIds)}`)
    run(`DELETE FROM claims WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM reviews WHERE task_id IN ${inList(taskIds)} OR reviewer_id IN ${inList(userIds)} OR reviewee_id IN ${inList(userIds)}`)
    run(`DELETE FROM input_invoices WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM task_favorites WHERE task_id IN ${inList(taskIds)} OR worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM callbacks WHERE task_id IN ${inList(taskIds)}`)
    run(`DELETE FROM withdrawals WHERE worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM worker_skills WHERE worker_id IN ${inList(userIds)}`)
    run(`DELETE FROM worker_secrets WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM notifications WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM agreements WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM user_settings WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM login_logs WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM refresh_tokens WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM audit_logs WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM message_logs WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id IN ${inList(userIds)})`)
    run(`DELETE FROM tickets WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM recharge_orders WHERE company_id IN ${inList(companyIds)}`)
    run(`DELETE FROM api_credentials WHERE company_id IN ${inList(companyIds)}`)
    run(`DELETE FROM payroll_names WHERE company_id IN ${inList(companyIds)}`)
    run(`DELETE FROM company_members WHERE user_id IN ${inList(userIds)} OR company_id IN ${inList(companyIds)}`)
    run(`DELETE FROM worker_profiles WHERE user_id IN ${inList(userIds)}`)
    run(`DELETE FROM escrow_members WHERE (owner_type='company' AND owner_id IN ${inList(companyIds)}) OR (owner_type='worker' AND owner_id IN ${inList(userIds)})`)
    run(`DELETE FROM fund_flows WHERE account_id IN ${inList(accountIds)}`)
    run(`DELETE FROM accounts WHERE id IN ${inList(accountIds)}`)
    run(`DELETE FROM tasks WHERE id IN ${inList(taskIds)}`)
    run(`DELETE FROM companies WHERE id IN ${inList(companyIds)}`)
    db.prepare(`DELETE FROM login_attempts WHERE phone LIKE '139000000%'`).run()
    run(`DELETE FROM users WHERE id IN ${inList(userIds)}`)
  })()
  db.pragma('foreign_keys = ON')
  console.log(`[demoSeed] 已清理上轮体验数据（零工/企业 ${userIds.length} 个账号）`)
}

// ——————————————————————————— 主体数据 ———————————————————————————
const COMPANIES = [
  { phone: '13900000010', owner: '王经理', name: '南宁云栖电商科技有限公司', license: '91450100MA2KXT4L0K', industry: '电商零售', city: '南宁' },
  { phone: '13900000011', owner: '李 总', name: '柳州数擎信息技术有限公司', license: '91450200MA1K38PX2M', industry: '互联网技术', city: '柳州' },
  { phone: '13900000012', owner: '张主管', name: '桂林极光文化传媒有限公司', license: '91450300MA5EHQ9R3T', industry: '文化传媒', city: '桂林' },
  { phone: '13900000013', owner: '赵经理', name: '玉林知行教育咨询有限公司', license: '91450900MA01C9KX7P', industry: '教育咨询', city: '玉林' },
  { phone: '13900000014', owner: '陈采购', name: '北海优鲜供应链管理有限公司', license: '91450500MA9XL2WK5H', industry: '供应链', city: '北海' },
  { phone: '13900000015', owner: '周 工', name: '南宁邕创设计顾问有限公司', license: '91450100MA6D1ABC2K', industry: '设计服务', city: '南宁' }
]

// 其它零工（作为任务大厅报名者，使企业看到竞争、报名数真实）
const OTHER_WORKERS = [
  { phone: '13900000002', name: '孙 倩', realName: '孙倩', credit: 690 },
  { phone: '13900000003', name: '周 敏', realName: '周敏', credit: 655 },
  { phone: '13900000004', name: '黄 磊', realName: '黄磊', credit: 620 }
]

// 体验零工已完成结算的历史订单（settledDaysAgo 从大到小=由早到晚处理，保证累计预扣口径正确）
const SETTLED = [
  ['女装店铺主图设计10张', '设计', '远程', 1600],
  ['品牌VI基础规范设计', '设计', '远程', 3200],
  ['英文产品手册翻译(8000词)', '翻译', '远程', 2400],
  ['公众号推文撰写6篇', '文案', '远程', 1500],
  ['短视频剪辑15条', '视频', '远程', 2600],
  ['618大促Banner设计', '设计', '远程', 1200],
  ['日文邮件往来翻译', '翻译', '远程', 900],
  ['商品详情页H5开发', '技术', '远程', 3600],
  ['小红书种草文案8篇', '文案', '远程', 1280],
  ['自助点餐机安装调试', '安装', '南宁', 680], // 线下→高保额→关联理赔
  ['产品三维建模渲染', '设计', '远程', 4200],
  ['直播带货脚本撰写', '文案', '远程', 1100],
  ['活动落地页前端开发', '技术', '远程', 3000],
  ['企业宣传片分镜脚本', '文案', '远程', 1800],
  ['中英商务合同翻译', '翻译', '远程', 2000],
  ['短视频封面设计20张', '设计', '远程', 1400],
  ['公司年报排版设计', '设计', '远程', 1500],
  ['小程序首页改版开发', '技术', '远程', 3800],
  ['品牌Slogan策划', '文案', '远程', 900],
  ['节日营销海报3款', '设计', '远程', 1500],
  ['App引导页插画', '设计', '远程', 2200]
]

// 进行中 / 待验收（当前在接任务）
const WORKING = [
  ['餐饮品牌全案设计', '设计', '远程', 5200, 6],   // 录用 6 天前
  ['电商详情页批量制作', '设计', '远程', 2600, 3]
]
const DELIVERED = [
  ['产品白皮书中译英', '翻译', '远程', 2600, 8, 2], // 录用 8 天前，交付 2 天前
  ['官网改版前端切图', '技术', '远程', 2400, 7, 1]
]

// 任务大厅（招募中），未来截止
const HALL = [
  ['天猫旗舰店双12主视觉', '设计', '远程', 2800, 16],
  ['新消费品牌LOGO设计', '设计', '远程', 3500, 20],
  ['短视频带货脚本(美妆)', '文案', '远程', 1300, 9],
  ['英中技术文档翻译', '翻译', '远程', 2200, 14],
  ['小程序商城后端开发', '技术', '远程', 9000, 30],
  ['企业宣传短视频剪辑10条', '视频', '远程', 2400, 12],
  ['门店海报设计(连锁)', '设计', '柳州', 1600, 10],
  ['客服话术与FAQ整理', '文案', '远程', 900, 7],
  ['品牌故事长文案', '文案', '远程', 1500, 11],
  ['618会场页面切图', '技术', '远程', 2600, 8],
  ['连锁门店设备巡检安装', '安装', '桂林', 1200, 13],
  ['生鲜配送排线优化', '配送', '北海', 800, 6],
  ['产品三维动画制作', '视频', '远程', 6800, 28],
  ['日语产品介绍翻译', '翻译', '远程', 1100, 9],
  ['知识付费课程剪辑', '视频', '远程', 3200, 15],
  ['小红书账号代运营文案', '文案', '远程', 2000, 18],
  ['UI组件库设计规范', '设计', '远程', 4800, 22],
  ['活动现场物料施工搭建', '施工', '玉林', 2600, 10],
  ['电商主图批量设计30张', '设计', '远程', 2400, 9],
  ['品牌私域SOP文案', '文案', '远程', 1400, 12],
  ['前端性能优化外包', '技术', '远程', 5200, 25],
  ['公众号封面图设计月包', '设计', '远程', 1800, 14]
]

// ——————————————————————————— 生成 ———————————————————————————
cleanup()

const passHash = bcrypt.hashSync(DEMO_PASSWORD, 8)
const companyEvents = [] // {idx, time, type, amount, taskId, remark}
const workerCredits = [] // {time, amt, taskId, title}
let demoWorkerId, demoAccountId
const companyRows = [] // {id, userId, ...COMPANIES[i]}

db.transaction(() => {
  // —— 企业 + 企业主 + 存管/账户 ——
  COMPANIES.forEach((c, i) => {
    const createdAt = fmtDT(dayAgo(62, 9))
    const userId = insert('users', {
      role: 'company', phone: c.phone, password_hash: passHash, name: c.owner, status: 'active', created_at: createdAt
    })
    const companyId = insert('companies', {
      user_id: userId, company_name: c.name, license_no: c.license, industry: c.industry,
      contact_phone: c.phone, contact_email: `hr${i + 1}@demo.com`, risk_level: '低', risk_note: '',
      status: 'approved', review_note: '资质齐全，准入通过', master_contract_no: bizNo('ZCL', dayAgo(62)),
      invite_code: 'INV' + String(companyIdSafe(i)).padStart(4, '0') + String(1000 + i),
      esign_authorized: 1, esign_auth_at: createdAt, created_at: createdAt
    })
    insert('company_members', { user_id: userId, company_id: companyId, member_role: 'owner', created_at: createdAt })
    const accId = insert('accounts', { owner_type: 'company', owner_id: companyId, balance: 0, frozen: 0 })
    insert('escrow_members', {
      owner_type: 'company', owner_id: companyId, member_no: bizNo('EMC', dayAgo(62)),
      sub_acct_no: '6650' + String(100000 + companyId), status: 'opened', created_at: createdAt
    })
    recordAgreements(userId)
    companyRows.push({ ...c, id: companyId, userId, accId, createdAt })
  })

  // —— 体验零工（已实名 + 绑卡 + 微信 openid）——
  const wCreatedAt = fmtDT(dayAgo(64, 9))
  demoWorkerId = insert('users', {
    role: 'worker', phone: '13900000001', password_hash: passHash, name: '陈志远',
    status: 'active', wx_openid: DEMO_OPENID, created_at: wCreatedAt
  })
  const frameNo = bizNo('FBK', dayAgo(63))
  insert('worker_profiles', {
    user_id: demoWorkerId, verified: 1, real_name: '陈志远',
    id_card_masked: '3301**********1235', bank_card_masked: '6217 **** **** 6217',
    subject_type: 'person', frame_contract_no: frameNo, locked: 0,
    verified_at: fmtDT(dayAgo(63, 11)), credit_score: 768, invited_by_company_id: companyRows[0].id, face_verified: 1
  })
  demoAccountId = insert('accounts', { owner_type: 'worker', owner_id: demoWorkerId, balance: 0, frozen: 0 })
  insert('escrow_members', {
    owner_type: 'worker', owner_id: demoWorkerId, member_no: bizNo('EMW', dayAgo(63)),
    sub_acct_no: '6650' + String(900000 + demoWorkerId), bind_card_token: 'BCT' + crypto.randomBytes(6).toString('hex'),
    card_masked: '6217 **** **** 6217', status: 'card_bound', created_at: fmtDT(dayAgo(63, 12))
  })
  // 框架分包协议
  insert('contracts', {
    type: 'frame_sub', no: frameNo, party_a: '平台', party_b: '陈志远',
    worker_id: demoWorkerId, content_hash: hashOf({ frameNo, demoWorkerId }), esign_id: 'ESIGN' + SEQ++,
    content: renderContract('frame_sub', { partyB: '陈志远', contractNo: frameNo, date: fmtD(dayAgo(63)), hash: 'demo' }),
    signed_at: fmtDT(dayAgo(63, 11))
  })
  recordAgreements(demoWorkerId)
  insert('user_settings', { user_id: demoWorkerId, value: JSON.stringify({ notifyEnabled: true }), updated_at: wCreatedAt })

  // —— 其它零工 ——
  const otherWorkerIds = OTHER_WORKERS.map(w => {
    const id = insert('users', { role: 'worker', phone: w.phone, password_hash: passHash, name: w.name, status: 'active', created_at: fmtDT(dayAgo(58, 9)) })
    insert('worker_profiles', {
      user_id: id, verified: 1, real_name: w.realName, id_card_masked: '33**************00', bank_card_masked: '6228 **** **** 0000',
      subject_type: 'person', frame_contract_no: bizNo('FBK', dayAgo(58)), locked: 0, verified_at: fmtDT(dayAgo(58, 10)),
      credit_score: w.credit, face_verified: 1
    })
    insert('accounts', { owner_type: 'worker', owner_id: id, balance: 0, frozen: 0 })
    recordAgreements(id)
    return id
  })

  // —— 工具：创建一个任务（含工单合同、企业冻结事件）——
  function makeTask({ title, category, city, priceYuan, status, createdAt, deadline, companyIdx, workerId = null }) {
    const company = companyRows[companyIdx]
    const price = yuan(priceYuan)
    const sub = subOf(price)
    const taskOrderNo = bizNo('GD', new Date(createdAt))
    const taskId = insert('tasks', {
      company_id: company.id, title, category, trade: null, city, pay_method: pickPay(category),
      price, sub_price: sub, deadline, description: descOf(title, category),
      standard: '按交付标准验收，成果不合格不计酬；验收通过后由存管银行结算。',
      status, worker_id: workerId, task_order_no: taskOrderNo, created_at: createdAt
    })
    insert('contracts', {
      type: 'work_order', no: taskOrderNo, party_a: company.name, party_b: '平台',
      company_id: company.id, task_id: taskId, content_hash: hashOf({ taskOrderNo, title, price }), esign_id: 'ESIGN' + SEQ++,
      content: renderContract('work_order', {
        partyA: company.name, contractNo: taskOrderNo, date: fmtD(new Date(createdAt)), taskTitle: title,
        category, payMethod: pickPay(category), price: priceYuan.toFixed(2), deadline,
        standard: '见任务描述', hash: 'demo'
      }),
      signed_at: createdAt
    })
    // 发布即冻结承揽价
    companyEvents.push({ idx: companyIdx, time: new Date(createdAt), type: 'freeze', amount: price, taskId, remark: `发布任务冻结：${title}` })
    return { taskId, price, sub, company }
  }

  // —— 工具：录用落地（分包工单 + 保单 + 录用应聘）——
  function hire({ taskId, sub, companyId, hiredAt, source = 'apply', category }) {
    const subOrderNo = bizNo('FB', new Date(hiredAt))
    const ins = insFor(category)
    const policyNo = bizNo('BD', new Date(hiredAt))
    db.prepare(`UPDATE tasks SET sub_order_no = ?, policy_no = ? WHERE id = ?`).run(subOrderNo, policyNo, taskId)
    insert('contracts', {
      type: 'sub_order', no: subOrderNo, party_a: '平台', party_b: '陈志远',
      company_id: companyId, worker_id: demoWorkerId, task_id: taskId,
      content_hash: hashOf({ subOrderNo, taskId, sub }), esign_id: 'ESIGN' + SEQ++,
      content: renderContract('sub_order', {
        partyB: '陈志远', contractNo: subOrderNo, date: fmtD(new Date(hiredAt)),
        taskTitle: db.prepare(`SELECT title FROM tasks WHERE id=?`).get(taskId).title, payMethod: '按成果',
        subPrice: centsToYuan(sub).toFixed(2), policyNo, hash: 'demo'
      }),
      signed_at: hiredAt
    })
    insert('insurance_policies', { policy_no: policyNo, task_id: taskId, worker_id: demoWorkerId, plan: ins.plan, premium: ins.premium, status: 'active', created_at: hiredAt })
    insert('applications', { task_id: taskId, worker_id: demoWorkerId, status: 'hired', source, created_at: fmtDT(new Date(new Date(hiredAt).getTime() - DAY)) })
    return { subOrderNo, policyNo }
  }

  // —— 历史结算订单（按时间由早到晚）——
  const settledMeta = SETTLED.map((t, i) => {
    const settledDaysAgo = Math.round(57 - i * 2.35) // 57 → ~10
    return { title: t[0], category: t[1], city: t[2], priceYuan: t[3], settledDaysAgo, idx: i }
  }).sort((a, b) => b.settledDaysAgo - a.settledDaysAgo) // 早→晚

  const settledTaskInfos = []
  settledMeta.forEach((m, order) => {
    const companyIdx = m.idx % companyRows.length
    const createdAt = fmtDT(dayAgo(m.settledDaysAgo + 7, 10))
    const hiredAt = fmtDT(dayAgo(m.settledDaysAgo + 6, 15))
    const deliveredAt = fmtDT(dayAgo(m.settledDaysAgo + 2, 16))
    const settledDate = dayAgo(m.settledDaysAgo, 11)
    const settledAt = fmtDT(settledDate)
    const { taskId, price, sub, company } = makeTask({
      title: m.title, category: m.category, city: m.city, priceYuan: m.priceYuan,
      status: 'settled', createdAt, deadline: fmtD(dayAgo(m.settledDaysAgo + 1)), companyIdx, workerId: demoWorkerId
    })
    hire({ taskId, sub, companyId: company.id, hiredAt, category: m.category })
    db.prepare(`UPDATE tasks SET deliverable = ?, delivered_at = ? WHERE id = ?`)
      .run(`${m.title} 成品已交付（含源文件/网盘链接）`, deliveredAt, taskId)

    // —— 复用真实算税引擎：按 period 累计预扣，连续月份/累计口径与线上一致 ——
    const period = fmtP(settledDate)
    const { tax, vat, detail } = taxEngine.calcWithholding(demoWorkerId, sub, period)
    const months = detail.months
    const net = sub - tax - vat
    const margin = price - sub
    const confirmNo = bizNo('QR', settledDate)
    const voucherNo = tax > 0 ? bizNo('TAX', settledDate) : null
    const invoiceNo = bizNo('FP', settledDate)

    insert('settlements', {
      task_id: taskId, confirm_no: confirmNo, worker_id: demoWorkerId, company_id: company.id,
      gross: sub, tax, vat, net, margin, method: 'cumulative',
      income_type: getConfig('continuousLaborCategories').includes(m.category) ? 'labor_continuous' : 'labor_other',
      consecutive_months: months, tax_voucher_no: voucherNo, invoice_no: invoiceNo,
      legs_done: JSON.stringify(['net', 'tax', 'margin', 'invoice']), status: 'done', attempts: 0,
      created_at: settledAt, done_at: settledAt
    })
    insert('tax_records', {
      worker_id: demoWorkerId, task_id: taskId, company_id: company.id, gross: sub, tax, vat, net,
      method: 'cumulative', income_type: getConfig('continuousLaborCategories').includes(m.category) ? 'labor_continuous' : 'labor_other',
      consecutive_months: months, period, tax_voucher_no: voucherNo, created_at: settledAt
    })
    insert('invoices', {
      no: invoiceNo, company_id: company.id, task_id: taskId, amount: price, tax_rate: getConfig('outputVatRate'),
      item: '*现代服务*灵活用工服务费', confirm_no: confirmNo, status: 'issued', issued_at: settledAt
    })
    db.prepare(`UPDATE tasks SET confirm_no = ?, settled_at = ? WHERE id = ?`).run(confirmNo, settledAt, taskId)

    // 账务事件：企业划扣、零工入账
    companyEvents.push({ idx: companyIdx, time: settledDate, type: 'settle_out', amount: price, taskId, remark: `验收结算：${m.title}` })
    workerCredits.push({ time: settledDate, amt: net, taskId, title: m.title })

    // 互评（多数有企业评价，部分有零工回评）
    if (order % 4 !== 3) {
      insert('reviews', {
        task_id: taskId, reviewer_role: 'company', reviewer_id: company.userId, reviewee_id: demoWorkerId,
        score: order % 5 === 0 ? 4 : 5, tags: JSON.stringify(['按时交付', '质量过硬']),
        comment: '交付质量高，沟通顺畅，下次还会合作。', created_at: fmtDT(dayAgo(m.settledDaysAgo - 1 > 0 ? m.settledDaysAgo - 1 : 0, 9))
      })
    }
    if (order % 3 === 0) {
      insert('reviews', {
        task_id: taskId, reviewer_role: 'worker', reviewer_id: demoWorkerId, reviewee_id: company.userId,
        score: 5, tags: JSON.stringify(['需求清晰', '验收爽快']),
        comment: '需求清晰，结算到账快。', created_at: fmtDT(dayAgo(m.settledDaysAgo - 1 > 0 ? m.settledDaysAgo - 1 : 0, 10))
      })
    }
    settledTaskInfos.push({ taskId, category: m.category, settledDaysAgo: m.settledDaysAgo, company, policyNo: db.prepare(`SELECT policy_no FROM tasks WHERE id=?`).get(taskId).policy_no, title: m.title })
  })

  // —— 进行中订单 ——
  WORKING.forEach((t, i) => {
    const [title, category, city, priceYuan, hiredDaysAgo] = t
    const companyIdx = (i + 2) % companyRows.length
    const createdAt = fmtDT(dayAgo(hiredDaysAgo + 2, 10))
    const hiredAt = fmtDT(dayAgo(hiredDaysAgo, 15))
    const { taskId, sub, company } = makeTask({
      title, category, city, priceYuan, status: 'working', createdAt, deadline: fmtD(dayAhead(7 + i * 3)), companyIdx, workerId: demoWorkerId
    })
    hire({ taskId, sub, companyId: company.id, hiredAt, category })
  })

  // —— 待验收订单 ——
  DELIVERED.forEach((t, i) => {
    const [title, category, city, priceYuan, hiredDaysAgo, deliveredDaysAgo] = t
    const companyIdx = (i + 4) % companyRows.length
    const createdAt = fmtDT(dayAgo(hiredDaysAgo + 2, 10))
    const hiredAt = fmtDT(dayAgo(hiredDaysAgo, 15))
    const { taskId, sub, company } = makeTask({
      title, category, city, priceYuan, status: 'delivered', createdAt, deadline: fmtD(dayAhead(3 + i * 2)), companyIdx, workerId: demoWorkerId
    })
    hire({ taskId, sub, companyId: company.id, hiredAt, category })
    db.prepare(`UPDATE tasks SET deliverable = ?, delivered_at = ? WHERE id = ?`)
      .run(`${title} 首版已交付，待企业验收。`, fmtDT(dayAgo(deliveredDaysAgo, 16)), taskId)
  })

  // —— 任务大厅（招募中）+ 报名者 ——
  const hallTaskIds = []
  HALL.forEach((t, i) => {
    const [title, category, city, priceYuan, deadlineAhead] = t
    const companyIdx = i % companyRows.length
    const createdAt = fmtDT(dayAgo((i * 13) % 38 + 1, 9 + (i % 8)))
    const { taskId } = makeTask({
      title, category, city, priceYuan, status: 'recruiting', createdAt, deadline: fmtD(dayAhead(deadlineAhead)), companyIdx
    })
    hallTaskIds.push(taskId)
    // 其它零工报名 1~3 人
    const n = 1 + (i % 3)
    for (let k = 0; k < n; k++) {
      insert('applications', { task_id: taskId, worker_id: otherWorkerIds[(i + k) % otherWorkerIds.length], status: 'applied', source: 'apply', created_at: fmtDT(dayAgo(((i * 7 + k) % 20) + 1, 14)) })
    }
    // 体验零工对部分招募任务"已报名"
    if (i % 4 === 1) {
      insert('applications', { task_id: taskId, worker_id: demoWorkerId, status: 'applied', source: 'apply', created_at: fmtDT(dayAgo((i % 10) + 1, 16)) })
    }
  })

  // —— 收藏（招募中任务）——
  ;[0, 4, 12, 16].forEach((hi, k) => {
    if (hallTaskIds[hi]) insert('task_favorites', { worker_id: demoWorkerId, task_id: hallTaskIds[hi], created_at: fmtDT(dayAgo(k * 3 + 2, 20)) })
  })

  // —— 派单邀约：2 个待接受 + 1 个已接受（历史，挂在某结算单上）——
  ;[2, 6].forEach((hi, k) => {
    const tid = hallTaskIds[hi]
    if (!tid) return
    const t = db.prepare(`SELECT company_id FROM tasks WHERE id=?`).get(tid)
    insert('dispatches', {
      task_id: tid, worker_id: demoWorkerId, company_id: t.company_id, status: 'invited',
      note: k === 0 ? '上次合作很满意，这单优先派给你～' : '这单适合你，方便接一下吗？',
      created_at: fmtDT(dayAgo(k + 1, 11))
    })
  })
  if (settledTaskInfos.length) {
    const acc = settledTaskInfos[Math.floor(settledTaskInfos.length / 2)]
    insert('dispatches', {
      task_id: acc.taskId, worker_id: demoWorkerId, company_id: acc.company.id, status: 'accepted',
      note: '老客户定向派单。', created_at: fmtDT(dayAgo(acc.settledDaysAgo + 7, 9)), responded_at: fmtDT(dayAgo(acc.settledDaysAgo + 6, 16))
    })
    db.prepare(`UPDATE applications SET source='dispatch' WHERE task_id=? AND worker_id=?`).run(acc.taskId, demoWorkerId)
  }

  // —— 争议（历史已结案，挂在某结算单上）——
  if (settledTaskInfos.length > 3) {
    const dt = settledTaskInfos[3]
    const sub = subOf(yuan(SETTLED.find(s => s[0] === dt.title)?.[3] || 1500))
    const dNo = bizNo('DS', dayAgo(dt.settledDaysAgo + 4))
    const did = insert('disputes', {
      no: dNo, task_id: dt.taskId, type: 'acceptance', initiator_role: 'worker', initiator_id: demoWorkerId,
      claim: '成果已按标准交付并提交验收材料，企业迟迟未验收，申请平台介入核验并按约结算。',
      claim_amount: sub, status: 'closed', arbiter_id: null, ruling_type: 'full_pay', ruling_amount: sub,
      ruling_note: '经核验交付物符合约定标准，裁决全额结算。', stage_deadline: null,
      created_at: fmtDT(dayAgo(dt.settledDaysAgo + 4, 10)), ruled_at: fmtDT(dayAgo(dt.settledDaysAgo + 1, 15)), closed_at: fmtDT(dayAgo(dt.settledDaysAgo, 16))
    })
    const evs = [
      ['worker', demoWorkerId, 'create', '发起验收争议，已上传交付物与沟通记录。', dt.settledDaysAgo + 4],
      ['company', dt.company.userId, 'respond', '已收到，正在内部确认验收结论。', dt.settledDaysAgo + 3],
      ['admin', null, 'rule', '平台核验交付物符合标准，裁决全额结算。', dt.settledDaysAgo + 1],
      ['admin', null, 'execute', '裁决已执行，分包款已结算入账。', dt.settledDaysAgo]
    ]
    evs.forEach(([role, id, action, content, da]) => insert('dispute_events', {
      dispute_id: did, actor_role: role, actor_id: id || 0, action, content, attachment_ids: '[]', created_at: fmtDT(dayAgo(da, 12))
    }))
  }

  // —— 保险理赔（历史已结案，挂在线下"安装"结算单上）——
  const offlineSettled = settledTaskInfos.find(s => OFFLINE.includes(s.category))
  if (offlineSettled && offlineSettled.policyNo) {
    insert('claims', {
      policy_no: offlineSettled.policyNo, task_id: offlineSettled.taskId, worker_id: demoWorkerId,
      description: '现场安装调试时手部被设备边角划伤，已就医处理，申请意外险理赔。',
      status: 'closed', result: '审核通过，已赔付医疗费用 ¥320。',
      created_at: fmtDT(dayAgo(offlineSettled.settledDaysAgo + 1, 14)), closed_at: fmtDT(dayAgo(offlineSettled.settledDaysAgo - 2 > 0 ? offlineSettled.settledDaysAgo - 2 : 0, 11))
    })
  }

  // —— 技能认证 ——
  const skills = [
    ['UI设计', '高级', 'verified', 40],
    ['平面设计', '中级', 'verified', 35],
    ['短视频剪辑', '初级', 'verified', 20],
    ['文案策划', '中级', 'pending', 3]
  ]
  skills.forEach(([skill, level, status, da]) => insert('worker_skills', {
    worker_id: demoWorkerId, skill, level, status,
    verify_note: status === 'verified' ? '证书核验通过' : null,
    verified_by: status === 'verified' ? 1 : null, created_at: fmtDT(dayAgo(da, 10))
  }))

  // —— 计划并落地提现（done 多笔 + 1 笔在途）——
  const creditsSorted = [...workerCredits].sort((a, b) => a.time - b.time)
  const creditedBy = t => creditsSorted.filter(c => c.time <= t).reduce((s, c) => s + c.amt, 0)
  const wdPlans = [
    { applyDaysAgo: 50, planYuan: 1000, status: 'done' },
    { applyDaysAgo: 40, planYuan: 2000, status: 'done' },
    { applyDaysAgo: 30, planYuan: 1500, status: 'done' },
    { applyDaysAgo: 18, planYuan: 3000, status: 'done' },
    { applyDaysAgo: 9, planYuan: 2500, status: 'done' },
    { applyDaysAgo: 2, planYuan: 2000, status: 'applied' }
  ]
  let usedBalance = 0, pendingFrozen = 0
  const workerEvents = creditsSorted.map(c => ({ time: c.time, kind: 'credit', amt: c.amt, taskId: c.taskId, remark: `分包款入账：${c.title}` }))
  wdPlans.forEach(p => {
    const applyT = dayAgo(p.applyDaysAgo, 14)
    const available = creditedBy(applyT) - usedBalance - pendingFrozen
    let amt = Math.min(yuan(p.planYuan), Math.floor((available - 20000) / 10000) * 10000) // 留 200 元缓冲、取整到 100 元
    if (amt < 20000) return
    const member = db.prepare(`SELECT member_no, card_masked FROM escrow_members WHERE owner_type='worker' AND owner_id=?`).get(demoWorkerId)
    if (p.status === 'done') {
      const doneT = dayAgo(p.applyDaysAgo - 1, 16)
      const wid = insert('withdrawals', {
        worker_id: demoWorkerId, amount: amt, bank_card: member.card_masked, status: 'done',
        escrow_txn_no: bizNo('ETX', applyT), member_no: member.member_no, created_at: fmtDT(applyT), done_at: fmtDT(doneT)
      })
      workerEvents.push({ time: applyT, kind: 'wd_freeze', amt, refId: wid, remark: `提现申请冻结 WD${wid}` })
      workerEvents.push({ time: doneT, kind: 'wd_pay', amt, refId: wid, remark: `提现出金 WD${wid}（尾号6217）` })
      usedBalance += amt
    } else {
      const wid = insert('withdrawals', {
        worker_id: demoWorkerId, amount: amt, bank_card: member.card_masked, status: 'applied',
        member_no: member.member_no, created_at: fmtDT(applyT)
      })
      workerEvents.push({ time: applyT, kind: 'wd_freeze', amt, refId: wid, remark: `提现申请冻结 WD${wid}` })
      pendingFrozen += amt
    }
  })

  // —— 回放零工账户流水（时间序，保证 balance_after 正确、可用余额非负）——
  workerEvents.sort((a, b) => a.time - b.time)
  let wBal = 0, wFrozen = 0
  for (const e of workerEvents) {
    if (e.kind === 'credit') { wBal += e.amt; insertFlow(demoAccountId, 'settle_in', e.amt, wBal, 'task', e.taskId, e.remark, e.time) }
    else if (e.kind === 'wd_freeze') { wFrozen += e.amt; insertFlow(demoAccountId, 'freeze', e.amt, wBal, 'withdrawal', e.refId, e.remark, e.time) }
    else if (e.kind === 'wd_pay') { wBal -= e.amt; wFrozen -= e.amt; insertFlow(demoAccountId, 'withdraw', e.amt, wBal, 'withdrawal', e.refId, e.remark, e.time) }
  }
  db.prepare(`UPDATE accounts SET balance=?, frozen=? WHERE id=?`).run(wBal, wFrozen, demoAccountId)

  // —— 回放企业账户流水（每家：充值在最早，覆盖全部冻结）——
  companyRows.forEach((c, idx) => {
    const evs = companyEvents.filter(e => e.idx === idx)
    const totalFreeze = evs.filter(e => e.type === 'freeze').reduce((s, e) => s + e.amount, 0)
    const recharge = totalFreeze + yuan(200000) // 充足缓冲，账户健康
    const stream = [{ time: dayAgo(61, 10), type: 'recharge', amount: recharge, taskId: null, remark: '存管户充值（银行存管虚拟户）' }, ...evs]
      .sort((a, b) => a.time - b.time)
    let bal = 0, frozen = 0
    for (const e of stream) {
      if (e.type === 'recharge') { bal += e.amount; insertFlow(c.accId, 'recharge', e.amount, bal, null, null, e.remark, e.time) }
      else if (e.type === 'freeze') { frozen += e.amount; insertFlow(c.accId, 'freeze', e.amount, bal, 'task', e.taskId, e.remark, e.time) }
      else if (e.type === 'settle_out') { bal -= e.amount; frozen -= e.amount; insertFlow(c.accId, 'settle_out', e.amount, bal, 'task', e.taskId, e.remark, e.time) }
    }
    db.prepare(`UPDATE accounts SET balance=?, frozen=? WHERE id=?`).run(bal, frozen, c.accId)
  })

  // —— 站内通知（贯穿两月，部分未读）——
  const notes = []
  settledTaskInfos.slice(-6).forEach((s, i) => notes.push(['settle', '任务已验收结算', `「${s.title}」已验收合格，分包款已结算至您的账户。`, s.settledDaysAgo, i < 2 ? 0 : 1]))
  notes.push(['hired', '已被录用', '您已被录用承接「餐饮品牌全案设计」，分包工单已电子签，意外险已生效。', 6, 0])
  notes.push(['deliver', '交付提醒', '「产品白皮书中译英」已提交交付物，等待企业验收。', 2, 0])
  notes.push(['dispatch', '收到派单邀约', '企业向您定向派单「新消费品牌LOGO设计」，请在接单中心确认。', 1, 0])
  notes.push(['withdraw', '提现到账', '您的提现 ¥2,500 已转入尾号 6217 银行卡。', 8, 1])
  notes.push(['review', '收到企业评价', '某企业已对您完成评价，互评期满后可见详情。', 12, 1])
  notes.push(['dispute', '争议已结案', '您发起的验收争议已裁决：全额结算，款项已入账。', 14, 1])
  notes.forEach(([type, title, body, da, read]) => insert('notifications', { user_id: demoWorkerId, type, title, body, read, created_at: fmtDT(dayAgo(da, 13)) }))
})()

// 复核：可用余额非负
const acc = db.prepare(`SELECT balance, frozen FROM accounts WHERE id=?`).get(demoAccountId)
if (acc.balance - acc.frozen < 0) console.warn('[demoSeed] 警告：体验零工可用余额为负，请检查提现计划。')

printSummary()

// ——————————————————————————— 辅助函数 ———————————————————————————
function hashOf(obj) { return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex') }
function companyIdSafe(i) { return 9000 + i } // 仅用于邀请码占位，避免与真实自增 id 巧合
function pickPay(category) {
  if (['视频'].includes(category)) return '按件'
  if (['配送', '安装', '施工'].includes(category)) return '按单'
  return '按成果'
}
function descOf(title, category) {
  return `${title}。${category}类承揽任务，按交付标准完成并提供源文件/成果；工具自备、时间自主、不接受考勤，成果不合格不计酬。`
}
function insertFlow(accountId, type, amount, balanceAfter, refType, refId, remark, time) {
  insert('fund_flows', { account_id: accountId, type, amount, balance_after: balanceAfter, ref_type: refType, ref_id: refId, remark, created_at: fmtDT(time instanceof Date ? time : new Date(time)) })
}
function printSummary() {
  const g = sql => db.prepare(sql).get(demoWorkerId)
  const orders = g(`SELECT COUNT(*) n FROM tasks WHERE worker_id=?`).n
  const settled = g(`SELECT COUNT(*) n FROM tasks WHERE worker_id=? AND status='settled'`).n
  const months = db.prepare(`SELECT COUNT(DISTINCT period) n FROM tax_records WHERE worker_id=?`).get(demoWorkerId).n
  const yearGross = db.prepare(`SELECT COALESCE(SUM(gross),0) g, COALESCE(SUM(tax),0) t FROM tax_records WHERE worker_id=?`).get(demoWorkerId)
  const a = db.prepare(`SELECT balance, frozen FROM accounts WHERE id=?`).get(demoAccountId)
  const hall = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status='recruiting'`).get().n
  const wd = db.prepare(`SELECT COUNT(*) n FROM withdrawals WHERE worker_id=?`).get(demoWorkerId).n
  console.log(`
══════════════════════════════════════════════════════════════
  ✅ 体验数据已就绪（覆盖最近约两个月）
  零工：陈志远  13900000001 / ${DEMO_PASSWORD}（已实名·已绑卡）
  · 订单 ${orders} 个（其中已结算 ${settled}）  · 招募中大厅任务 ${hall} 个
  · 累计收入跨 ${months} 个月  税前合计 ¥${centsToYuan(yearGross.g)}  已预扣个税 ¥${centsToYuan(yearGross.t)}
  · 账户可提现 ¥${centsToYuan(a.balance - a.frozen)}（冻结 ¥${centsToYuan(a.frozen)}）  · 提现记录 ${wd} 笔
  · 技能/收藏/派单/争议/理赔/通知 均已填充

  微信小程序登录页点击「模拟登录（体验账号）」即可直接进入（开发态）。
  固定登录 code：${MOCK_CODE}
══════════════════════════════════════════════════════════════`)
}
