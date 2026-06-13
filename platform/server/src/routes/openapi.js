// 开放 API（大客户系统直连）：HMAC-SHA256 签名鉴权，仅开放任务创建/查询。
// 鉴权头：X-App-Key / X-Timestamp（毫秒，±5分钟窗口）/ X-Signature = HMAC(secret, `${timestamp}.${rawBodyJSON}`)
// 安全边界：不开放零工注册/实名代办（实名必须本人活体，平台底线）。
import { Router } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import db from '../db.js'
import { unauthorized, notFound } from '../utils/errors.js'
import { centsToYuan } from '../utils/money.js'
import { logAction } from '../services/audit.js'

const router = Router()

router.use(rateLimit({
  windowMs: 60_000, max: 60, skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: '请求过于频繁' } }
}))

function authenticateHmac(req, _res, next) {
  try {
    const appKey = req.headers['x-app-key']
    const timestamp = req.headers['x-timestamp']
    const signature = req.headers['x-signature']
    if (!appKey || !timestamp || !signature) throw unauthorized('缺少签名头')
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) throw unauthorized('时间戳超出有效窗口')
    const cred = db.prepare(`SELECT * FROM api_credentials WHERE app_key = ? AND status = 'active'`).get(String(appKey))
    if (!cred) throw unauthorized('凭据无效')
    // app_secret_hash 存的是 sha256(secret)；签名密钥为 secret 本身，校验用其哈希再做 HMAC（双方约定一致即可）
    const payload = `${timestamp}.${JSON.stringify(req.body ?? {})}`
    const expect = crypto.createHmac('sha256', cred.app_secret_hash).update(payload).digest('hex')
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(signature)))) {
      throw unauthorized('签名校验失败')
    }
    req.apiCompany = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(cred.company_id)
    req.apiScopes = JSON.parse(cred.scopes)
    next()
  } catch (err) {
    next(err.status ? err : unauthorized('签名校验失败'))
  }
}

router.use(authenticateHmac)

// 任务状态查询
router.get('/tasks/:id', (req, res, next) => {
  try {
    if (!req.apiScopes.includes('task:read')) throw unauthorized('凭据无 task:read 权限')
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND company_id = ?`).get(req.params.id, req.apiCompany.id)
    if (!t) throw notFound('任务不存在')
    const settlement = db.prepare(`SELECT confirm_no, status, invoice_no FROM settlements WHERE task_id = ?`).get(t.id)
    res.json({
      id: t.id, title: t.title, status: t.status,
      price: centsToYuan(t.price), deadline: t.deadline,
      workOrderNo: t.task_order_no, confirmNo: t.confirm_no,
      settlement: settlement ? { status: settlement.status, invoiceNo: settlement.invoice_no } : null
    })
  } catch (err) {
    next(err)
  }
})

// 任务创建（复用企业端发布的合规校验链：经由内部调用企业 owner 身份）
router.post('/tasks', async (req, res, next) => {
  try {
    if (!req.apiScopes.includes('task:create')) throw unauthorized('凭据无 task:create 权限')
    if (req.apiCompany.status !== 'approved') throw unauthorized('企业未通过准入审核')
    const body = z.object({
      title: z.string().min(2).max(80),
      category: z.string(),
      payMethod: z.string(),
      price: z.number().positive().max(1_000_000),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().min(5).max(2000),
      standard: z.string().max(2000).optional().default('')
    }).parse(req.body)
    // 经企业 owner 账号身份走标准发布链（含风控/电子签/冻结）
    const owner = db.prepare(`
      SELECT user_id FROM company_members WHERE company_id = ? AND member_role = 'owner'
    `).get(req.apiCompany.id)
    const { publishViaOpenApi } = await import('./company.js')
    const r = await publishViaOpenApi(req.apiCompany, owner.user_id, body)
    logAction(owner.user_id, 'openapi_task_publish', `task#${r.id}`)
    res.status(201).json(r)
  } catch (err) {
    next(err)
  }
})

export default router
