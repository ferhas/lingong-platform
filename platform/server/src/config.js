import 'dotenv/config'
import { fileURLToPath } from 'node:url'

const isProd = process.env.NODE_ENV === 'production'
const DEFAULT_SECRET = 'dev-only-secret-change-in-production'
const jwtSecret = process.env.JWT_SECRET || DEFAULT_SECRET

// 生产环境强制要求强随机密钥，否则拒绝启动
if (isProd && (jwtSecret === DEFAULT_SECRET || jwtSecret.length < 32)) {
  console.error('[FATAL] 生产环境必须通过环境变量设置 ≥32 位的 JWT_SECRET')
  process.exit(1)
}
if (!isProd && jwtSecret === DEFAULT_SECRET) {
  console.warn('[WARN] 正在使用开发用默认 JWT_SECRET，生产部署前必须更换')
}

// 生产环境 CORS 白名单不得包含通配符或本机地址
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174').split(',')
if (isProd && corsOrigins.some(o => o === '*' || o.includes('localhost') || o.includes('127.0.0.1'))) {
  console.error('[FATAL] 生产环境 CORS_ORIGINS 不得包含 * / localhost / 127.0.0.1')
  process.exit(1)
}

// 生产环境 webhook 验签密钥必须独立配置
const webhookSecret = process.env.WEBHOOK_SECRET || 'dev-webhook-secret-change-in-production'
if (isProd && webhookSecret.includes('dev-webhook')) {
  console.error('[FATAL] 生产环境必须通过环境变量设置 WEBHOOK_SECRET')
  process.exit(1)
}

// 生产环境敏感凭据加密密钥(SECRETS_KEY)必须独立配置：缺失则 services/secrets.js 会派生自 JWT_SECRET，
// 既弱化密钥隔离，又会在日后轮换 JWT_SECRET 时令已存身份证密文不可解（资损/合规风险）。比照上面 fail-closed。
const secretsKey = process.env.SECRETS_KEY || ''
if (isProd && secretsKey.length < 16) {
  console.error('[FATAL] 生产环境必须通过环境变量设置 SECRETS_KEY（≥16 位随机，建议 KMS 托管）')
  process.exit(1)
}

const config = {
  isProd,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  // 进程角色：all=API+定时任务（默认）；api=仅API（多实例水平扩展）；worker=仅定时任务（独立部署）
  role: process.env.ROLE || 'all',
  jwtSecret,
  webhookSecret,
  metricsToken: process.env.METRICS_TOKEN || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  dbPath: process.env.DB_PATH || fileURLToPath(new URL('../data/gigwork.db', import.meta.url)),
  uploadDir: process.env.UPLOAD_DIR || fileURLToPath(new URL('../uploads', import.meta.url)),
  corsOrigins,

  // 登录防爆破
  loginMaxFails: Number(process.env.LOGIN_MAX_FAILS || 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES || 15),

  // 上传限制
  uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024),
  uploadMimeWhitelist: [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ]
}

export default config
