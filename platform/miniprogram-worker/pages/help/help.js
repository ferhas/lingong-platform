const api = require('../../utils/api.js')

Page({
  data: {
    keyword: '',
    groups: [],
    total: 0,
    loading: false
  },

  onLoad() {
    this.fetch()
  },

  async fetch() {
    this.setData({ loading: true })
    try {
      const data = await api.get('/me/help', { keyword: this.data.keyword })
      // 按分类分组展示
      const groups = []
      const idx = {}
      for (const a of data.list) {
        if (idx[a.category] === undefined) {
          idx[a.category] = groups.length
          groups.push({ category: a.category, items: [] })
        }
        groups[idx[a.category]].items.push(a)
      }
      this.setData({ groups, total: data.total })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
    }
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    this.fetch()
  },

  onTapArticle(e) {
    wx.navigateTo({ url: '/pages/help/article?id=' + e.currentTarget.dataset.id })
  },

  goTickets() {
    wx.navigateTo({ url: '/pages/tickets/tickets' })
  }
})
