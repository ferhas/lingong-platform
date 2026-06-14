// API 客户端：自动附带 token、统一错误提示、401 透明刷新（单飞）、刷新失败跳登录
let refreshing = null

function rawRequest(method, path, data) {
  const app = getApp()
  return new Promise((resolve, reject) => {
    wx.request({
      url: app.globalData.apiBase + path,
      method,
      data,
      header: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + (wx.getStorageSync('token') || '')
      },
      success: res => resolve(res),
      fail: () => reject(new Error('network'))
    })
  })
}

function logoutToLogin() {
  wx.removeStorageSync('token')
  wx.removeStorageSync('refreshToken')
  wx.removeStorageSync('user')
  wx.reLaunch({ url: '/pages/login/login' })
}

function refreshSession() {
  if (refreshing) return refreshing
  const rt = wx.getStorageSync('refreshToken')
  if (!rt) return Promise.resolve(false)
  refreshing = rawRequest('POST', '/auth/refresh', { refreshToken: rt })
    .then(res => {
      if (res.statusCode === 200 && res.data.token) {
        wx.setStorageSync('token', res.data.token)
        wx.setStorageSync('refreshToken', res.data.refreshToken)
        return true
      }
      return false
    })
    .catch(() => false)
    .finally(() => { refreshing = null })
  return refreshing
}

async function request(method, path, data, retried) {
  let res
  try {
    res = await rawRequest(method, path, data)
  } catch (e) {
    wx.showToast({ title: '网络异常，请检查服务是否启动', icon: 'none' })
    throw e
  }
  if (res.statusCode >= 200 && res.statusCode < 300) return res.data

  // 401：先尝试用 refreshToken 换新会话并重放一次
  if (res.statusCode === 401 && !retried && !path.startsWith('/auth/')) {
    const ok = await refreshSession()
    if (ok) return request(method, path, data, true)
    logoutToLogin()
  } else if (res.statusCode === 401) {
    logoutToLogin()
  }

  const msg = (res.data && res.data.error && res.data.error.message) || '请求失败，请稍后重试'
  wx.showToast({ title: msg, icon: 'none', duration: 2500 })
  const err = new Error(msg)
  err.code = res.data && res.data.error && res.data.error.code
  err.status = res.statusCode
  throw err
}

// 文件上传：wx.uploadFile 携带 token
function upload(filePath, fileName) {
  const app = getApp()
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: app.globalData.apiBase + '/files',
      filePath,
      name: 'file',
      header: { Authorization: 'Bearer ' + (wx.getStorageSync('token') || '') },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(res.data))
          return
        }
        let msg = '上传失败'
        try { msg = JSON.parse(res.data).error.message } catch (e) {}
        wx.showToast({ title: msg, icon: 'none' })
        reject(new Error(msg))
      },
      fail() {
        wx.showToast({ title: '上传失败，请检查网络', icon: 'none' })
        reject(new Error('upload failed'))
      }
    })
  })
}

// 保存登录会话（login/register/wechat 响应）
function saveSession(data) {
  wx.setStorageSync('token', data.token)
  if (data.refreshToken) wx.setStorageSync('refreshToken', data.refreshToken)
  wx.setStorageSync('user', data.user)
}

// 基础数据字典缓存：启动后从 /worker/meta 拉取类目/计酬/地点/工种/订阅模板，
// 内存 + Storage 双缓存，避免与后端运营配置脱节。失败时回退到本地兜底默认值。
const META_DEFAULT = {
  categories: ['设计', '技术', '文案', '翻译', '视频', '摄影摄像', '直播电商', '电商运营', '营销推广', '客服', '教育培训', '咨询', '数据标注', '跨境边贸', '文旅', '配送', '物流仓储', '安装', '施工', '制造生产', '农业', '家政服务', '其他'],
  payMethods: ['按成果', '按件', '按单'],
  cities: ['远程', '南宁', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左', '其他'],
  trades: [],
  reviewTags: ['按时交付', '质量过硬', '沟通顺畅', '响应及时', '需求清晰', '验收爽快'],
  subscribeTmplIds: []
}
let metaMem = null

// 同步读取已缓存字典（内存→Storage→默认）。用于必须在点击手势同步上下文调用的场景（订阅消息授权）。
function metaSync() {
  return metaMem || wx.getStorageSync('worker_meta') || META_DEFAULT
}

async function meta(force) {
  if (metaMem && !force) return metaMem
  const cached = wx.getStorageSync('worker_meta')
  if (cached && !force) metaMem = cached
  try {
    const fresh = await request('GET', '/worker/meta')
    metaMem = { ...META_DEFAULT, ...fresh }
    wx.setStorageSync('worker_meta', metaMem)
  } catch (e) {
    metaMem = metaMem || cached || META_DEFAULT
  }
  return metaMem
}

module.exports = {
  get: (path, params) => {
    if (params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')
      if (qs) path += (path.includes('?') ? '&' : '?') + qs
    }
    return request('GET', path)
  },
  post: (path, data) => request('POST', path, data),
  patch: (path, data) => request('PATCH', path, data),
  del: (path) => request('DELETE', path),
  meta,
  metaSync,
  upload,
  saveSession
}
