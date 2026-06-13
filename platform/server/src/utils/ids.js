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
