import { ApiError } from '../utils/errors.js'
import { ZodError } from 'zod'

export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } })
  }
  if (err instanceof ZodError) {
    const msg = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } })
  }
  // multer 文件过大
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { code: 'FILE_TOO_LARGE', message: '文件超过大小限制' } })
  }
  if (req.log) {
    req.log.error({ err, reqId: req.id }, 'unhandled error')
  } else {
    console.error('[unhandled]', err)
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } })
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } })
}
