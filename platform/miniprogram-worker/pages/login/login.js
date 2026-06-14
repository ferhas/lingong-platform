const api = require('../../utils/api.js')

// 体验账号「模拟登录」固定凭据（仅开发态生效，与 server/src/demoSeed.js 一致）：
// 复用 /auth/wechat 的开发态确定性 mock（同一 code → 同一 openid → 命中已造好两月数据的体验零工）。
// 生产环境后端 code2session 走 fail-closed，此入口自然失效；前端也仅在 dev 显示按钮。
const MOCK_CODE = 'demo-worker-2month-001'
const MOCK_PHONE = '13900000001'
const MOCK_PASSWORD = 'Demo@123456'

Page({
  data: {
    mode: 'login', // login | register | bind(微信首登补信息)
    phone: '',
    password: '',
    name: '',
    inviteCode: '',
    agreed: false,
    submitting: false,
    showMock: false // 开发态显示「模拟登录」体验入口
  },

  onLoad() {
    // 仅开发环境暴露体验入口（app.js globalData.env 上线为 'prod'）
    this.setData({ showMock: (getApp().globalData.env || 'dev') === 'dev' })
  },

  // 一键模拟登录：直接进入预置了两个月数据的体验零工账号，免注册/免微信授权
  onMockLogin() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    wx.showLoading({ title: '进入体验账号…' })
    api.post('/auth/wechat', { code: MOCK_CODE })
      .then(data => this.enter(data))
      .catch(async () => {
        // 兜底：若后端已配置真实微信凭据致 mock 失效，则用体验账号手机号+密码登录
        try {
          const d = await api.post('/auth/login', { phone: MOCK_PHONE, password: MOCK_PASSWORD })
          this.enter(d)
        } catch (e) {}
      })
      .finally(() => {
        wx.hideLoading()
        this.setData({ submitting: false })
      })
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  goLegal(e) {
    wx.navigateTo({ url: '/pages/legal/legal?type=' + e.currentTarget.dataset.type })
  },

  requireAgree() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并勾选同意协议', icon: 'none' })
      return false
    }
    return true
  },

  onSwitchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  enter(data) {
    if (data.user.role !== 'worker') {
      return wx.showToast({ title: '请使用零工账号登录', icon: 'none' })
    }
    api.saveSession(data)
    wx.reLaunch({ url: '/pages/index/index' })
    // 登录后检查协议版本，更新过则强制重新同意
    getApp().checkAgreements()
  },

  // 微信一键登录
  onWechatLogin() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    wx.login({
      success: async res => {
        try {
          const data = await api.post('/auth/wechat', { code: res.code })
          this.enter(data)
        } catch (e) {
          if (e.code === 'NEED_BIND' || e.status === 404) {
            wx.showToast({ title: '首次使用，请补充手机号完成注册', icon: 'none', duration: 2000 })
            this.setData({ mode: 'bind' })
          }
        } finally {
          this.setData({ submitting: false })
        }
      },
      fail: () => {
        this.setData({ submitting: false })
        wx.showToast({ title: '微信登录不可用', icon: 'none' })
      }
    })
  },

  // 微信首登：补手机号+姓名完成注册绑定（重新取 code，微信 code 一次性）
  onWechatBind() {
    const { phone, name } = this.data
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
    if (!name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' })
    if (!this.requireAgree()) return
    this.setData({ submitting: true })
    wx.login({
      success: async res => {
        try {
          const data = await api.post('/auth/wechat', { code: res.code, phone, name: name.trim(), agree: true })
          this.enter(data)
        } catch (e) {
        } finally {
          this.setData({ submitting: false })
        }
      },
      fail: () => this.setData({ submitting: false })
    })
  },

  async onSubmit() {
    const { mode, phone, password, name, inviteCode } = this.data
    if (mode === 'bind') return this.onWechatBind()
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
    if (password.length < 10) return wx.showToast({ title: '密码至少10位且含字母和数字', icon: 'none' })
    if (mode === 'register' && !name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' })
    if (mode === 'register' && !this.requireAgree()) return

    this.setData({ submitting: true })
    try {
      let data
      if (mode === 'login') {
        data = await api.post('/auth/login', { phone, password })
      } else {
        const body = { role: 'worker', phone, password, name: name.trim(), agree: true }
        if (inviteCode.trim()) body.inviteCode = inviteCode.trim()
        data = await api.post('/auth/register', body)
      }
      this.enter(data)
    } catch (e) {
    } finally {
      this.setData({ submitting: false })
    }
  }
})
