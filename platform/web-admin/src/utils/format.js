/** 金额格式化：千分位 + 两位小数，带 ¥ 前缀 */
export function fmtMoney(value, { sign = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '¥0.00'
  const abs = Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
  const prefix = n < 0 ? '-' : sign && n > 0 ? '+' : ''
  return `${prefix}¥${abs}`
}

/** 时间显示：统一为 YYYY-MM-DD HH:mm */
export function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return String(value)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
