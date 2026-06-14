import { defineStore } from 'pinia'
import client from '../api/client'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    refreshToken: localStorage.getItem('refreshToken') || '',
    user: JSON.parse(localStorage.getItem('user') || 'null')
  }),
  getters: {
    isLoggedIn: state => !!state.token,
    // 企业成员角色：owner 企业主 / operator 运营 / finance 财务
    memberRole: state => state.user?.memberRole || null,
    isOwner: state => state.user?.memberRole === 'owner',
    isOperator: state => state.user?.memberRole === 'operator',
    isFinance: state => state.user?.memberRole === 'finance',
    // 任务发布与管理（录用/验收/驳回/取消/派单/争议/评价）：后端 requireCompanyRole('owner','operator')，财务无权
    canManageTasks: state => state.user?.memberRole === 'owner' || state.user?.memberRole === 'operator',
    // 资金充值：后端 requireCompanyRole('owner','finance')，运营无权
    canRecharge: state => state.user?.memberRole === 'owner' || state.user?.memberRole === 'finance'
  },
  actions: {
    setSession(token, user, refreshToken) {
      this.token = token
      this.user = user
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
      if (refreshToken) {
        this.refreshToken = refreshToken
        localStorage.setItem('refreshToken', refreshToken)
      }
    },
    async login(phone, password) {
      const data = await client.post('/auth/login', { phone, password })
      if (data.user?.role !== 'company') {
        throw new Error('请使用企业账号登录')
      }
      this.setSession(data.token, data.user, data.refreshToken)
      // 登录后拉取增强信息（含 memberRole），失败不阻断登录
      await this.fetchMe().catch(() => {})
      return this.user
    },
    async register(payload) {
      const data = await client.post('/auth/register', { role: 'company', ...payload })
      this.setSession(data.token, data.user, data.refreshToken)
      await this.fetchMe().catch(() => {})
      return this.user
    },
    async fetchMe() {
      const me = await client.get('/auth/me')
      this.user = me
      localStorage.setItem('user', JSON.stringify(me))
      return me
    },
    async logout() {
      // 先通知后端吊销全部 refreshToken（静默，失败不阻断本地登出）
      if (this.token) {
        await client.post('/auth/logout', null, { silent: true }).catch(() => {})
      }
      this.token = ''
      this.refreshToken = ''
      this.user = null
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
      localStorage.removeItem('user')
    }
  }
})
