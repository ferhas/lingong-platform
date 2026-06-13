import axios from 'axios'
import { ElMessage } from 'element-plus'

export const TOKEN_KEY = 'gigwork_admin_token'
export const USER_KEY = 'gigwork_admin_user'
export const REFRESH_KEY = 'gigwork_admin_refresh'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 15000
})

client.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

/** 清空本地会话并跳转登录页(refresh 失败/无 refreshToken 时的兜底) */
function forceLogout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(REFRESH_KEY)
  ElMessage.error('登录已失效，请重新登录')
  if (window.location.pathname !== '/login') {
    window.location.href = '/login'
  }
}

// —— 透明刷新(单飞:并发 401 共用同一次 refresh,避免轮换令牌互相吊销)——
let refreshing = null

function refreshSession() {
  if (!refreshing) {
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    if (!refreshToken) return Promise.reject(new Error('NO_REFRESH_TOKEN'))
    // 用裸 axios 调 refresh,避免再次进入本拦截器造成递归
    refreshing = axios
      .post('/api/v1/auth/refresh', { refreshToken })
      .then(({ data }) => {
        localStorage.setItem(TOKEN_KEY, data.token)
        // 轮换:旧 refreshToken 已被服务端吊销,必须立即落盘新令牌
        localStorage.setItem(REFRESH_KEY, data.refreshToken)
        return data.token
      })
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
}

client.interceptors.response.use(
  response => response.data,
  async error => {
    const status = error.response?.status
    const config = error.config || {}
    const url = config.url || ''
    const isAuthApi =
      url.includes('/auth/login') || url.includes('/auth/refresh') || url.includes('/auth/totp')

    // 401:先用 refreshToken 静默换新令牌并重放原请求;refresh 也失败才登出
    if (status === 401 && !isAuthApi && !config._retried) {
      try {
        await refreshSession()
        return client({ ...config, _retried: true })
      } catch {
        forceLogout()
        return Promise.reject(error)
      }
    }

    // 静默请求(如主题偏好同步)失败时不打扰用户
    if (config.silent) {
      return Promise.reject(error)
    }
    if (status === 401 && !isAuthApi) {
      forceLogout()
    } else {
      const message = error.response?.data?.error?.message || '网络异常，请稍后重试'
      ElMessage.error(message)
    }
    return Promise.reject(error)
  }
)

export default client
