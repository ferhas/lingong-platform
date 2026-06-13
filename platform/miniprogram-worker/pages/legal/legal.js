const api = require('../../utils/api.js')

Page({
  data: {
    title: '',
    version: '',
    content: ''
  },

  async onLoad(options) {
    const type = options.type === 'privacy' ? 'privacy' : 'tos'
    try {
      const doc = await api.get('/auth/legal/' + type)
      wx.setNavigationBarTitle({ title: doc.title })
      this.setData({ title: doc.title, version: doc.version, content: doc.content })
    } catch (e) {}
  }
})
