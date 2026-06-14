// 环境配置：开发联调用局域网 IP；上线前把 ENV 改为 'prod' 并填入 HTTPS 正式域名，
// 同时在微信小程序后台「开发-服务器域名」配置 request/uploadFile 合法域名（必须 HTTPS）。
const ENV = 'dev' // 上线改为 'prod'
// dev：开发者工具「模拟器」跑在本机，用 127.0.0.1 最稳（已 urlCheck:false 不校验合法域名）。
// 真机调试（手机与电脑同一 WiFi）时改成本机局域网 IP，并放行防火墙 3000 入站，例如：
//   dev: 'http://192.168.100.110:3000/api/v1'
const API_BASES = {
  dev: 'http://127.0.0.1:3000/api/v1',
  prod: 'https://api.your-domain.com/api/v1' // TODO: 替换为正式域名
}

const api = require('./utils/api.js')
const fontScale = require('./utils/fontScale.js')
const theme = require('./utils/theme.js')

// 全局注入：字体大小 + 深色主题。劫持 Page 构造器，给每个页面 data 注入 fsScale/fsKey 与
// themeClass/themePref/pageStyle，并在 onShow 时按最新设置刷新（设置页改完返回即时生效）。
// 配合各页 <page-meta page-style="{{pageStyle}}"> 与根节点 <view class="theme-root {{themeClass}}">。
// 失败兜底：注入失效时 wxss 的 var(--fs,1) 回落正常字号、缺省类回落浅色，不影响功能。
// 无需登录态即可访问的公开页（登录页 / 公开协议页）；其余页面进入前要求本地有 token
const PUBLIC_PAGES = ['pages/login/login', 'pages/legal/legal']

function injectAll() {
  const fs = fontScale.injectData()
  return Object.assign({}, fs, theme.injectData(fs.fsScale))
}

const originalPage = Page
Page = function (options) {
  options.data = Object.assign({}, injectAll(), options.data)
  const userOnShow = options.onShow
  options.onShow = function (...args) {
    const next = injectAll()
    // 字号或主题变化则刷新（避免无谓 setData）
    if (this.data.fsScale !== next.fsScale || this.data.themeName !== next.themeName || this.data.themePref !== next.themePref) {
      this.setData(next)
    }
    // 原生导航栏/窗口背景同步当前主题（forced 主题需覆盖 theme.json 的系统跟随）
    theme.applyChrome()
    // 登录态守卫：非公开页在本地无 token 时主动跳登录（不再仅依赖后端 401 被动兜底）
    if (!PUBLIC_PAGES.includes(this.route) && !wx.getStorageSync('token')) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    if (typeof userOnShow === 'function') return userOnShow.apply(this, args)
  }
  return originalPage(options)
}

App({
  globalData: {
    env: ENV,
    apiBase: API_BASES[ENV] || API_BASES.dev
  },

  onLaunch() {
    const token = wx.getStorageSync('token')
    if (!token) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.checkAgreements()
    // 预取基础数据字典（类目/计酬/地点/工种/订阅模板），失败静默回退本地默认
    api.meta(true).catch(() => {})
  },

  /**
   * 申请微信订阅消息授权（一次性订阅）。须在用户点击手势的同步上下文中调用（不能在 await 之后），
   * 故用 metaSync 同步读取已缓存的模板ID；运营未在小程序后台配置模板ID时静默跳过。
   */
  requestSubscribe() {
    try {
      const tmplIds = ((api.metaSync().subscribeTmplIds) || []).filter(Boolean).slice(0, 3)
      if (!tmplIds.length) return
      wx.requestSubscribeMessage({ tmplIds, complete: () => {} })
    } catch (e) {}
  },

  // PIPL：协议更新后强制重新同意（启动/登录后调用；不可取消）
  checkAgreements() {
    const token = wx.getStorageSync('token')
    if (!token) return
    wx.request({
      url: this.globalData.apiBase + '/me/agreements/status',
      header: { Authorization: 'Bearer ' + token },
      success: res => {
        if (res.statusCode === 200 && res.data && res.data.needReAgree) {
          this.showReAgreeModal()
        }
      }
    })
  },

  showReAgreeModal() {
    wx.showModal({
      title: '协议更新提示',
      content: '《平台服务协议》与《隐私政策》已更新。请阅读最新版本（我的-帮助或登录页可查看全文），确认同意后方可继续使用平台服务。',
      confirmText: '同意并继续',
      showCancel: false,
      success: res => {
        if (!res.confirm) return
        wx.request({
          url: this.globalData.apiBase + '/me/agreements/re-agree',
          method: 'POST',
          header: {
            'content-type': 'application/json',
            Authorization: 'Bearer ' + (wx.getStorageSync('token') || '')
          },
          success: r => {
            if (r.statusCode >= 200 && r.statusCode < 300) {
              wx.showToast({ title: '已确认最新协议', icon: 'success' })
            } else {
              wx.showToast({ title: '确认失败，请稍后重试', icon: 'none' })
            }
          },
          fail: () => wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' })
        })
      }
    })
  }
})
