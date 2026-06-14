const api = require('../../utils/api.js')

const CATEGORY_TEXT = {
  account: '账号',
  realname: '实名认证',
  settlement: '结算',
  withdraw: '提现',
  invoice: '发票',
  tax: '税务',
  insurance: '保险',
  complaint: '投诉举报',
  other: '其他'
}

const STATUS_TEXT = {
  open: '待受理',
  pending_user: '待我回复',
  pending_agent: '客服处理中',
  resolved: '已解决',
  closed: '已关闭'
}

Page({
  data: {
    id: 0,
    detail: null,
    reply: '',
    sending: false,
    rateScore: 0
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) })
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    try {
      const t = await api.get('/me/tickets/' + this.data.id)
      this.setData({
        detail: {
          ...t,
          categoryText: CATEGORY_TEXT[t.category] || t.category,
          statusText: STATUS_TEXT[t.status] || t.status,
          active: !['resolved', 'closed'].includes(t.status),
          canRate: ['resolved', 'closed'].includes(t.status) && !t.satisfaction
        }
      })
    } catch (e) {}
  },

  onReplyInput(e) {
    this.setData({ reply: e.detail.value })
  },

  async onSend() {
    const content = this.data.reply.trim()
    if (!content) return wx.showToast({ title: '请输入回复内容', icon: 'none' })
    this.setData({ sending: true })
    try {
      await api.post(`/me/tickets/${this.data.id}/messages`, { content })
      this.setData({ reply: '' })
      this.fetch()
    } catch (e) {
    } finally {
      this.setData({ sending: false })
    }
  },

  onClose() {
    wx.showModal({
      title: '关闭工单',
      content: '问题已解决？关闭后如有新问题需重新创建工单。',
      confirmText: '关闭工单',
      success: async res => {
        if (!res.confirm) return
        try {
          await api.post(`/me/tickets/${this.data.id}/close`)
          wx.showToast({ title: '工单已关闭', icon: 'success' })
          this.fetch()
        } catch (e) {}
      }
    })
  },

  // 满意度星级评价（1-5）：先回显选中星级，再提交
  async onRate(e) {
    const satisfaction = Number(e.currentTarget.dataset.score)
    this.setData({ rateScore: satisfaction })
    try {
      await api.post(`/me/tickets/${this.data.id}/rate`, { satisfaction })
      wx.showToast({ title: '感谢您的评价', icon: 'success' })
      this.fetch()
    } catch (err) {}
  }
})
