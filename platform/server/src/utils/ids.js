import crypto from 'node:crypto'

function dateStamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function rand(n = 6) {
  return crypto.randomInt(0, 10 ** n).toString().padStart(n, '0')
}

// 业务单号：前缀 + 日期 + 随机
export const genNo = prefix => `${prefix}${dateStamp()}${rand()}`

// 高熵临时密码（满足≥10位含字母数字策略，128位熵）
export const genTempPassword = () => 'Gw' + crypto.randomBytes(16).toString('hex')

export const sha256 = obj =>
  'sha256:' + crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')

export function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function currentDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function currentQuarter() {
  const d = new Date()
  return `${d.getFullYear()}Q${Math.ceil((d.getMonth() + 1) / 3)}`
}

// 滚动12个月（含本月）窗口的起始 period（YYYY-MM，本地时区按自然月回溯）。
// 强制市场主体登记阈值的统一窗口口径：风控即时校验(risk.js)与每日兜底(jobs/housekeeping.js)共用，
// 杜绝两站点一处用日历月、一处用365天导致的触发时点漂移。
export function rolling12mStartPeriod() {
  const d = new Date()
  d.setMonth(d.getMonth() - 11)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
