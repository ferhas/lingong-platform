const api = require('../../utils/api.js')

const TYPE_TEXT = {
  frame_sub: '分包协议（框架）',
  sub_order: '分包工单'
}

Page({
  data: {
    list: [],
    detail: null,
    loading: false
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    this.setData({ loading: true })
    try {
      const data = await api.get('/worker/contracts')
      this.setData({
        list: data.list.map(x => ({ ...x, typeText: TYPE_TEXT[x.type] || x.type }))
      })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
    }
  },

  async onView(e) {
    try {
      const detail = await api.get('/worker/contracts/' + e.currentTarget.dataset.id)
      this.setData({ detail: { ...detail, typeText: TYPE_TEXT[detail.type] || detail.type } })
    } catch (err) {}
  },

  onCloseDetail() {
    this.setData({ detail: null })
  }
})
