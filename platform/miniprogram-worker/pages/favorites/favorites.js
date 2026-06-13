const api = require('../../utils/api.js')

Page({
  data: { list: [], loading: true },

  onShow() { this.fetch() },

  async fetch() {
    this.setData({ loading: true })
    try {
      const d = await api.get('/worker/favorites')
      this.setData({ list: d.list })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
    }
  },

  onTapTask(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.detail.id })
  },

  async onRemove(e) {
    const id = e.currentTarget.dataset.id
    try {
      await api.del('/worker/favorites/' + id)
      this.setData({ list: this.data.list.filter(t => t.id !== id) })
      wx.showToast({ title: '已取消收藏', icon: 'none' })
    } catch (err) {}
  }
})
