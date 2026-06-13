import client from './client'

// 站内通知
export const getNotifications = (page = 1, pageSize = 20, silent = false) =>
  client.get('/me/notifications', { params: { page, pageSize }, silent })
export const markNotificationsRead = ids => client.post('/me/notifications/read', { ids })

// 用户偏好设置
export const getSettings = () => client.get('/me/settings', { silent: true })
export const patchSettings = patch => client.patch('/me/settings', patch, { silent: true })

// 修改密码
export const changePassword = (oldPassword, newPassword) =>
  client.post('/auth/change-password', { oldPassword, newPassword })

// 公开协议文本（注册页免登录查看）：type = tos | privacy
export const getLegalDoc = type => client.get(`/auth/legal/${type}`)

// 协议版本同意（协议更新后登录强制重新同意）
export const getAgreementsStatus = () => client.get('/me/agreements/status', { silent: true })
export const reAgreeAgreements = () => client.post('/me/agreements/re-agree')

// 争议（双方共用：查看 / 举证留言 / 撤回 / 线下升级声明）
export const getDisputes = () => client.get('/me/disputes')
export const getDisputeDetail = id => client.get(`/me/disputes/${id}`)
export const addDisputeEvent = (id, content, attachmentIds = []) =>
  client.post(`/me/disputes/${id}/events`, { content, attachmentIds })
export const withdrawDispute = id => client.post(`/me/disputes/${id}/withdraw`)
export const escalateDispute = id => client.post(`/me/disputes/${id}/escalate`)

// 客服工单
export const createTicket = data => client.post('/me/tickets', data)
export const getTickets = () => client.get('/me/tickets')
export const getTicketDetail = id => client.get(`/me/tickets/${id}`)
export const addTicketMessage = (id, content) => client.post(`/me/tickets/${id}/messages`, { content })
export const closeTicket = id => client.post(`/me/tickets/${id}/close`)
export const rateTicket = (id, satisfaction) => client.post(`/me/tickets/${id}/rate`, { satisfaction })

// 帮助中心
export const getHelpList = keyword =>
  client.get('/me/help', { params: { keyword: keyword || undefined } })
export const getHelpDetail = id => client.get(`/me/help/${id}`)
