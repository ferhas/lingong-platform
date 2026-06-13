// 金额内部一律以"分"（整数）存储与计算，仅在 API 边界转换为元

export function yuanToCents(yuan) {
  const n = Number(yuan)
  if (!Number.isFinite(n)) throw new Error('invalid amount')
  return Math.round(n * 100)
}

export function centsToYuan(cents) {
  return Math.round(cents) / 100
}

// 按比例取整到分
export function mulRate(cents, rate) {
  return Math.round(cents * rate)
}
