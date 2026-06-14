const api = require('../../utils/api.js')

Page({
  data: {
    task: null,
    verified: false,
    applying: false
  },

  onLoad(options) {
    this.taskId = options.id
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    try {
      const [task, profile] = await Promise.all([
        api.get('/worker/tasks/' + this.taskId),
        api.get('/worker/profile')
      ])
      this.setData({ task, verified: profile.verified })
    } catch (e) {}
  },

  goVerify() {
    wx.navigateTo({ url: '/pages/verify/verify' })
  },

  async onApply() {
    if (this.data.applying) return
    // 订阅消息授权须在点击手势同步上下文中拉起（不能在 await 之后），故在报名请求前调用
    getApp().requestSubscribe()
    this.setData({ applying: true })
    try {
      await api.post(`/worker/tasks/${this.taskId}/apply`)
      wx.showToast({ title: '报名成功，等待企业确认', icon: 'success' })
      this.fetch()
    } catch (e) {
      // 未实名时引导去认证
      if (e.message && e.message.includes('实名')) {
        setTimeout(() => wx.navigateTo({ url: '/pages/verify/verify' }), 1200)
      }
    } finally {
      this.setData({ applying: false })
    }
  },

  // 取消报名（仅报名中、未被录用时可撤回；对应后端 /worker/tasks/:id/withdraw-apply）
  async onWithdrawApply() {
    if (this.data.applying) return
    this.setData({ applying: true })
    try {
      await api.post(`/worker/tasks/${this.taskId}/withdraw-apply`)
      wx.showToast({ title: '已取消报名', icon: 'success' })
      this.fetch()
    } catch (e) {
    } finally {
      this.setData({ applying: false })
    }
  },

  // 收藏 / 取消收藏
  async onToggleFav() {
    const t = this.data.task
    if (!t) return
    try {
      if (t.favorited) {
        await api.del(`/worker/favorites/${this.taskId}`)
        this.setData({ 'task.favorited': false })
        wx.showToast({ title: '已取消收藏', icon: 'none' })
      } else {
        await api.post(`/worker/favorites/${this.taskId}`)
        this.setData({ 'task.favorited': true })
        wx.showToast({ title: '已收藏', icon: 'success' })
      }
    } catch (e) {}
  }
})
