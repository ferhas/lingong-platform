const api = require('../../utils/api.js')

const CATEGORIES = [
  { key: 'account', label: '账号问题' },
  { key: 'realname', label: '实名认证' },
  { key: 'settlement', label: '结算问题' },
  { key: 'withdraw', label: '提现问题' },
  { key: 'invoice', label: '发票问题' },
  { key: 'tax', label: '税务咨询' },
  { key: 'insurance', label: '保险理赔' },
  { key: 'complaint', label: '投诉举报' },
  { key: 'other', label: '其他' }
]

Page({
  data: {
    categories: CATEGORIES,
    categoryIndex: 0,
    title: '',
    content: '',
    submitting: false
  },

  onCategory(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  async onSubmit() {
    const { categories, categoryIndex, title, content } = this.data
    if (title.trim().length < 2) return wx.showToast({ title: '请填写问题标题（不少于2个字）', icon: 'none' })
    if (content.trim().length < 5) return wx.showToast({ title: '请描述问题（不少于5个字）', icon: 'none' })

    this.setData({ submitting: true })
    try {
      const r = await api.post('/me/tickets', {
        category: categories[categoryIndex].key,
        title: title.trim(),
        content: content.trim()
      })
      wx.showModal({
        title: '工单已提交',
        content: `工单编号：${r.no}\n${r.priority === 'urgent' ? '已标记为紧急工单，客服将在2小时内首响。' : '客服将尽快处理，进展会通过消息中心通知您。'}`,
        showCancel: false,
        success: () => wx.navigateBack()
      })
    } catch (e) {
    } finally {
      this.setData({ submitting: false })
    }
  }
})
