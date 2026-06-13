import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { pinoHttp } from 'pino-http'
import crypto from 'node:crypto'
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
app.use(express.json({ limit: '1mb' }))

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

app.use(notFoundHandler)
app.use(errorHandler)

export default app
