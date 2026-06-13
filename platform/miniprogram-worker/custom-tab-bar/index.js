Component({
  data: {
    selected: 0,
    list: [
      { pagePath: 'pages/index/index', text: '任务大厅', mark: '任' },
      { pagePath: 'pages/orders/orders', text: '我的接单', mark: '单' },
      { pagePath: 'pages/mine/mine', text: '我的', mark: '我' }
    ]
  },

  lifetimes: {
    attached() {
      this.syncSelected()
    }
  },

  pageLifetimes: {
    show() {
      this.syncSelected()
    }
  },

  methods: {
    syncSelected() {
      const pages = getCurrentPages()
      const route = pages.length ? pages[pages.length - 1].route : ''
      const selected = this.data.list.findIndex(item => item.pagePath === route)
      this.setData({ selected: selected >= 0 ? selected : 0 })
    },

    switchTab(e) {
      const { path } = e.currentTarget.dataset
      wx.switchTab({ url: path })
    }
  }
})
