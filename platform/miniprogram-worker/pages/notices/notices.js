const api = require('../../utils/api.js')

const TYPE_ICON = {
  review: '审', hired: '录', deliver: '交', rejected: '退',
  settle: '结', risk: '险', guide: '引', cancelled: '停', member: '员'
}

Page({
  data: {
    list: [],
    unread: 0,
    loading: false
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    this.setData({ loading: true })
    try {
      const data = await api.get('/me/notifications', { pageSize: 50 })
      this.setData({
        unread: data.unread,
        list: data.list.map(n => ({ ...n, icon: TYPE_ICON[n.type] || '信' }))
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

  async onReadAll() {
    if (!this.data.unread) return
    try {
      await api.post('/me/notifications/read', { ids: 'all' })
      wx.showToast({ title: '已全部标记已读', icon: 'success' })
      this.fetch()
    } catch (e) {}
  },

  async onTapItem(e) {
    const item = this.data.list.find(n => n.id === Number(e.currentTarget.dataset.id))
    if (item && !item.read) {
      try { await api.post('/me/notifications/read', { ids: [item.id] }) } catch (err) {}
      this.fetch()
    }
  }
})
