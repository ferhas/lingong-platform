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
    list: [],
    loading: false
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    this.setData({ loading: true })
    try {
      const data = await api.get('/me/tickets')
      this.setData({
        list: data.list.map(t => ({
          ...t,
          categoryText: CATEGORY_TEXT[t.category] || t.category,
          statusText: STATUS_TEXT[t.status] || t.status
        }))
      })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
      wx.stopPullDownRefresh()
    }
  },

  onPullDownRefresh() {
    this.fetch()
  },

  onNew() {
    wx.navigateTo({ url: '/pages/tickets/new' })
  },

  onTapItem(e) {
    wx.navigateTo({ url: '/pages/tickets/detail?id=' + e.currentTarget.dataset.id })
  }
})
