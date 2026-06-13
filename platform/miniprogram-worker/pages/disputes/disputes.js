const api = require('../../utils/api.js')

const STATUS_TEXT = {
  negotiating: '协商中',
  arbitrating: '平台仲裁中',
  ruled: '已裁决',
  executed: '已执行',
  closed: '已关闭',
  withdrawn: '已撤回',
  escalated: '线下处理中'
}

const TYPE_TEXT = {
  acceptance: '验收争议',
  payment_overdue: '超期未验收',
  worker_missing: '零工失联',
  quality_after: '结算后质量争议',
  other: '其他'
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
      const data = await api.get('/me/disputes')
      this.setData({
        list: data.list.map(d => ({
          ...d,
          statusText: STATUS_TEXT[d.status] || d.status,
          typeText: TYPE_TEXT[d.type] || d.type
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

  onTapItem(e) {
    wx.navigateTo({ url: '/pages/disputes/detail?id=' + e.currentTarget.dataset.id })
  }
})
