import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { REFRESH_KEY, TOKEN_KEY, USER_KEY } from '../api/client'
import * as api from '../api/admin'
import { flatMenus } from '../layout/menus'

function readUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY)) || null
  } catch {
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '')
  const refreshToken = ref(localStorage.getItem(REFRESH_KEY) || '')
  const user = ref(readUser())
  const permissions = ref(user.value?.permissions || [])
  const roleName = ref(user.value?.roleName || '')
  // 是否已用 /auth/me 拉取过最新权限(每次会话至少一次,防止本地缓存过期)
  const profileLoaded = ref(false)

  /** 权限判断:'*' 为全部,或权限点命中 */
  function can(perm) {
    if (!perm) return true
    return permissions.value.includes('*') || permissions.value.includes(perm)
  }

  /** 当前用户第一个有权限的菜单路径(无任何权限返回空) */
  const firstAllowedPath = computed(() => flatMenus.find(m => can(m.perm))?.path || '')

  function persistUser() {
    localStorage.setItem(USER_KEY, JSON.stringify(user.value))
  }

  /** 拉取 /auth/me:权限点 + 角色名 */
  async function fetchProfile() {
    const me = await api.getMe()
    user.value = { ...user.value, ...me }
    permissions.value = Array.isArray(me.permissions) ? me.permissions : []
    roleName.value = me.roleName || ''
    profileLoaded.value = true
    persistUser()
    return me
  }

  /** 登录成功后的会话落盘(密码直登与 2FA 二段验证共用) */
  async function applySession(data) {
    if (data.user?.role !== 'admin') {
      const err = new Error('NOT_ADMIN')
      err.code = 'NOT_ADMIN'
      throw err
    }
    token.value = data.token
    refreshToken.value = data.refreshToken || ''
    user.value = data.user
    localStorage.setItem(TOKEN_KEY, data.token)
    if (data.refreshToken) {
      localStorage.setItem(REFRESH_KEY, data.refreshToken)
    }
    persistUser()
    await fetchProfile()
    return data.user
  }

  async function login(phone, password) {
    const data = await api.login({ phone, password })
    // 已绑定动态码的运营账号:密码通过后须二段验证(交回登录页输码)
    if (data.needTotp) {
      const err = new Error('NEED_TOTP')
      err.code = 'NEED_TOTP'
      err.tmpToken = data.tmpToken
      throw err
    }
    return applySession(data)
  }

  /** 2FA 二段验证:凭 tmpToken + 6位动态码换取正式会话 */
  async function loginTotp(tmpToken, code) {
    const data = await api.loginTotp({ tmpToken, code })
    return applySession(data)
  }

  /** 退出登录:先吊销服务端全部 refreshToken(失败不阻塞本地清理) */
  async function logout() {
    if (token.value) {
      try {
        await api.logout()
      } catch {
        /* 服务端吊销失败不影响本地退出 */
      }
    }
    token.value = ''
    refreshToken.value = ''
    user.value = null
    permissions.value = []
    roleName.value = ''
    profileLoaded.value = false
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    localStorage.removeItem(REFRESH_KEY)
  }

  return {
    token,
    refreshToken,
    user,
    permissions,
    roleName,
    profileLoaded,
    firstAllowedPath,
    can,
    fetchProfile,
    login,
    loginTotp,
    logout
  }
})
