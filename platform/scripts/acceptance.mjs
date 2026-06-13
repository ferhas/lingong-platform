// 验收脚本：对运行中的 API 服务执行完整业务流,构造真实可登录的验收数据
// 用法：node scripts/acceptance.mjs [baseUrl]
const BASE = (process.argv[2] || 'http://127.0.0.1:3000') + '/api/v1'

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

async function loginOrRegister(body) {
  let r = await api('POST', '/auth/login', { body: { phone: body.phone, password: body.password } })
  if (r.status !== 200) r = await api('POST', '/auth/register', { body: { agree: true, ...body } })
  if (!r.data?.token) throw new Error(`账号 ${body.phone} 登录/注册失败: ${JSON.stringify(r.data)}`)
  return r.data
}

const log = (...a) => console.log(...a)

// —— 账号 ——
const admin = await loginOrRegister({ phone: '13800000001', password: 'Admin@123456' })
log('✓ 运营管理员登录')

const company = await loginOrRegister({
  role: 'company', phone: '13700000001', password: 'Company@123', name: '王经理',
  companyName: '杭州云栖电商科技有限公司', licenseNo: '91330106MA2KXT4L0K', industry: '电商零售'
})
const badCompany = await loginOrRegister({
  role: 'company', phone: '13700000002', password: 'Company@123', name: '张老板',
  companyName: '某建筑劳务有限公司', licenseNo: '91110000JZ00000001', industry: '建筑劳务分包'
})
log('✓ 企业账号就绪（13700000001 / Company@123）')

const worker = await loginOrRegister({ role: 'worker', phone: '13600000001', password: 'Worker@123', name: '李建国', agree: true })
const worker2 = await loginOrRegister({ role: 'worker', phone: '13600000002', password: 'Worker@123', name: '赵晓燕', agree: true })
log('✓ 零工账号就绪（13600000001 / Worker@123）')

// —— 运营审核 ——
const companies = (await api('GET', '/admin/companies?status=pending', { token: admin.token })).data.list
for (const c of companies) {
  if (c.industry === '建筑劳务分包') {
    await api('POST', `/admin/companies/${c.id}/review`, { token: admin.token, body: { pass: false, note: '命中行业负面清单：建筑劳务分包' } })
    log(`✓ 拒绝准入：${c.companyName}`)
  } else {
    const r = await api('POST', `/admin/companies/${c.id}/review`, { token: admin.token, body: { pass: true, note: '资质齐全，准入通过' } })
    log(`✓ 准入通过：${c.companyName}（总承揽合同 ${r.data.masterContractNo}）`)
  }
}

// —— 实名 ——
const p1 = await api('GET', '/worker/profile', { token: worker.token })
if (!p1.data.verified) {
  await api('POST', '/worker/verify', { token: worker.token, body: { realName: '李建国', idCard: '330106199001011235', bankCard: '6217000000006217' } })
  log('✓ 李建国实名+签署分包协议')
}
const p2 = await api('GET', '/worker/profile', { token: worker2.token })
if (!p2.data.verified) {
  await api('POST', '/worker/verify', { token: worker2.token, body: { realName: '赵晓燕', idCard: '330106199202022346', bankCard: '6228000000006228' } })
  log('✓ 赵晓燕实名+签署分包协议')
}

// —— 充值与发单 ——
await api('POST', '/company/recharge', { token: company.token, body: { amount: 100000 } })
log('✓ 企业存管户充值 ¥100,000')

const TASKS = [
  { title: '电商主图设计（10张）', category: '设计', payMethod: '按成果', price: 1500, deadline: '2026-06-25', description: '为新上架的家居类目商品设计10张电商主图，风格简洁明亮，需提供PSD源文件。', standard: '尺寸800x800；提供PSD分层源文件；验收后结算。' },
  { title: '英文产品手册翻译（约8000词）', category: '翻译', payMethod: '按成果', price: 2400, deadline: '2026-06-28', description: '智能家居产品英文说明书翻译为中文，要求术语准确、语句通顺。', standard: '术语表统一；交付Word文档；错译率低于1%。' },
  { title: '短视频剪辑（20条）', category: '视频', payMethod: '按件', price: 3000, deadline: '2026-06-30', description: '提供素材，剪辑成适合视频号投放的竖屏短视频，含字幕与转场。', standard: '1080P竖屏；每条不超过60秒；按验收合格条数计酬。' },
  { title: '小程序商城前端开发', category: '技术', payMethod: '按成果', price: 8000, deadline: '2026-07-15', description: '根据UI设计稿开发点餐小程序前端，对接现有后端接口，含购物车、下单、会员中心。', standard: '还原度95%以上；主流程无阻断性bug；代码交付指定仓库。' },
  { title: '产品宣传文案撰写（5篇）', category: '文案', payMethod: '按件', price: 1000, deadline: '2026-06-20', description: '撰写5篇护肤产品种草文案，原创且通过查重。', standard: '每篇600-800字；原创度90%以上。' }
]

const existing = (await api('GET', '/company/tasks?pageSize=50', { token: company.token })).data
if (existing.total === 0) {
  const ids = []
  for (const t of TASKS) {
    const r = await api('POST', '/company/tasks', { token: company.token, body: t })
    if (r.status !== 201) throw new Error('发单失败: ' + JSON.stringify(r.data))
    ids.push(r.data.id)
    log(`✓ 发布：${t.title}（工单 ${r.data.workOrderNo}）`)
  }

  // 任务1：李建国 全流程结算
  await api('POST', `/worker/tasks/${ids[0]}/apply`, { token: worker.token })
  await api('POST', `/worker/tasks/${ids[0]}/apply`, { token: worker2.token })
  await api('POST', `/company/tasks/${ids[0]}/hire`, { token: company.token, body: { workerId: worker.user.id } })
  await api('POST', `/worker/orders/${ids[0]}/deliver`, { token: worker.token, body: { note: '10张主图成品+PSD源文件（网盘链接）' } })
  const settle = await api('POST', `/company/tasks/${ids[0]}/accept`, { token: company.token })
  log(`✓ 任务1已结算：确认单 ${settle.data.confirmNo}，发票 ${settle.data.invoice.no}，零工实发 ¥${settle.data.settlement.workerNet}`)

  // 任务2：赵晓燕 进行中
  await api('POST', `/worker/tasks/${ids[1]}/apply`, { token: worker2.token })
  await api('POST', `/company/tasks/${ids[1]}/hire`, { token: company.token, body: { workerId: worker2.user.id } })
  log('✓ 任务2进行中（赵晓燕已录用）')

  // 任务3：李建国 待验收
  await api('POST', `/worker/tasks/${ids[2]}/apply`, { token: worker.token })
  await api('POST', `/company/tasks/${ids[2]}/hire`, { token: company.token, body: { workerId: worker.user.id } })
  await api('POST', `/worker/orders/${ids[2]}/deliver`, { token: worker.token, body: { note: '前10条成片（链接），余下10条明日交付' } })
  log('✓ 任务3待验收（李建国已交付）')

  // 任务4/5：报名中
  await api('POST', `/worker/tasks/${ids[4]}/apply`, { token: worker2.token })
  log('✓ 任务4/5报名中')

  // 提现
  await api('POST', '/worker/withdraw', { token: worker.token, body: { amount: 500 } })
  log('✓ 李建国提现 ¥500')
} else {
  log(`· 已有 ${existing.total} 个任务，跳过造数`)
}

// —— 汇总 ——
const dash = (await api('GET', '/admin/dashboard', { token: admin.token })).data
log('\n📊 平台总览：', JSON.stringify(dash))
log(`
══════════════════════════════════════
 验收账号
   运营端 http://localhost:5174  13800000001 / Admin@123456
   企业端 http://localhost:5173  13700000001 / Company@123
   零工端 小程序                  13600000001 / Worker@123（已实名）
                                 13600000002 / Worker@123（已实名）
══════════════════════════════════════`)
