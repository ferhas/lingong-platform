const theme = require('../utils/theme.js')

Component({
  data: {
    selected: 0,
    themeClass: 't-light',
    list: [
      { pagePath: 'pages/index/index', text: '任务大厅', mark: '任' },
      { pagePath: 'pages/orders/orders', text: '我的接单', mark: '单' },
      { pagePath: 'pages/mine/mine', text: '我的', mark: '我' }
    ]
  },

  lifetimes: {
    attached() {
      this.syncSelected()
      this.syncTheme()
    }
  },

  pageLifetimes: {
    show() {
      this.syncSelected()
      this.syncTheme()
    }
  },

  methods: {
    syncSelected() {
      const pages = getCurrentPages()
      const route = pages.length ? pages[pages.length - 1].route : ''
      const selected = this.data.list.findIndex(item => item.pagePath === route)
      this.setData({ selected: selected >= 0 ? selected : 0 })
    },

    // 同步深色主题到 tabBar 自身（设置页切换后由页面调用 getTabBar().syncTheme() 即时刷新）
    syncTheme() {
      const tc = theme.effective() === 'dark' ? 't-dark' : 't-light'
      if (this.data.themeClass !== tc) this.setData({ themeClass: tc })
    },

    switchTab(e) {
      const { path } = e.currentTarget.dataset
      wx.switchTab({ url: path })
    },

    // 自定义 tabBar 下原生 wx.showTabBarRedDot 不生效，红点改由组件自身数据驱动
    setDot(index, show) {
      if (index < 0 || index >= this.data.list.length) return
      this.setData({ [`list[${index}].dot`]: !!show })
    }
  }
})
