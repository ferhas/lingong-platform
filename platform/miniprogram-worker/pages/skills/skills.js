const api = require('../../utils/api.js')

const LEVELS = ['初级', '中级', '高级']

const STATUS_TEXT = {
  pending: '审核中',
  verified: '已认证',
  rejected: '未通过'
}

Page({
  data: {
    catalog: [],
    list: [],
    levels: LEVELS,
    skillIndex: 0,
    levelIndex: 0,
    certUploadId: '',
    certName: '',
    submitting: false
  },

  onShow() {
    this.fetch()
  },

  async fetch() {
    try {
      const data = await api.get('/worker/skills')
      this.setData({
        catalog: data.catalog,
        list: data.list.map(s => ({ ...s, statusText: STATUS_TEXT[s.status] || s.status }))
      })
    } catch (e) {}
  },

  onSkill(e) {
    this.setData({ skillIndex: Number(e.detail.value) })
  },

  onLevel(e) {
    this.setData({ levelIndex: Number(e.detail.value) })
  },

  // 上传技能证书（可选，有证书更易通过审核）
  onPickCert() {
    wx.chooseMessageFile({
      count: 1,
      success: async pick => {
        wx.showLoading({ title: '上传中…' })
        try {
          const up = await api.upload(pick.tempFiles[0].path, pick.tempFiles[0].name)
          wx.hideLoading()
          this.setData({ certUploadId: up.id, certName: pick.tempFiles[0].name })
        } catch (e) {
          wx.hideLoading()
        }
      }
    })
  },

  async onSubmit() {
    const { catalog, skillIndex, levels, levelIndex, certUploadId } = this.data
    if (!catalog.length) return wx.showToast({ title: '技能目录加载中，请稍后', icon: 'none' })

    this.setData({ submitting: true })
    try {
      const body = { skill: catalog[skillIndex], level: levels[levelIndex] }
      if (certUploadId) body.certUploadId = certUploadId
      await api.post('/worker/skills', body)
      this.setData({ certUploadId: '', certName: '' })
      wx.showToast({ title: '已提交，等待运营审核', icon: 'success' })
      this.fetch()
    } catch (e) {
    } finally {
      this.setData({ submitting: false })
    }
  }
})
