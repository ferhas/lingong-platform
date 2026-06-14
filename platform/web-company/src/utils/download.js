import client from '../api/client'

/**
 * 鉴权下载文件：axios blob（带 Bearer token），前端触发保存。
 * @param {string} url 形如 /api/v1/files/<uuid> 或 /files/<uuid>
 * @param {string} name 保存的文件名
 */
export async function downloadFile(url, name) {
  // client baseURL 为 /api/v1，后端返回的 url 带 /api/v1 前缀，去掉避免重复
  const path = url.replace(/^\/api\/v1/, '')
  const blob = await client.get(path, { responseType: 'blob' })
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = name || 'download'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // 即便 DOM 步骤异常也释放对象 URL，避免内存泄漏
    URL.revokeObjectURL(objectUrl)
  }
}
