// Mock 测试数据生成器：对【运行中】的 API 服务执行真实业务流，造出可登录、覆盖小程序各页面的数据。
// 与 acceptance.mjs 同源（都走 HTTP、尊重四流硬校验），但更偏「逛小程序测试」：任务铺满大厅、
// 订单覆盖各状态、收入/提现/技能/收藏/争议/评价齐全，方便验证 C 端（含新加的字体大小设置）。
//
// 用法（先启动后端：cd platform/server && npm run dev）：
//   node platform/scripts/mock.mjs [baseUrl]      # 默认 http://127.0.0.1:3000
//   或在 platform/server 下：npm run mock
//
// 幂等：账号/实名/准入可重复执行；任务仅在企业当前无任务时创建一次（避免重复堆单）。

const BASE = (process.argv[2] || process.env.MOCK_BASE || 'http://127.0.0.1:3000') + '/api/v1'

async function api(method, url, { token, body } = {}) {
  let res
  try {
    res = await fetch(BASE + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    console.error(`\n✗ 无法连接 ${BASE} —— 请先启动后端：cd platform/server && npm run dev\n`)
    process.exit(1)
  }
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

const log = (...a) => console.log(...a)
// 非关键步骤包一层：失败只告警，不中断造数主流程
async function safe(label, fn) {
  try { await fn() } catch (e) { log(`  · 跳过（${label}）：${e.message}`) }
}

async function loginOrRegister(body) {
  let r = await api('POST', '/auth/login', { body: { phone: body.phone, password: body.password } })
  if (r.status !== 200) r = await api('POST', '/auth/register', { body: { agree: true, ...body } })
  if (!r.data?.token) throw new Error(`账号 ${body.phone} 登录/注册失败: ${JSON.stringify(r.data)}`)
  return r.data
}

// ———————————————————————— 账号 ————————————————————————
const admin = await loginOrRegister({ phone: '13800000001', password: 'Admin@123456' })
log('✓ 运营管理员就绪')

const company = await loginOrRegister({
  role: 'company', phone: '13700000001', password: 'Company@123', name: '王经理',
  companyName: '杭州云栖电商科技有限公司', licenseNo: '91330106MA2KXT4L0K', industry: '电商零售'
})
log('✓ 企业账号就绪（13700000001 / Company@123）')

const worker1 = await loginOrRegister({ role: 'worker', phone: '13600000001', password: 'Worker@123', name: '李建国', agree: true })
const worker2 = await loginOrRegister({ role: 'worker', phone: '13600000002', password: 'Worker@123', name: '赵晓燕', agree: true })
log('✓ 零工账号就绪（13600000001 / 13600000002，密码 Worker@123）')

// ———————————————————————— 运营准入 ————————————————————————
const pending = (await api('GET', '/admin/companies?status=pending', { token: admin.token })).data.list || []
for (const c of pending) {
  if (c.companyName.includes('云栖')) {
    const r = await api('POST', `/admin/companies/${c.id}/review`, { token: admin.token, body: { pass: true, note: '资质齐全，准入通过' } })
    log(`✓ 企业准入通过（总承揽合同 ${r.data?.masterContractNo || '—'}）`)
  }
}

// ———————————————————————— 实名 + 签约 ————————————————————————
async function ensureVerified(token, realName, idCard, bankCard) {
  const p = (await api('GET', '/worker/profile', { token })).data
  if (p?.verified) return
  await api('POST', '/worker/verify', { token, body: { realName, idCard, bankCard } })
  log(`✓ ${realName} 已实名 + 签署分包协议 + 绑卡`)
}
await ensureVerified(worker1.token, '李建国', '330106199001011235', '6217000000006217')
await ensureVerified(worker2.token, '赵晓燕', '330106199202022346', '6228000000006228')

// ———————————————————————— 充值 ————————————————————————
await api('POST', '/company/recharge', { token: company.token, body: { amount: 200000 } })
log('✓ 企业存管户充值 ¥200,000')

// ———————————————————————— 发单 + 驱动各状态 ————————————————————————
const TASKS = [
  { title: '电商主图设计（10张）', category: '设计', payMethod: '按成果', price: 1500, deadline: '2026-06-28', description: '为新上架的家居类目商品设计10张电商主图，风格简洁明亮，需提供PSD源文件。', standard: '尺寸800x800；提供PSD分层源文件；验收后结算。' },
  { title: '英文产品手册翻译（约8000词）', category: '翻译', payMethod: '按成果', price: 2400, deadline: '2026-06-30', description: '智能家居产品英文说明书翻译为中文，要求术语准确、语句通顺。', standard: '术语表统一；交付Word文档；错译率低于1%。' },
  { title: '短视频剪辑（20条）', category: '视频', payMethod: '按件', price: 3000, deadline: '2026-07-02', description: '提供素材，剪辑成适合视频号投放的竖屏短视频，含字幕与转场。', standard: '1080P竖屏；每条不超过60秒；按验收合格条数计酬。' },
  { title: '小程序商城前端开发', category: '技术', payMethod: '按成果', price: 8000, deadline: '2026-07-18', description: '根据UI设计稿开发点餐小程序前端，对接现有后端接口，含购物车、下单、会员中心。', standard: '还原度95%以上；主流程无阻断性bug；代码交付指定仓库。' },
  { title: '产品宣传文案撰写（5篇）', category: '文案', payMethod: '按件', price: 1000, deadline: '2026-06-24', description: '撰写5篇护肤产品种草文案，原创且通过查重。', standard: '每篇600-800字；原创度90%以上。' },
  { title: '展会物料海报设计（3款）', category: '设计', payMethod: '按成果', price: 1800, deadline: '2026-07-05', description: '为线下展会设计3款竖版海报，含主视觉与日程页。', standard: '提供AI/PSD源文件；印刷出血规范；2轮修改内。' },
  { title: '客服话术整理与FAQ撰写', category: '文案', payMethod: '按成果', price: 900, deadline: '2026-06-26', description: '整理售前售后常见问题，输出标准话术与FAQ文档。', standard: '不少于50条；分类清晰；交付在线文档。' },
  { title: '门店设备安装调试（杭州）', category: '其他', payMethod: '按单', price: 600, deadline: '2026-07-08', description: '到指定门店安装并调试自助点餐机2台，含联网测试。', standard: '现场验收通过；提供调试记录与照片。' },
  { title: '直播带货脚本撰写（家居）', category: '文案', payMethod: '按件', price: 1200, deadline: '2026-07-01', description: '为家居专场直播撰写带货脚本，含产品卖点与互动设计。', standard: '覆盖10款产品；含开场/逼单/福利节点。' },
  { title: 'Logo 与品牌VI设计', category: '设计', payMethod: '按成果', price: 4500, deadline: '2026-07-20', description: '为新茶饮品牌设计Logo及基础VI（名片/杯套/手提袋）。', standard: '提供3版初稿；定稿交付完整源文件与规范手册。' }
]

// 幂等：按标题建索引，补齐缺失任务（可与既有/acceptance 数据共存，不重复发单）。
// 后续流转/补充全部容错：已处于目标状态的调用会被服务端拒绝（4xx），脚本静默跳过 → 整段可重复运行。
const existing = (await api('GET', '/company/tasks?pageSize=100', { token: company.token })).data
const titleToId = new Map((existing.list || []).map(t => [t.title, t.id]))
const ids = []
let created = 0
for (const t of TASKS) {
  let id = titleToId.get(t.title)
  if (!id) {
    const r = await api('POST', '/company/tasks', { token: company.token, body: t })
    if (r.status !== 201) throw new Error('发单失败: ' + JSON.stringify(r.data))
    id = r.data.id; created++
  }
  ids.push(id)
}
log(`✓ 任务就绪 ${ids.length} 个（本次新建 ${created}，任务大厅已铺满）`)

const w1 = worker1.user.id
const w2 = worker2.user.id
const post = (url, token, body) => api('POST', url, { token, body })
const apply = (tid, token) => post(`/worker/tasks/${tid}/apply`, token)
const hire = (tid, workerId) => post(`/company/tasks/${tid}/hire`, company.token, { workerId })
const deliver = (tid, token, note) => post(`/worker/orders/${tid}/deliver`, token, { note })
const accept = (tid) => post(`/company/tasks/${tid}/accept`, company.token)

// 任务1：李建国 全流程结算 + 双向评价
await apply(ids[0], worker1.token); await apply(ids[0], worker2.token)
await hire(ids[0], w1)
await deliver(ids[0], worker1.token, '10张主图成品 + PSD源文件（网盘链接）')
await accept(ids[0])
await safe('企业评价李建国', () => post(`/company/tasks/${ids[0]}/review`, company.token, { score: 5, tags: ['按时交付', '质量过硬'], comment: '主图质量很高，沟通顺畅。' }))
await safe('李建国评价企业', () => post(`/worker/orders/${ids[0]}/review`, worker1.token, { score: 5, tags: ['需求清晰', '验收爽快'], comment: '需求清晰，结算到账快。' }))

// 任务2：赵晓燕 全流程结算
await apply(ids[1], worker2.token)
await hire(ids[1], w2)
await deliver(ids[1], worker2.token, '中文译稿 Word 文档 + 术语对照表')
await accept(ids[1])
await safe('企业评价赵晓燕', () => post(`/company/tasks/${ids[1]}/review`, company.token, { score: 5, tags: ['质量过硬', '响应及时'], comment: '翻译准确专业。' }))

// 任务3：李建国 进行中（已录用未交付）
await apply(ids[2], worker1.token); await hire(ids[2], w1)

// 任务4：李建国 待验收（已交付未验收）
await apply(ids[3], worker1.token); await hire(ids[3], w1)
await deliver(ids[3], worker1.token, '前端首版已交付，含购物车与下单主流程（预览链接）')

// 任务（门店调试 ids[7]，全新无历史）：赵晓燕 交付后发起验收争议（→ 争议处理页）
await apply(ids[7], worker2.token); await hire(ids[7], w2)
await deliver(ids[7], worker2.token, '2台自助点餐机已安装调试，含联网测试记录与现场照片')
await safe('赵晓燕发起争议', async () => {
  const r = await post(`/worker/orders/${ids[7]}/dispute`, worker2.token,
    { type: 'acceptance', claim: '设备已安装调试完成并提交验收记录与照片，企业迟迟未验收，申请平台介入核验并结算。', claimAmount: 600 })
  if (![201, 409].includes(r.status)) throw new Error(JSON.stringify(r.data)) // 409=已有争议，视为就绪
})

// 任务5/6/7：报名中（任务大厅可见报名状态）；任务9/10：保持开放
await apply(ids[4], worker2.token); await apply(ids[5], worker1.token)
await apply(ids[6], worker2.token); await apply(ids[6], worker1.token)

// 收藏 / 技能认证（→ 收藏页、技能页、我的-信用卡片）
await safe('收藏', async () => {
  await post(`/worker/favorites/${ids[3]}`, worker1.token)
  await post(`/worker/favorites/${ids[9]}`, worker1.token)
  await post(`/worker/favorites/${ids[8]}`, worker2.token)
})
await safe('技能认证', async () => {
  await post('/worker/skills', worker1.token, { skill: '平面设计', level: '中级' })
  await post('/worker/skills', worker1.token, { skill: '短视频剪辑', level: '初级' })
  await post('/worker/skills', worker2.token, { skill: '中英翻译', level: '高级' })
})

// 提现：仅在可提现余额足够且无在途提现时申请（避免重复运行反复扣减/报错）
await safe('提现', async () => {
  for (const [token, amount] of [[worker1.token, 800], [worker2.token, 300]]) {
    const inc = (await api('GET', '/worker/income', { token })).data
    const bal = inc?.account?.balance ?? 0
    const wd = (await api('GET', '/worker/withdrawals', { token })).data
    if (bal >= amount && (wd?.list || []).length === 0) await post('/worker/withdraw', token, { amount })
  }
})

// ———————————————————————— 实测汇总（兼校验：以下数字直接来自库）————————————————————————
async function snapshot(name, w) {
  const t = w.token
  const g = (url) => api('GET', url, { token: t }).then(r => r.data)
  const [skills, favs, income, orders, disputes] = await Promise.all([
    g('/worker/skills'), g('/worker/favorites'), g('/worker/income'), g('/worker/orders?pageSize=50'), g('/me/disputes')
  ])
  const byStatus = {}
  for (const o of (orders?.list || [])) byStatus[o.status] = (byStatus[o.status] || 0) + 1
  const skillN = (skills?.list || skills?.skills || []).length
  const favN = (favs?.list || favs?.favorites || []).length
  const dispN = (disputes?.list || []).length
  log(`   ${name}：可提现¥${income?.account?.balance ?? '—'} · 订单${orders?.total || 0} ${JSON.stringify(byStatus)} · 技能${skillN} · 收藏${favN} · 争议${dispN}`)
}

const dash = (await api('GET', '/admin/dashboard', { token: admin.token })).data
log('\n📊 平台总览：', JSON.stringify(dash))
log('🔎 零工实测数据：')
await snapshot('李建国', worker1)
await snapshot('赵晓燕', worker2)
log(`
══════════════════════════════════════════════════════
 Mock 数据就绪 · 测试账号
   运营端  http://localhost:5174   13800000001 / Admin@123456
   企业端  http://localhost:5173   13700000001 / Company@123
   零工端  微信小程序              13600000001 / Worker@123（李建国 · 已实名）
                                  13600000002 / Worker@123（赵晓燕 · 已实名）
 提示：小程序「我的」页底部可调字体大小（小/标准/大/特大）。
══════════════════════════════════════════════════════`)
