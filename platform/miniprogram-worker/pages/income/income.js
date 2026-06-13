const api = require('../../utils/api.js')

Page({
  data: {
    income: null,
    monthly: [],
    withdrawals: [],
    // 提现弹窗（支持短信验证码流程）
    showWithdraw: false,
    wdAmount: '',
    wdSmsCode: '',
    wdNeedSms: false,
    wdCounting: 0,
    wdSubmitting: false
  },

  onShow() {
    this.fetch()
  },

  onUnload() {
    if (this.wdTimer) clearInterval(this.wdTimer)
  },

  async fetch() {
    try {
      const [income, monthly, wd] = await Promise.all([
        api.get('/worker/income'),
        api.get('/worker/income/monthly'),
        api.get('/worker/withdrawals')
      ])
      const max = Math.max(1, ...monthly.list.map(m => m.net))
      this.setData({
        income,
        monthly: monthly.list.map(m => ({
          ...m,
          pct: Math.round(m.net / max * 100),
          label: m.period.slice(5) + '月'
        })),
        withdrawals: wd.list.slice(0, 5)
      })
    } catch (e) {}
  },

  onWithdraw() {
    this.setData({ showWithdraw: true, wdAmount: '', wdSmsCode: '', wdNeedSms: false })
  },

  onCloseWithdraw() {
    this.setData({ showWithdraw: false })
  },

  onWdInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  // 获取提现短信验证码（60s 倒计时；开发态自动填入 devCode）
  async onWdSendSms() {
    if (this.data.wdCounting > 0) return
    try {
      const r = await api.post('/auth/sms-code', { scene: 'withdraw' })
      wx.showToast({ title: '验证码已发送', icon: 'success' })
      if (r.devCode) this.setData({ wdSmsCode: r.devCode })
      this.setData({ wdCounting: 60 })
      if (this.wdTimer) clearInterval(this.wdTimer)
      this.wdTimer = setInterval(() => {
        const left = this.data.wdCounting - 1
        this.setData({ wdCounting: left })
        if (left <= 0) clearInterval(this.wdTimer)
      }, 1000)
    } catch (e) {}
  },

  async onWdSubmit() {
    const { wdAmount, wdSmsCode, wdNeedSms } = this.data
    const amount = Number(wdAmount)
    if (!amount || amount <= 0) return wx.showToast({ title: '请输入有效金额', icon: 'none' })
    if (wdNeedSms && !wdSmsCode.trim()) return wx.showToast({ title: '请填写短信验证码', icon: 'none' })

    this.setData({ wdSubmitting: true })
    try {
      const body = { amount }
      if (wdSmsCode.trim()) body.smsCode = wdSmsCode.trim()
      await api.post('/worker/withdraw', body)
      this.setData({ showWithdraw: false })
      wx.showToast({ title: '提现申请已受理，T+1到账', icon: 'success' })
      this.fetch()
    } catch (err) {
      // 平台开启短信验证：展示验证码输入并引导获取
      if (err.code === 'SMS_REQUIRED') this.setData({ wdNeedSms: true })
      // WITHDRAWAL_PAUSED 等错误已由统一请求层 toast 提示通道维护
    } finally {
      this.setData({ wdSubmitting: false })
    }
  },

  goSoletrader() {
    wx.navigateTo({ url: '/pages/soletrader/soletrader' })
  },

  async onVoucher() {
    const year = new Date().getFullYear() - 1
    try {
      const v = await api.get('/worker/tax/voucher', { year })
      if (!v.items.length) {
        return wx.showToast({ title: `${year}年度暂无扣缴记录`, icon: 'none' })
      }
      wx.showModal({
        title: `${year}年度扣缴凭证`,
        content: `年度劳务报酬合计：¥${v.totalGross}\n年度已预扣个税：¥${v.totalTax}\n\n可用于个人综合所得汇算清缴（跨平台收入合并申报）。`,
        showCancel: false
      })
    } catch (e) {}
  }
})
