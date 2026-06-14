const api = require('../../utils/api.js')

Page({
  data: {
    profile: null,
    guide: null,
    invoices: [],
    loading: true
  },

  onShow() { this.fetch() },

  async fetch() {
    this.setData({ loading: true })
    try {
      const [profile, income] = await Promise.all([
        api.get('/worker/profile'),
        api.get('/worker/income')
      ])
      const next = { profile, guide: income.soletraderGuide, invoices: [] }
      if (profile.subjectType === 'soletrader') {
        const inv = await api.get('/worker/invoices')
        next.invoices = inv.list
      }
      this.setData(next)
    } catch (e) {
    } finally {
      this.setData({ loading: false })
    }
  },

  goVerify() {
    wx.navigateTo({ url: '/pages/verify/verify' })
  },

  onRegister() {
    const p = this.data.profile
    if (!p || !p.verified) return wx.showToast({ title: '请先完成实名认证', icon: 'none' })
    wx.showModal({
      title: '个体工商户登记',
      editable: true,
      placeholderText: '输入统一社会信用代码',
      confirmText: '提交登记',
      success: async res => {
        if (!res.confirm) return
        const licenseNo = (res.content || '').trim().toUpperCase()
        if (!/^[0-9A-Z]{18}$/.test(licenseNo)) return wx.showToast({ title: '请输入18位统一社会信用代码', icon: 'none' })
        try {
          await api.post('/worker/soletrader', { licenseNo })
          wx.showModal({
            title: '登记成功',
            content: '已转入经营所得线（B线）：结算前需向平台上传发票，平台不再代扣个税；接单锁定（如有）已解除。请自行办理经营所得申报。',
            showCancel: false,
            success: () => this.fetch()
          })
        } catch (e) {}
      }
    })
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  }
})
