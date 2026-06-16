const api = require('../../utils/api.js')

const STATUS_TEXT = {
  working: '进行中',
  delivered: '待验收',
  settled: '已结算',
  cancelled: '已取消'
}

// 接单状态标签页（'' = 全部）；数量多时按状态过滤 + 分页加载
const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'working', label: '进行中' },
  { key: 'delivered', label: '待验收' },
  { key: 'settled', label: '已结算' },
  { key: 'cancelled', label: '已取消' }
]

// 兜底评价标签；实际优先取 /worker/meta 的 reviewTags（运营可在线调整，与企业端口径一致）
const REVIEW_TAGS = ['按时交付', '质量过硬', '沟通顺畅', '响应及时', '需求清晰', '验收爽快']

// 零工可发起的争议类型（按工单状态过滤）
const DISPUTE_TYPES = [
  { key: 'acceptance', label: '验收争议', statuses: ['working', 'delivered'] },
  { key: 'payment_overdue', label: '超期未验收', statuses: ['delivered'] },
  { key: 'other', label: '其他', statuses: ['working', 'delivered', 'settled'] }
]

const INVOICE_TYPES = [
  { key: 'normal', label: '增值税普通发票' },
  { key: 'special', label: '增值税专用发票' }
]

Page({
  data: {
    orders: [],
    dispatches: [],
    subjectType: 'person',
    loading: false,
    // 状态标签页 + 分页
    statusTabs: STATUS_TABS.map(t => ({ ...t, count: 0 })),
    activeStatus: '',
    total: 0,
    page: 1,
    pageSize: 10,
    finished: false,
    // 申请平台介入弹窗
    dispute: { show: false, orderId: 0, types: [], typeKey: '', claim: '', claimAmount: '', submitting: false },
    // 评价弹窗
    review: { show: false, orderId: 0, score: 0, tags: [], comment: '', submitting: false },
    // B线发票上传弹窗
    invoice: { show: false, orderId: 0, uploadId: '', fileName: '', invoiceNo: '', amount: '', taxAmount: '', typeIndex: 0, submitting: false },
    invoiceTypes: INVOICE_TYPES
  },

  onShow() {
    this.fetch()
  },

  // 全量刷新：重置分页 + 重新拉取列表与侧栏数据（派单邀约 / 主体类型）
  fetch() {
    this.setData({ page: 1, orders: [], finished: false })
    this.fetchOrders()
    this.fetchSide()
  },

  // 按当前状态分页拉取接单列表；page>1 时追加。解决「数量很多」一次性加载的问题
  async fetchOrders() {
    if (this.data.loading || this.data.finished) return
    this.setData({ loading: true })
    try {
      const d = this.data
      const data = await api.get('/worker/orders', { status: d.activeStatus, page: d.page, pageSize: d.pageSize })
      const mapped = data.list.map(o => ({
        ...o,
        statusText: STATUS_TEXT[o.status] || o.status,
        hasInvoice: (o.attachments || []).some(a => a.kind === 'invoice')
      }))
      const orders = d.page === 1 ? mapped : d.orders.concat(mapped)
      const counts = data.counts || {}
      this.setData({
        orders,
        total: data.total,
        page: d.page + 1,
        finished: orders.length >= data.total,
        statusTabs: STATUS_TABS.map(t => ({ ...t, count: t.key === '' ? (counts.all || 0) : (counts[t.key] || 0) }))
      })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
      wx.stopPullDownRefresh()
    }
  },

  // 侧栏数据：主体类型（个体户发票提示用）+ 待接受派单邀约（仅一次，不随翻页重复拉取）
  async fetchSide() {
    try {
      const [profile, dispatches] = await Promise.all([
        api.get('/worker/profile'),
        api.get('/worker/dispatches')
      ])
      this.setData({
        subjectType: profile.subjectType,
        // 仅展示待接受、且任务仍在招募的邀约
        dispatches: dispatches.list.filter(d => d.status === 'invited' && d.taskStatus === 'recruiting' && !d.expired)
      })
    } catch (e) {}
  },

  // 切换状态标签：重置分页并只拉取该状态的接单
  onSelectStatus(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeStatus) return
    this.setData({ activeStatus: key, page: 1, orders: [], finished: false })
    this.fetchOrders()
  },

  onReachBottom() {
    this.fetchOrders()
  },

  // —— 派单邀约：接受 / 拒绝 ——
  onAcceptDispatch(e) {
    const d = this.data.dispatches.find(x => x.id === Number(e.currentTarget.dataset.id))
    if (!d) return
    // 订阅消息授权须在点击手势同步上下文中拉起
    getApp().requestSubscribe()
    wx.showModal({
      title: '接受派单',
      content: `接受「${d.title}」后，平台将与您电子签《分包工单》并按单投保，任务进入进行中。预估到手 ¥${d.estimate.net}。是否接受？`,
      confirmText: '接受派单',
      success: async res => {
        if (!res.confirm) return
        try {
          const r = await api.postGeo(`/worker/dispatches/${d.id}/accept`)
          wx.showModal({
            title: '已接受派单',
            content: `分包工单 ${r.workOrderNo} 已电子签，意外险已生效。请按交付标准完成并上传成果。`,
            showCancel: false
          })
          this.fetch()
        } catch (err) {}
      }
    })
  },

  onRejectDispatch(e) {
    const id = Number(e.currentTarget.dataset.id)
    wx.showModal({
      title: '拒绝派单',
      editable: true,
      placeholderText: '可填写拒绝理由（可不填）',
      confirmText: '确认拒绝',
      success: async res => {
        if (!res.confirm) return
        try {
          await api.post(`/worker/dispatches/${id}/reject`, { reason: (res.content || '').trim() })
          wx.showToast({ title: '已拒绝该派单', icon: 'none' })
          this.fetch()
        } catch (err) {}
      }
    })
  },

  onPullDownRefresh() {
    this.fetch()
  },

  // 交付：进入按工种结构化交付页（动态表单，填写字段 + 分类上传材料）
  onDeliver(e) {
    const order = this.data.orders.find(o => o.id === Number(e.currentTarget.dataset.id))
    const title = order ? encodeURIComponent(order.title) : ''
    wx.navigateTo({ url: `/pages/deliver/deliver?id=${e.currentTarget.dataset.id}&title=${title}` })
  },

  // —— B线个体户：上传进项发票（先选文件上传，再补录发票号/金额/类型）——
  onUploadInvoice(e) {
    const id = e.currentTarget.dataset.id
    wx.chooseMessageFile({
      count: 1,
      success: async pick => {
        wx.showLoading({ title: '上传中…' })
        try {
          const up = await api.upload(pick.tempFiles[0].path, pick.tempFiles[0].name)
          wx.hideLoading()
          this.setData({
            invoice: {
              show: true, orderId: id, uploadId: up.id, fileName: pick.tempFiles[0].name,
              invoiceNo: '', amount: '', taxAmount: '', typeIndex: 0, submitting: false
            }
          })
        } catch (err) {
          wx.hideLoading()
        }
      }
    })
  },

  onInvoiceInput(e) {
    this.setData({ ['invoice.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onInvoiceType(e) {
    this.setData({ 'invoice.typeIndex': Number(e.detail.value) })
  },

  onCloseInvoice() {
    this.setData({ 'invoice.show': false })
  },

  async onSubmitInvoice() {
    const inv = this.data.invoice
    if (inv.invoiceNo.trim() && inv.invoiceNo.trim().length < 8) {
      return wx.showToast({ title: '发票号码至少8位', icon: 'none' })
    }
    if (inv.amount !== '' && !(Number(inv.amount) > 0)) {
      return wx.showToast({ title: '发票金额须大于0', icon: 'none' })
    }
    const body = { uploadId: inv.uploadId, invoiceType: INVOICE_TYPES[inv.typeIndex].key }
    if (inv.invoiceNo.trim()) body.invoiceNo = inv.invoiceNo.trim()
    if (inv.amount !== '') body.amount = Number(inv.amount)
    if (inv.taxAmount !== '') body.taxAmount = Number(inv.taxAmount)
    this.setData({ 'invoice.submitting': true })
    try {
      await api.post(`/worker/orders/${inv.orderId}/invoice`, body)
      this.setData({ 'invoice.show': false })
      wx.showToast({ title: '发票已上传', icon: 'success' })
      this.fetch()
    } catch (err) {
    } finally {
      this.setData({ 'invoice.submitting': false })
    }
  },

  // —— 申请平台介入（争议）——
  onDispute(e) {
    const order = this.data.orders.find(o => o.id === Number(e.currentTarget.dataset.id))
    if (!order) return
    const types = DISPUTE_TYPES.filter(t => t.statuses.includes(order.status))
    this.setData({
      dispute: { show: true, orderId: order.id, types, typeKey: types[0].key, claim: '', claimAmount: '', submitting: false }
    })
  },

  onDisputeType(e) {
    this.setData({ 'dispute.typeKey': e.currentTarget.dataset.key })
  },

  onDisputeInput(e) {
    this.setData({ ['dispute.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onCloseDispute() {
    this.setData({ 'dispute.show': false })
  },

  async onSubmitDispute() {
    const d = this.data.dispute
    if (d.claim.trim().length < 10) return wx.showToast({ title: '请描述诉求（不少于10个字）', icon: 'none' })
    if (d.claimAmount !== '' && Number(d.claimAmount) < 0) {
      return wx.showToast({ title: '主张金额不能为负数', icon: 'none' })
    }
    const body = { type: d.typeKey, claim: d.claim.trim() }
    if (d.claimAmount !== '') body.claimAmount = Number(d.claimAmount)
    this.setData({ 'dispute.submitting': true })
    try {
      const r = await api.post(`/worker/orders/${d.orderId}/dispute`, body)
      this.setData({ 'dispute.show': false })
      wx.showModal({
        title: '已申请平台介入',
        content: `争议编号：${r.no}\n现进入协商期，双方可在线和解；逾期未和解将自动转平台仲裁。可在“我的-争议处理”中跟进。`,
        confirmText: '查看进度',
        cancelText: '知道了',
        success: res => {
          if (res.confirm) wx.navigateTo({ url: '/pages/disputes/disputes' })
        }
      })
    } catch (err) {
    } finally {
      this.setData({ 'dispute.submitting': false })
    }
  },

  // —— 评价（结算后互盲互评）——
  onReview(e) {
    const id = Number(e.currentTarget.dataset.id)
    const pool = (api.metaSync().reviewTags && api.metaSync().reviewTags.length) ? api.metaSync().reviewTags : REVIEW_TAGS
    this.setData({
      review: {
        show: true, orderId: id, score: 0, comment: '', submitting: false,
        tags: pool.map(name => ({ name, on: false }))
      }
    })
  },

  onReviewScore(e) {
    this.setData({ 'review.score': Number(e.currentTarget.dataset.score) })
  },

  onReviewTag(e) {
    const i = Number(e.currentTarget.dataset.index)
    this.setData({ [`review.tags[${i}].on`]: !this.data.review.tags[i].on })
  },

  onReviewInput(e) {
    this.setData({ 'review.comment': e.detail.value })
  },

  onCloseReview() {
    this.setData({ 'review.show': false })
  },

  async onSubmitReview() {
    const r = this.data.review
    if (!r.score) return wx.showToast({ title: '请选择星级', icon: 'none' })
    this.setData({ 'review.submitting': true })
    try {
      await api.post(`/worker/orders/${r.orderId}/review`, {
        score: r.score,
        tags: r.tags.filter(t => t.on).map(t => t.name),
        comment: r.comment.trim()
      })
      this.setData({ 'review.show': false })
      wx.showToast({ title: '评价成功', icon: 'success' })
    } catch (err) {
    } finally {
      this.setData({ 'review.submitting': false })
    }
  },

  // 查看评价（互盲：双方评完或窗口期满后互相可见）
  async onViewReviews(e) {
    const id = Number(e.currentTarget.dataset.id)
    try {
      const data = await api.get(`/worker/orders/${id}/reviews`)
      if (!data.reviews.length) {
        return wx.showToast({ title: '暂无评价', icon: 'none' })
      }
      const lines = data.reviews.map(r => {
        const who = r.reviewerRole === 'worker' ? '我的评价' : '企业评价'
        const stars = '★★★★★'.slice(0, r.score)
        const tags = r.tags.length ? '\n标签：' + r.tags.join(' / ') : ''
        const comment = r.comment ? '\n' + r.comment : ''
        return `${who}：${stars}（${r.score}分）${tags}${comment}`
      })
      if (!data.visible) {
        lines.push('\n互评期内对方评价暂不可见（双方均评价或窗口期满后互相可见）')
      }
      wx.showModal({ title: '任务评价', content: lines.join('\n\n'), showCancel: false })
    } catch (err) {}
  },

  // 保险理赔一键报案（接单期间发生意外时使用）
  onClaim(e) {
    const id = Number(e.currentTarget.dataset.id)
    wx.showModal({
      title: '保险报案',
      editable: true,
      placeholderText: '请简述事故经过（时间/地点/伤情）',
      confirmText: '提交报案',
      success: async res => {
        if (!res.confirm) return
        const description = (res.content || '').trim()
        if (description.length < 5) return wx.showToast({ title: '请描述事故经过（不少于5个字）', icon: 'none' })
        try {
          const r = await api.post('/worker/claims', { taskId: id, description })
          wx.showModal({
            title: '报案成功',
            content: `保单号：${r.policyNo}\n平台将协助保险公司与您联系，请保持电话畅通。处理进度会通过消息中心通知您。`,
            showCancel: false
          })
        } catch (err) {}
      }
    })
  },

  onViewOrder(e) {
    const order = this.data.orders.find(o => o.id === Number(e.currentTarget.dataset.id))
    wx.showModal({
      title: '分包工单 ' + order.workOrderNo,
      content: `任务：${order.title}\n计酬方式：${order.payMethod}（成果不合格不计酬）\n分包报酬：¥${order.subPrice}\n保单号：${order.policyNo}（接单生效、交付终止）${order.confirmNo ? '\n交易确认单：' + order.confirmNo : ''}`,
      showCancel: false
    })
  }
})
