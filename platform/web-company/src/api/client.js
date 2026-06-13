import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '../router'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 15000
})

client.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// —— 透明刷新：同一时间只发一次 refresh，其余 401 请求等待同一 promise ——
let refreshing = null

async function refreshSession() {
  const refreshToken = localStorage.getItem('refreshToken')
  if (!refreshToken) {
    throw new Error('NO_REFRESH_TOKEN')
  }
  // 用裸 axios 避免再次走本实例拦截器
  const { data } = await axios.post('/api/v1/auth/refresh', { refreshToken })
  localStorage.setItem('token', data.token)
  localStorage.setItem('refreshToken', data.refreshToken)
  if (data.user) {
    localStorage.setItem('user', JSON.stringify(data.user))
  }
  return data.token
}

function clearSessionAndLogin() {
  localStorage.removeItem('token')
  localStorage.removeItem('refreshToken')
  localStorage.removeItem('user')
  ElMessage.error('登录已过期，请重新登录')
  router.push('/login')
}

client.interceptors.response.use(
  res => res.data,
  async err => {
    const status = err.response?.status
    const message = err.response?.data?.error?.message || err.message || '网络异常，请稍后重试'
    const url = err.config?.url || ''
    const isAuthApi = /\/auth\/(login|register|refresh)/.test(url)

    if (status === 401 && !isAuthApi) {
      // 已重放过仍 401，说明刷新得到的 token 也不可用，直接登出
      if (err.config?._retried) {
        clearSessionAndLogin()
        return Promise.reject(err)
      }
      try {
        refreshing = refreshing || refreshSession().finally(() => { refreshing = null })
        await refreshing
        // 重放原请求（请求拦截器会自动带上新 token）
        err.config._retried = true
        return client.request(err.config)
      } catch {
        clearSessionAndLogin()
        return Promise.reject(err)
      }
    }

    if (!err.config?.silent) {
      // 传 { silent: true } 的请求（主题同步、通知轮询等）静默失败
      ElMessage.error(message)
    }
    return Promise.reject(err)
  }
)

export default client
