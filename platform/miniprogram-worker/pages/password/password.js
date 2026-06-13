const api = require('../../utils/api.js')

Page({
  data: {
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    submitting: false
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  async onSubmit() {
    const { oldPassword, newPassword, confirmPassword } = this.data
    if (!oldPassword) return wx.showToast({ title: '请输入原密码', icon: 'none' })
    if (newPassword.length < 10 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return wx.showToast({ title: '新密码须≥10位且含字母和数字', icon: 'none' })
    }
    if (newPassword !== confirmPassword) {
      return wx.showToast({ title: '两次输入的新密码不一致', icon: 'none' })
    }

    this.setData({ submitting: true })
    try {
      await api.post('/auth/change-password', { oldPassword, newPassword })
      wx.showToast({ title: '修改成功，请重新登录', icon: 'success' })
      setTimeout(() => {
        wx.removeStorageSync('token')
        wx.removeStorageSync('user')
        wx.reLaunch({ url: '/pages/login/login' })
      }, 1200)
    } catch (e) {
    } finally {
      this.setData({ submitting: false })
    }
  }
})
