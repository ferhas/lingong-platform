import client from './client'

// 企业档案与资金
export const getProfile = () => client.get('/company/profile')
export const patchProfile = data => client.patch('/company/profile', data)
export const recharge = amount => client.post('/company/recharge', { amount })
export const getFlows = (page = 1, pageSize = 20) =>
  client.get('/company/flows', { params: { page, pageSize } })

// 充值单收银台（商用充值流程：创建充值单 → 对公转账 → 银行入金回调到账）
export const createRechargeOrder = amount => client.post('/company/recharge-orders', { amount })
export const getRechargeOrders = () => client.get('/company/recharge-orders')
// 模拟入金（仅开发态可用，生产由存管银行回调驱动）
export const mockPayRechargeOrder = no => client.post(`/company/recharge-orders/${no}/mock-pay`)

// 电子签静默签授权（一次性，授权后工单自动静默签署）
export const esignAuth = () => client.post('/company/esign-auth')

// 企业月结单（对账单）
export const getStatement = period => client.get('/company/statement', { params: { period } })

// 零工邀请码（owner/operator 可见，finance 调用将 403，静默失败）
export const getInviteCode = () => client.get('/company/invite-code', { silent: true })

// 发布元数据（类目/计酬方式，动态读取；失败由调用方回退默认值）
export const getCompanyMeta = () => client.get('/company/meta', { silent: true })

// 任务
export const publishTask = data => client.post('/company/tasks', data)
// 批量发单（≤50 条，逐行返回成败结果）
export const batchPublishTasks = items => client.post('/company/tasks/batch', { items })
export const getTasks = ({ status, keyword, page = 1, pageSize = 20 } = {}) =>
  client.get('/company/tasks', { params: { status, keyword: keyword || undefined, page, pageSize } })
export const getTaskDetail = id => client.get(`/company/tasks/${id}`)
export const hireWorker = (id, workerId) => client.post(`/company/tasks/${id}/hire`, { workerId })
// 验收结算：错误提示由 Tasks.vue 按错误码分支处理（SETTLE_PENDING / SETTLING）
export const acceptTask = id => client.post(`/company/tasks/${id}/accept`, null, { silent: true })
export const rejectTask = (id, reason) => client.post(`/company/tasks/${id}/reject`, { reason })
export const cancelTask = id => client.post(`/company/tasks/${id}/cancel`)

// 派单（定向派单）：候选零工为历史合作或本企业邀请的零工
export const getDispatchCandidates = keyword =>
  client.get('/company/dispatch/candidates', { params: { keyword: keyword || undefined } })
export const dispatchTask = (id, workerId, note) =>
  client.post(`/company/tasks/${id}/dispatch`, { workerId, note: note || undefined })

// 争议：企业发起（零工失联 / 结算后质量争议 / 其他）
export const createDispute = (id, data) => client.post(`/company/tasks/${id}/dispute`, data)

// 评价（结算后互盲互评，影响零工信用分）
export const reviewTask = (id, data) => client.post(`/company/tasks/${id}/review`, data)
export const getTaskReviews = id => client.get(`/company/tasks/${id}/reviews`)

// 统计（仪表盘图表）
export const getStatsTrend = (days = 30) =>
  client.get('/company/stats/trend', { params: { days } })

// 成员管理（仅 owner）
export const getMembers = () => client.get('/company/members')
export const addMember = data => client.post('/company/members', data)
export const changeMemberRole = (userId, memberRole) =>
  client.patch(`/company/members/${userId}`, { memberRole })
export const disableMember = userId => client.delete(`/company/members/${userId}`)
// 转移企业所有权（仅 owner）：解决"owner 不可停用、一旦不可用企业即瘫痪"的死结（与 admin 停用 owner 的提示配套）
export const transferOwner = userId => client.post(`/company/members/${userId}/transfer-owner`)

// 发布前税负测算（输入中实时预览，静默失败不打扰）
export const getEstimate = (price, category) =>
  client.get('/company/estimate', { params: { price, category: category || undefined }, silent: true })

// 发票与合同（分页）
export const getInvoices = (page = 1, pageSize = 20) =>
  client.get('/company/invoices', { params: { page, pageSize } })
export const getContracts = (page = 1, pageSize = 20) =>
  client.get('/company/contracts', { params: { page, pageSize } })
export const getContractDetail = id => client.get(`/company/contracts/${id}`)
