const api = require('../../utils/api.js')
const fontScale = require('../../utils/fontScale.js')
const theme = require('../../utils/theme.js')

// 信用等级 → ASCII class 后缀（WXSS 选择器不支持中文标识符）
const GRADE_CLASS = { '优选': 'premium', '良好': 'good', '一般': 'normal', '受限': 'limited' }

Page({
  data: {
    profile: null,
    user: null,
    unread: 0,
    fontOptions: fontScale.OPTIONS, // 字体档位：小/标准/大/特大（fsKey/fsScale 由 app.js 全局注入）
    themeOptions: theme.OPTIONS // 深色档位：跟随系统/浅色/深色（themePref/themeClass 由 app.js 全局注入）
  },

  onShow() {
    this.setData({ user: wx.getStorageSync('user') || null })
    this.fetch()
  },

  async fetch() {
    try {
      const [profile, notices] = await Promise.all([
        api.get('/worker/profile'),
        api.get('/me/notifications', { pageSize: 1 })
      ])
      if (profile && profile.credit) {
        profile.credit.gradeClass = GRADE_CLASS[profile.credit.grade] || 'normal'
      }
      this.setData({ profile, unread: notices.unread })
      // 自定义 tabBar：红点通过组件方法驱动（原生 showTabBarRedDot 在 custom 模式下不生效）
      const tb = this.getTabBar && this.getTabBar()
      if (tb) tb.setDot(2, notices.unread > 0)
    } catch (e) {}
  },

  goVerify() {
    wx.navigateTo({ url: '/pages/verify/verify' })
  },

  goBindcard() {
    const p = this.data.profile
    if (!p || !p.verified) {
      return wx.showToast({ title: '请先完成实名认证', icon: 'none' })
    }
    wx.navigateTo({ url: '/pages/bindcard/bindcard' })
  },

  goSkills() {
    wx.navigateTo({ url: '/pages/skills/skills' })
  },

  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' })
  },

  goInsurance() {
    wx.navigateTo({ url: '/pages/insurance/insurance' })
  },

  goSoletraderZone() {
    const p = this.data.profile
    if (!p || !p.verified) {
      return wx.showToast({ title: '请先完成实名认证', icon: 'none' })
    }
    wx.navigateTo({ url: '/pages/soletrader/soletrader' })
  },

  goDisputes() {
    wx.navigateTo({ url: '/pages/disputes/disputes' })
  },

  goTickets() {
    wx.navigateTo({ url: '/pages/tickets/tickets' })
  },

  goHelp() {
    wx.navigateTo({ url: '/pages/help/help' })
  },

  goIncome() {
    wx.navigateTo({ url: '/pages/income/income' })
  },

  goNotices() {
    wx.navigateTo({ url: '/pages/notices/notices' })
  },

  goPassword() {
    wx.navigateTo({ url: '/pages/password/password' })
  },

  onEditName() {
    wx.showModal({
      title: '编辑昵称',
      editable: true,
      placeholderText: '请输入新的昵称',
      content: (this.data.user && this.data.user.name) || '',
      confirmText: '保存',
      success: async res => {
        if (!res.confirm) return
        const name = (res.content || '').trim()
        if (!name) return wx.showToast({ title: '昵称不能为空', icon: 'none' })
        try {
          await api.patch('/worker/profile', { name })
          const user = { ...(wx.getStorageSync('user') || {}), name }
          wx.setStorageSync('user', user)
          this.setData({ user })
          wx.showToast({ title: '已保存', icon: 'success' })
        } catch (e) {}
      }
    })
  },

  onContract() {
    const p = this.data.profile
    if (!p || !p.verified) {
      return wx.showToast({ title: '请先完成实名认证', icon: 'none' })
    }
    wx.navigateTo({ url: '/pages/contracts/contracts' })
  },

  onSoletrader() {
    const p = this.data.profile
    if (!p || !p.verified) {
      return wx.showToast({ title: '请先完成实名认证', icon: 'none' })
    }
    if (p.subjectType === 'soletrader') {
      return wx.showToast({ title: '已登记为个体工商户', icon: 'none' })
    }
    wx.showModal({
      title: '个体工商户登记',
      editable: true,
      placeholderText: '输入统一社会信用代码',
      content: '',
      confirmText: '提交登记',
      success: async res => {
        if (!res.confirm) return
        const licenseNo = (res.content || '').trim().toUpperCase()
        if (!/^[0-9A-Z]{18}$/.test(licenseNo)) return wx.showToast({ title: '请输入18位统一社会信用代码', icon: 'none' })
        try {
          await api.post('/worker/soletrader', { licenseNo })
          wx.showModal({
            title: '登记成功',
            content: '已转入经营所得线（B线）：结算前需向平台上传发票，平台不再代扣个税；如有接单锁定已同步解除。请自行办理经营所得申报。',
            showCancel: false,
            success: () => this.fetch()
          })
        } catch (e) {}
      }
    })
  },

  // 切换字体大小：持久化并就地刷新本页（其它页在 onShow 时由全局包装自动跟随）
  // 注：字号经 page-meta 的 pageStyle 注入，故需同步刷新 pageStyle（含新的 --fs）
  onPickFont(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.fsKey) return
    const scale = fontScale.setKey(key)
    this.setData(Object.assign({ fsKey: key, fsScale: scale }, theme.injectData(scale)))
  },

  // 切换深色模式：持久化并就地刷新本页主题 + 导航栏/窗口背景 + 自定义 tabBar
  // 其它页在 onShow 时由 app.js 全局包装自动跟随
  onPickTheme(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.themePref) return
    theme.setPref(key)
    this.setData(theme.injectData(this.data.fsScale))
    theme.applyChrome()
    const tb = this.getTabBar && this.getTabBar()
    if (tb && tb.syncTheme) tb.syncTheme()
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      success: async res => {
        if (!res.confirm) return
        try { await api.post('/auth/logout') } catch (e) {}
        wx.removeStorageSync('token')
        wx.removeStorageSync('refreshToken')
        wx.removeStorageSync('user')
        wx.reLaunch({ url: '/pages/login/login' })
      }
    })
  }
})
