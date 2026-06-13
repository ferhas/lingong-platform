const api = require('../../utils/api.js')

Page({
  data: {
    realName: '',
    idCard: '',
    bankCard: '',
    submitting: false,
    profile: null,
    // PIPL 单独同意弹窗（逐项说明 + 非默认勾选）
    showConsent: false,
    consentIdcard: false,
    consentFace: false,
    consentBankcard: false,
    // 人脸核身分支
    needFace: false,
    faceRequestId: ''
  },

  onShow() {
    this.fetchProfile()
  },

  async fetchProfile() {
    try {
      const profile = await api.get('/worker/profile')
      this.setData({ profile })
    } catch (e) {}
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  // 第一步：本地校验通过后弹出 PIPL 单独同意弹窗
  onSubmit() {
    const { realName, idCard, bankCard } = this.data
    if (realName.trim().length < 2) return wx.showToast({ title: '请输入真实姓名', icon: 'none' })
    if (idCard.length !== 18) return wx.showToast({ title: '身份证号须为18位', icon: 'none' })
    if (!/^\d{15,19}$/.test(bankCard)) return wx.showToast({ title: '银行卡号格式不正确', icon: 'none' })
    this.setData({
      showConsent: true,
      consentIdcard: false,
      consentFace: false,
      consentBankcard: false
    })
  },

  onToggleConsent(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [key]: !this.data[key] })
  },

  onCloseConsent() {
    this.setData({ showConsent: false })
  },

  // 第二步：逐项同意后提交认证
  async onConsentAgree() {
    const { consentIdcard, consentFace, consentBankcard } = this.data
    if (!consentIdcard || !consentFace || !consentBankcard) {
      return wx.showToast({ title: '请逐项阅读并勾选同意', icon: 'none' })
    }
    const { realName, idCard, bankCard } = this.data
    this.setData({ showConsent: false, submitting: true })
    try {
      const r = await api.post('/worker/verify', {
        realName: realName.trim(),
        idCard,
        bankCard,
        consents: ['idcard', 'face', 'bankcard']
      })
      if (r.needFace) {
        // 平台开启人脸核身：进入人脸核身引导
        this.setData({ needFace: true, faceRequestId: r.faceRequestId })
        wx.showToast({ title: '身份核验通过，请完成人脸核身', icon: 'none', duration: 2200 })
        return
      }
      this.showSuccess(r.frameContractNo)
    } catch (e) {
    } finally {
      this.setData({ submitting: false })
    }
  },

  // 第三步：人脸核身。开发态直接模拟通过；生产态须先拉起活体检测 SDK，通过后再回传结果。
  onFaceDone() {
    this.startFaceVerify()
  },

  /**
   * 拉起人脸活体检测。
   * 生产接入：在 app.json 声明人脸核身插件（如微信「腾讯云慧眼」faceid 插件），用 faceRequestId
   * 作为 bizToken 调用 plugin 的活体检测；检测通过的回调里再调用 submitFaceResult()。
   * 开发态无插件，直接模拟通过以便联调。
   */
  async startFaceVerify() {
    const env = (getApp().globalData && getApp().globalData.env) || 'dev'
    if (env !== 'dev') {
      // TODO(上线)：替换为真实活体检测插件调用，例如：
      //   const faceid = requirePlugin('faceid')
      //   faceid.getFaceVerify({ bizToken: this.data.faceRequestId, success: () => this.submitFaceResult(), fail: ... })
      wx.showModal({
        title: '人脸核身',
        content: '生产环境需接入活体检测SDK。请在小程序后台添加人脸核身插件并完成集成后再发布。',
        showCancel: false
      })
      return
    }
    this.submitFaceResult()
  },

  // 活体检测通过后回传结果，完成签约开户
  async submitFaceResult() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    try {
      const r = await api.post('/worker/verify/face-result', { faceRequestId: this.data.faceRequestId })
      this.setData({ needFace: false, faceRequestId: '' })
      this.showSuccess(r.frameContractNo)
    } catch (e) {
      if (e.code === 'BAD_FACE_REQUEST') {
        // 会话过期：回到表单重新发起
        this.setData({ needFace: false, faceRequestId: '' })
      }
    } finally {
      this.setData({ submitting: false })
    }
  },

  onFaceCancel() {
    this.setData({ needFace: false, faceRequestId: '' })
  },

  showSuccess(frameContractNo) {
    wx.showModal({
      title: '认证成功',
      content: `实名核验通过，本人一类银行卡已绑定。\n\n《分包协议（框架）》已电子签署并司法存证。\n协议编号：${frameContractNo}`,
      showCancel: false,
      success: () => this.fetchProfile()
    })
  }
})
