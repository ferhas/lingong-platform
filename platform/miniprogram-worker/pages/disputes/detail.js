const api = require('../../utils/api.js')

const STATUS_TEXT = {
  negotiating: '协商中',
  arbitrating: '平台仲裁中',
  ruled: '已裁决',
  executed: '已执行',
  closed: '已关闭',
  withdrawn: '已撤回',
  escalated: '线下处理中'
}

const TYPE_TEXT = {
  acceptance: '验收争议',
  payment_overdue: '超期未验收',
  worker_missing: '零工失联',
  quality_after: '结算后质量争议',
  other: '其他'
}

const RULING_TEXT = {
  full_pay: '全额结算',
  partial_pay: '部分结算',
  no_pay: '不予结算',
  redeliver: '限期重新交付'
}

const ROLE_TEXT = { worker: '我方', company: '企业', admin: '平台', system: '系统' }

const ACTION_TEXT = {
  create: '发起争议',
  evidence: '举证留言',
  withdraw: '撤回争议',
  accept: '平台受理',
  rule: '出具裁决',
  execute: '裁决执行',
  escalate: '线下升级'
}

Page({
  data: {
    id: 0,
    detail: null,
    msg: '',
    sending: false
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) })
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    try {
      const d = await api.get('/me/disputes/' + this.data.id)
      this.setData({
        detail: {
          ...d,
          statusText: STATUS_TEXT[d.status] || d.status,
          typeText: TYPE_TEXT[d.type] || d.type,
          rulingTypeText: RULING_TEXT[d.rulingType] || d.rulingType,
          canAct: ['negotiating', 'arbitrating'].includes(d.status),
          canWithdraw: ['negotiating', 'arbitrating'].includes(d.status) && d.initiatorRole === 'worker',
          canEscalate: ['ruled', 'executed'].includes(d.status),
          timeline: (d.timeline || []).map(e => ({
            ...e,
            roleText: ROLE_TEXT[e.actorRole] || e.actorRole,
            actionText: ACTION_TEXT[e.action] || e.action
          }))
        }
      })
    } catch (e) {}
  },

  onMsgInput(e) {
    this.setData({ msg: e.detail.value })
  },

  // 举证留言
  async onSendMsg() {
    const content = this.data.msg.trim()
    if (!content) return wx.showToast({ title: '请输入留言内容', icon: 'none' })
    this.setData({ sending: true })
    try {
      await api.post(`/me/disputes/${this.data.id}/events`, { content })
      this.setData({ msg: '' })
      wx.showToast({ title: '已提交', icon: 'success' })
      this.fetch()
    } catch (e) {
    } finally {
      this.setData({ sending: false })
    }
  },

  // 撤回争议（和解/放弃）
  onWithdraw() {
    wx.showModal({
      title: '撤回争议',
      content: '撤回后视为已和解或放弃主张，任务恢复正常流转。确认撤回？',
      confirmText: '确认撤回',
      success: async res => {
        if (!res.confirm) return
        try {
          await api.post(`/me/disputes/${this.data.id}/withdraw`)
          wx.showToast({ title: '已撤回', icon: 'success' })
          this.fetch()
        } catch (e) {}
      }
    })
  },

  // 对裁决不服：线下升级声明
  onEscalate() {
    wx.showModal({
      title: '对裁决不服',
      content: '声明后将记录您拟向平台所在地仲裁委员会或人民法院提起，平台将提供完整证据包（四流归档）。资金已按裁决先行执行。确认声明？',
      confirmText: '确认声明',
      success: async res => {
        if (!res.confirm) return
        try {
          await api.post(`/me/disputes/${this.data.id}/escalate`)
          wx.showToast({ title: '已声明线下升级', icon: 'success' })
          this.fetch()
        } catch (e) {}
      }
    })
  }
})
