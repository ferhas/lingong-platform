import client from './client'

// —— 认证 ——
export const login = data => client.post('/auth/login', data)
export const loginTotp = data => client.post('/auth/totp', data)
export const logout = () => client.post('/auth/logout')
export const getMe = () => client.get('/auth/me')
export const changePassword = data => client.post('/auth/change-password', data)

// —— 站内通知 ——
export const getNotifications = params => client.get('/me/notifications', { params })
export const readNotifications = ids => client.post('/me/notifications/read', { ids })

// —— 用户偏好设置 ——
export const getSettings = () => client.get('/me/settings', { silent: true })
export const patchSettings = data => client.patch('/me/settings', data, { silent: true })

// —— 运营总览 ——
export const getDashboard = () => client.get('/admin/dashboard')
export const getStatsTrend = (days = 30) => client.get('/admin/stats/trend', { params: { days } })

// —— 企业准入 ——
export const getCompanies = (status = 'all') =>
  client.get('/admin/companies', { params: { status } })
export const reviewCompany = (id, data) =>
  client.post(`/admin/companies/${id}/review`, data)
export const getCompanyDetail = id => client.get(`/admin/companies/${id}/detail`)
export const getCompanyEvidencePack = id =>
  client.get(`/admin/companies/${id}/evidence-pack`, { timeout: 60000 })

// —— 零工管理 ——
export const getWorkers = params => client.get('/admin/workers', { params })
export const getWorkerDetail = id => client.get(`/admin/workers/${id}/detail`)
export const lockWorker = (id, lock) => client.post(`/admin/workers/${id}/lock`, { lock })

// —— 运营用户与角色 ——
export const getRoles = () => client.get('/admin/roles')
export const getPermissions = () => client.get('/admin/permissions')
// 角色/账号管理为高敏操作：已绑定 2FA 的账号须 step-up 二次验证（X-TOTP-Code），故透传 totp 并走 silent
export const createRole = (data, totp) => client.post('/admin/roles', data, stepUpConfig(totp))
export const updateRole = (id, data, totp) => client.patch(`/admin/roles/${id}`, data, stepUpConfig(totp))
export const deleteRole = (id, totp) => client.delete(`/admin/roles/${id}`, stepUpConfig(totp))
export const getAdminUsers = params => client.get('/admin/users', { params })
export const createAdminUser = (data, totp) => client.post('/admin/users', data, stepUpConfig(totp))
export const updateUserRole = (id, roleId, totp) => client.patch(`/admin/users/${id}/role`, { roleId }, stepUpConfig(totp))
export const disableUser = (id, totp) => client.post(`/admin/users/${id}/disable`, {}, stepUpConfig(totp))
export const enableUser = (id, totp) => client.post(`/admin/users/${id}/enable`, {}, stepUpConfig(totp))
export const resetUserPassword = (id, totp) => client.post(`/admin/users/${id}/reset-password`, {}, stepUpConfig(totp))

// —— 业务参数配置 ——
export const getConfigs = () => client.get('/admin/configs')
export const updateConfig = (key, value) => client.patch(`/admin/configs/${encodeURIComponent(key)}`, { value })

// —— 协议与文书 ——
export const getLegalDocs = () => client.get('/admin/legal')
export const updateLegalDoc = (type, content, totp) =>
  client.patch(`/admin/legal/${type}`, { content }, stepUpConfig(totp))

// —— 抽查回访 ——
export const sampleCallbacks = () => client.post('/admin/callbacks/sample')
export const getCallbacks = (status = 'all') => client.get('/admin/callbacks', { params: { status } })
export const resolveCallback = (id, data) => client.post(`/admin/callbacks/${id}/resolve`, data)

// —— 保险理赔 ——
export const getClaims = () => client.get('/admin/claims')
export const processClaim = (id, data) => client.post(`/admin/claims/${id}/process`, data)

// —— 发票管理 ——
export const getInvoices = params => client.get('/admin/invoices', { params })
// 红冲为不可撤销高敏操作，须 step-up 二次验证（X-TOTP-Code）
export const voidInvoice = (id, reason, totp) => client.post(`/admin/invoices/${id}/void`, { reason }, stepUpConfig(totp))
// 红冲后重开（关联原发票留痕）：补齐红冲→重开闭环，避免红冲后只能走线下重申
export const reissueInvoice = (id, totp) => client.post(`/admin/invoices/${id}/reissue`, null, stepUpConfig(totp))

// —— 防员转零:企业历史发薪名单 ——
export const getCompanyPayroll = id => client.get(`/admin/companies/${id}/payroll`)
export const uploadCompanyPayroll = (id, names) => client.post(`/admin/companies/${id}/payroll`, { names })

// —— 同IP多账号关联 ——
export const getIpGraph = () => client.get('/admin/risk/ip-graph')

// —— 审计日志 ——
export const getAuditLogs = params => client.get('/admin/audit-logs', { params })
export const getAuditActions = () => client.get('/admin/audit-logs/actions')

// —— 风控预警 ——
export const getRiskAlerts = (status = 'all') =>
  client.get('/admin/risk/alerts', { params: { status } })
export const resolveRiskAlert = (id, data) =>
  client.post(`/admin/risk/alerts/${id}/resolve`, data)

// —— 税务工作台 ——
export const getTaxOverview = () => client.get('/admin/tax/overview')
export const declareTax = (period, totp) => client.post('/admin/tax/declare', { period }, stepUpConfig(totp))
export const quarterReport = (period, totp) => client.post('/admin/tax/quarter-report', { period }, stepUpConfig(totp))
// 季度涉税信息按所得类型分类汇总（连续性劳务报酬/其他劳务报酬/经营所得）
export const getQuarterSummary = quarter =>
  client.get('/admin/tax/quarter-summary', { params: { quarter: quarter || undefined } })
export const getTaxInputOverview = () => client.get('/admin/tax/input-overview')
// 平台初始报送:409(已报送)由页面自行处理,走 silent 不弹全局错误
export const platformReport = () => client.post('/admin/tax/platform-report', {}, { silent: true })

// —— 证据链归档 ——
export const getArchives = params => client.get('/admin/archives', { params })

// —— 外部接口健康 ——
export const getIntegrations = () => client.get('/admin/integrations')

// —— 全平台资金流水 ——
export const getFlows = params => client.get('/admin/flows', { params })

// —— 自动对账 ——
export const getReconciliation = () => client.get('/admin/reconciliation')

// —— 资金单据(提现单 / 结算单) ——
export const getWithdrawals = params => client.get('/admin/withdrawals', { params })
export const getSettlements = params => client.get('/admin/settlements', { params })

/**
 * step-up 敏感接口的请求配置:silent(错误由 withStepUp 兜底提示),
 * 复验时把 6 位动态码放入 X-TOTP-Code 头
 */
const stepUpConfig = totp => ({
  silent: true,
  headers: totp ? { 'X-TOTP-Code': totp } : undefined
})

// —— 争议仲裁 ——
export const getDisputes = params => client.get('/admin/disputes', { params })
export const getDisputeDetail = id => client.get(`/admin/disputes/${id}`)
export const acceptDispute = id => client.post(`/admin/disputes/${id}/accept`)
export const ruleDispute = (id, data, totp) =>
  client.post(`/admin/disputes/${id}/rule`, data, stepUpConfig(totp))
export const executeDispute = (id, totp) =>
  client.post(`/admin/disputes/${id}/execute`, {}, stepUpConfig(totp))

// —— 客服工单 ——
export const getTickets = params => client.get('/admin/tickets', { params })
export const getTicketDetail = id => client.get(`/admin/tickets/${id}`)
export const assignTicket = (id, assigneeId) =>
  client.post(`/admin/tickets/${id}/assign`, { assigneeId })
export const replyTicket = (id, content) => client.post(`/admin/tickets/${id}/reply`, { content })
export const resolveTicket = (id, note) => client.post(`/admin/tickets/${id}/resolve`, { note })

// —— 财务报表中心 ——
export const getFinanceDaily = day => client.get('/admin/finance/daily', { params: { day } })
export const getFinanceMonthly = period =>
  client.get('/admin/finance/monthly', { params: { period } })
export const getSettlementDetail = period =>
  client.get('/admin/finance/settlement-detail', { params: { period } })
export const getCompanyStatement = (companyId, period) =>
  client.get('/admin/finance/company-statement', { params: { companyId, period } })

// —— 导出审批(PIPL) ——
export const applyExport = data => client.post('/admin/exports', data)
export const getExports = () => client.get('/admin/exports')
export const approveExport = (id, data, totp) =>
  client.post(`/admin/exports/${id}/approve`, data, stepUpConfig(totp))

// —— 回调事件监控 ——
export const getWebhookEvents = params => client.get('/admin/webhook-events', { params })
export const replayWebhookEvent = id => client.post(`/admin/webhook-events/${id}/replay`)
export const getIntegrationCalls = params => client.get('/admin/integration-calls', { params })

// —— 消息模板与外发日志 ——
export const getMessageTemplates = () => client.get('/admin/message-templates')
export const updateMessageTemplate = (code, data) =>
  client.patch(`/admin/message-templates/${encodeURIComponent(code)}`, data)
export const getMessageLogs = params => client.get('/admin/message-logs', { params })

// —— 帮助中心管理 ——
export const getHelpArticles = () => client.get('/admin/help-articles')
export const createHelpArticle = data => client.post('/admin/help-articles', data)
export const updateHelpArticle = (id, data) => client.patch(`/admin/help-articles/${id}`, data)

// —— 技能认证审核 ——
export const getSkills = params => client.get('/admin/skills', { params })
export const reviewSkill = (id, data) => client.post(`/admin/skills/${id}/review`, data)

// —— 进项发票台账 ——
export const getInputInvoices = params => client.get('/admin/input-invoices', { params })
export const verifyInputInvoice = (id, data) =>
  client.post(`/admin/input-invoices/${id}/verify`, data)

// —— 对账差异工作台 ——
export const getReconDiffs = params => client.get('/admin/recon-diffs', { params })
export const resolveReconDiff = (id, note) =>
  client.post(`/admin/recon-diffs/${id}/resolve`, { note })

// —— 结算治理(人工重推 / 应急开关) ——
export const retrySettlement = (id, totp) =>
  client.post(`/admin/settlements/${id}/retry`, {}, stepUpConfig(totp))
export const setFundSwitches = (data, totp) =>
  client.post('/admin/fund-switches', data, stepUpConfig(totp))

// —— 系统健康 ——
export const getSystemHealth = () => client.get('/admin/system-health')

// —— 2FA(账号安全) ——
export const setup2fa = () => client.post('/admin/2fa/setup', {}, { silent: true })
export const enable2fa = code => client.post('/admin/2fa/enable', { code })
export const disable2fa = code => client.post('/admin/2fa/disable', { code })

// —— 零工完整 PII(user:read_pii 专项权限) ——
export const getWorkerPii = id => client.get(`/admin/workers/${id}/pii`)

// —— 防员转零白名单豁免 ——
export const exemptPayrollName = (companyId, data) =>
  client.post(`/admin/companies/${companyId}/payroll/exempt`, data)

// —— 税务申报辅助 ——
export const fillDeclarationReceipt = (id, receiptNo, totp) =>
  client.post(`/admin/tax/declarations/${id}/receipt`, { receiptNo }, stepUpConfig(totp))

// —— 开放 API 凭据 ——
export const getApiCredentials = () => client.get('/admin/api-credentials')
export const createApiCredential = (data, totp) =>
  client.post('/admin/api-credentials', data, stepUpConfig(totp))
export const disableApiCredential = id => client.post(`/admin/api-credentials/${id}/disable`)
// 重新启用（误停用/暂停后恢复，授权类操作需 step-up）：补齐 active↔disabled 双向
export const enableApiCredential = (id, totp) => client.post(`/admin/api-credentials/${id}/enable`, null, stepUpConfig(totp))
