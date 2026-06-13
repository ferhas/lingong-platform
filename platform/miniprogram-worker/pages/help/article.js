const api = require('../../utils/api.js')

Page({
  data: {
    title: '',
    category: '',
    content: '',
    updatedAt: ''
  },

  async onLoad(options) {
    try {
      const a = await api.get('/me/help/' + options.id)
      wx.setNavigationBarTitle({ title: a.title })
      this.setData({ title: a.title, category: a.category, content: a.content, updatedAt: a.updatedAt })
    } catch (e) {}
  },

  goTickets() {
    wx.navigateTo({ url: '/pages/tickets/tickets' })
  }
})
