import client from '../api/client'

/** 触发浏览器保存 Blob */
function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(objectUrl)
}

/**
 * 鉴权 CSV 下载:必须带 Bearer 头,不能 window.open。
 * 通过统一 axios 实例以 blob 获取后触发浏览器保存。
 */
export async function downloadCsv(url, filename) {
  const data = await client.get(url, { responseType: 'blob', timeout: 60000 })
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/csv;charset=utf-8' })
  saveBlob(blob, filename)
}

/** 将 JSON 数据(如证明包)格式化后保存为 .json 文件 */
export function saveJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8'
  })
  saveBlob(blob, filename)
}
