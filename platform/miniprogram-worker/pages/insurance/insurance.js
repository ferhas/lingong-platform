const api = require('../../utils/api.js')

Page({
  data: {
    tab: 'policy',
    policies: [],
    claims: [],
    loading: true
  },

  onShow() { this.fetch() },

  async fetch() {
    this.setData({ loading: true })
    try {
      const [p, c] = await Promise.all([
        api.get('/worker/policies'),
        api.get('/worker/claims')
      ])
      this.setData({ policies: p.list, claims: c.list })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  onReport(e) {
    const taskId = Number(e.currentTarget.dataset.taskid)
    wx.showModal({
      title: '保险一键报案',
      editable: true,
      placeholderText: '简述事故经过（不少于5个字）',
      confirmText: '提交报案',
      success: async res => {
        if (!res.confirm) return
        const description = (res.content || '').trim()
        if (description.length < 5) return wx.showToast({ title: '请描述事故经过（不少于5个字）', icon: 'none' })
        try {
          await api.post('/worker/claims', { taskId, description })
          wx.showModal({
            title: '报案成功',
            content: '已提交报案，平台将协助理赔并通过站内信通知进展，请保留事故相关凭证。',
            showCancel: false,
            success: () => { this.setData({ tab: 'claim' }); this.fetch() }
          })
        } catch (err) {}
      }
    })
  }
})
