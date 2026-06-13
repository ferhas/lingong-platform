const api = require('../../utils/api.js')

Page({
  data: {
    profile: null,
    bankCard: '',
    phone: '',
    smsCode: '',
    needSms: false,
    counting: 0,
    submitting: false
  },

  onShow() {
    this.fetchProfile()
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
  },

  async fetchProfile() {
    try {
      const profile = await api.get('/worker/profile')
      this.setData({ profile })
      if (!profile.verified) {
        wx.showToast({ title: '请先完成实名认证', icon: 'none' })
      }
    } catch (e) {}
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  // 获取短信验证码（60s 倒计时；开发态返回 devCode 自动填入）
  async onSendSms() {
    if (this.data.counting > 0) return
    try {
      const r = await api.post('/auth/sms-code', { scene: 'bindcard' })
      wx.showToast({ title: '验证码已发送', icon: 'success' })
      if (r.devCode) this.setData({ smsCode: r.devCode })
      this.startCountdown()
    } catch (e) {}
  },

  startCountdown() {
    this.setData({ counting: 60 })
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      const left = this.data.counting - 1
      this.setData({ counting: left })
      if (left <= 0) clearInterval(this.timer)
    }, 1000)
  },

  async onSubmit() {
    const { bankCard, phone, smsCode, needSms, profile } = this.data
    if (!profile || !profile.verified) return wx.showToast({ title: '请先完成实名认证', icon: 'none' })
    if (!/^\d{15,19}$/.test(bankCard)) return wx.showToast({ title: '银行卡号格式不正确', icon: 'none' })
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确的银行预留手机号', icon: 'none' })
    if (needSms && !smsCode.trim()) return wx.showToast({ title: '请填写短信验证码', icon: 'none' })

    this.setData({ submitting: true })
    try {
      const body = { bankCard, phone }
      if (smsCode.trim()) body.smsCode = smsCode.trim()
      const r = await api.post('/worker/bank-card', body)
      wx.showModal({
        title: '绑卡成功',
        content: `提现卡已绑定：${r.bankCard}\n四要素核验通过，提现将出金至该卡。`,
        showCancel: false,
        success: () => this.fetchProfile()
      })
    } catch (e) {
      // 平台开启短信验证：展示验证码输入并引导获取
      if (e.code === 'SMS_REQUIRED') this.setData({ needSms: true })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
