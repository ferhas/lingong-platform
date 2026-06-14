import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { pinoHttp } from 'pino-http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import config from './config.js'
import authRoutes from './routes/auth.js'
import workerRoutes from './routes/worker.js'
import companyRoutes from './routes/company.js'
import adminRoutes from './routes/admin.js'
import meRoutes from './routes/me.js'
import filesRoutes from './routes/files.js'
import webhookRoutes from './routes/webhooks.js'
import adminOpsRoutes from './routes/adminOps.js'
import openApiRoutes from './routes/openapi.js'
import metricsRoutes from './routes/metrics.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'

const app = express()
const isTest = process.env.NODE_ENV === 'test'

// 安全响应头
app.use(helmet())
app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }))
// 三方回调验签基于原始报文字节，必须挂载在 express.json 之前
app.use('/api/v1/webhooks', webhookRoutes)
// 保留原始请求字节（开放 API HMAC 按原文验签，避免 JSON.stringify 重排键序导致签名不稳定）
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf } }))

// 结构化请求日志（测试静默）
app.use(pinoHttp({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  genReqId: () => crypto.randomUUID(),
  autoLogging: { ignore: req => req.url === '/healthz' }
}))

// 全局限流 + 敏感接口严格限流（测试环境跳过，登录锁定逻辑独立于此仍然生效）
const skip = () => isTest
app.use(rateLimit({ windowMs: 60_000, max: 300, skip, standardHeaders: true, legacyHeaders: false }))
const strictLimiter = rateLimit({
  windowMs: 60_000, max: 20, skip, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } }
})
app.use('/api/v1/auth/login', strictLimiter)
app.use('/api/v1/auth/register', strictLimiter)
app.use('/api/v1/auth/sms-code', strictLimiter)
app.use('/api/v1/auth/totp', strictLimiter)
app.use('/api/v1/worker/withdraw', strictLimiter)

app.get('/healthz', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

app.use('/api/v1/auth', authRoutes)
app.use('/api/v1/me', meRoutes)
app.use('/api/v1/files', filesRoutes)
app.use('/api/v1/worker', workerRoutes)
app.use('/api/v1/company', companyRoutes)
app.use('/api/v1/admin', adminRoutes)
app.use('/api/v1/admin', adminOpsRoutes)
app.use('/api/open/v1', openApiRoutes)
app.use('/metrics', metricsRoutes)

// 零工端「微信小程序 → H5」静态托管（与 API 同源，避免跨域）。
// H5 运行时用极简模块装载器 + 模板表达式解释器跑原生小程序源码，需要 unsafe-eval；
// 故对 /h5 单独放宽 CSP（仅前端静态资源，无安全面）。其余接口仍受全局 helmet 约束。
const h5Dir = fileURLToPath(new URL('../../h5-worker', import.meta.url))
const h5Csp = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'self'"
  )
  next()
}
app.use('/h5', h5Csp, express.static(h5Dir, { index: 'index.html', extensions: ['html'] }))

app.use(notFoundHandler)
app.use(errorHandler)

export default app
