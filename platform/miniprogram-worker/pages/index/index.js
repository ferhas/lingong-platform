const api = require('../../utils/api.js')

const SORTS = [
  { key: 'latest', label: '最新' },
  { key: 'price_desc', label: '报酬↓' },
  { key: 'applicants_asc', label: '报名少' }
]
const PRICE_FILTERS = [
  { label: '不限报酬', min: '' },
  { label: '¥500+', min: 500 },
  { label: '¥1000+', min: 1000 },
  { label: '¥5000+', min: 5000 }
]
const HISTORY_KEY = 'task_search_history'

Page({
  data: {
    // 基础数据字典来自后端 /worker/meta（运营可在线配置），不再写死，避免与企业端发布脱节
    categories: ['全部'],
    sorts: SORTS,
    priceFilters: PRICE_FILTERS,
    payFilters: [{ label: '不限计酬', value: '' }],
    cityFilters: [{ label: '不限地点', value: '' }],
    tradeFilters: [{ label: '不限工种', value: '' }],
    activeCategory: '全部',
    activeSort: 'latest',
    priceIndex: 0,
    payIndex: 0,
    cityIndex: 0,
    tradeIndex: 0,
    matchSkills: false,
    keyword: '',
    searchHistory: [],
    showHistory: false,
    tasks: [],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    finished: false,
    userName: ''
  },

  onLoad() {
    this.loadMeta()
    this.setData({ searchHistory: wx.getStorageSync(HISTORY_KEY) || [] })
  },

  onShow() {
    this.setData({ userName: (wx.getStorageSync('user') || {}).name || '' })
    this.reload()
    this.syncBadge()
  },

  // 拉取基础数据字典并构造筛选项（失败时 api.meta 内部回退默认值）
  async loadMeta() {
    const m = await api.meta()
    this.setData({
      categories: ['全部', ...(m.categories || [])],
      payFilters: [{ label: '不限计酬', value: '' }, ...(m.payMethods || []).map(p => ({ label: p, value: p }))],
      cityFilters: [{ label: '不限地点', value: '' }, ...(m.cities || []).map(c => ({ label: c, value: c }))],
      tradeFilters: [{ label: '不限工种', value: '' }, ...(m.trades || []).map(t => ({ label: t, value: t }))]
    })
  },

  async syncBadge() {
    try {
      const n = await api.get('/me/notifications', { pageSize: 1 })
      if (n.unread > 0) wx.showTabBarRedDot({ index: 2 })
      else wx.hideTabBarRedDot({ index: 2 })
    } catch (e) {}
  },

  reload() {
    this.setData({ page: 1, tasks: [], finished: false })
    this.fetchTasks()
  },

  async fetchTasks() {
    if (this.data.loading || this.data.finished) return
    this.setData({ loading: true })
    try {
      const d = this.data
      const data = await api.get('/worker/tasks', {
        category: d.activeCategory === '全部' ? '' : d.activeCategory,
        trade: d.tradeFilters[d.tradeIndex].value,
        city: d.cityFilters[d.cityIndex].value,
        keyword: d.keyword,
        sort: d.activeSort,
        minPrice: d.priceFilters[d.priceIndex].min,
        payMethod: d.payFilters[d.payIndex].value,
        matchSkills: d.matchSkills ? 1 : '',
        page: d.page,
        pageSize: d.pageSize
      })
      const tasks = this.data.tasks.concat(data.list)
      this.setData({
        tasks,
        total: data.total,
        page: d.page + 1,
        finished: tasks.length >= data.total
      })
    } catch (e) {
      // 已统一提示
    } finally {
      this.setData({ loading: false })
      wx.stopPullDownRefresh()
    }
  },

  onPullDownRefresh() {
    this.reload()
  },

  onReachBottom() {
    this.fetchTasks()
  },

  onSelectCategory(e) {
    this.setData({ activeCategory: e.currentTarget.dataset.category })
    this.reload()
  },

  onSelectSort(e) {
    this.setData({ activeSort: e.currentTarget.dataset.key })
    this.reload()
  },

  onSelectPrice(e) {
    this.setData({ priceIndex: Number(e.detail.value) })
    this.reload()
  },

  onSelectPay(e) {
    this.setData({ payIndex: Number(e.detail.value) })
    this.reload()
  },

  onSelectCity(e) {
    this.setData({ cityIndex: Number(e.detail.value) })
    this.reload()
  },

  onSelectTrade(e) {
    this.setData({ tradeIndex: Number(e.detail.value) })
    this.reload()
  },

  onToggleMatch() {
    this.setData({ matchSkills: !this.data.matchSkills })
    this.reload()
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onFocusSearch() {
    this.setData({ showHistory: this.data.searchHistory.length > 0 })
  },

  onBlurSearch() {
    setTimeout(() => this.setData({ showHistory: false }), 150)
  },

  onSearch() {
    const kw = (this.data.keyword || '').trim()
    if (kw) {
      const history = [kw, ...this.data.searchHistory.filter(h => h !== kw)].slice(0, 10)
      wx.setStorageSync(HISTORY_KEY, history)
      this.setData({ searchHistory: history })
    }
    this.setData({ showHistory: false })
    this.reload()
  },

  onTapHistory(e) {
    this.setData({ keyword: e.currentTarget.dataset.kw, showHistory: false })
    this.reload()
  },

  onClearHistory() {
    wx.removeStorageSync(HISTORY_KEY)
    this.setData({ searchHistory: [], showHistory: false })
  },

  onTapTask(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.detail.id })
  }
})
