/** 统一分页参数解析（page ≥1，pageSize 1-100） */
export function pageParams(req) {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
  return { page, pageSize, offset: (page - 1) * pageSize }
}
