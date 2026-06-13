// 三方服务商回调统一入口：原始报文验签 → 幂等落库 → 同步处理（失败由补单 Job 重放）→ 快速应答。
// 生产替换验签算法为各服务商规范（见证宝 RSA/SM2、e签宝 HMAC 头、百望 AES+sign）；
// mock 约定：X-Webhook-Signature = HMAC-SHA256(rawBody, WEBHOOK_SECRET) 的 hex。
import { Router } from 'express'
import express from 'express'
import crypto from 'node:crypto'
import db from '../db.js'
import config from '../config.js'
import { handleRechargePaid, handleWithdrawalResult } from '../services/escrowEvents.js'
import { raiseAlert } from '../services/risk.js'

const router = Router()
const PROVIDERS = new Set(['escrow', 'einvoice', 'esign', 'insurance'])

function verifySignature(rawBody, signature) {
  if (!signature) return false
  const expect = crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(signature)))
  } catch {
    return false
  }
}

/** 事件处理器注册表（必须幂等：补单 Job 会重放 received/failed 事件） */
export function processEvent(provider, eventType, data) {
  const key = `${provider}:${eventType}`
  switch (key) {
    case 'escrow:recharge.success':
      return handleRechargePaid({ orderNo: data.orderNo, escrowTxnNo: data.txnNo, amount: data.amount })
    case 'escrow:withdrawal.result':
      return handleWithdrawalResult({
        withdrawalId: Number(data.withdrawalId), success: !!data.success,
        escrowTxnNo: data.txnNo, failReason: data.failReason
      })
    case 'einvoice:invoice.issued': {
      const r = db.prepare(`UPDATE invoices SET status = 'issued', no = COALESCE(?, no) WHERE id = ? AND status = 'issuing'`)
        .run(data.invoiceNo ?? null, Number(data.invoiceId))
      return { ok: true, updated: r.changes }
    }
    case 'esign:flow.finished': {
      const r = db.prepare(`UPDATE contracts SET file_url = ? WHERE esign_id = ?`).run(data.fileUrl ?? null, data.esignId)
      return { ok: true, updated: r.changes }
    }
    case 'insurance:claim.update': {
      const r = db.prepare(`
        UPDATE claims SET status = ?, result = COALESCE(?, result),
          closed_at = CASE WHEN ? = 'closed' THEN datetime('now','localtime') ELSE closed_at END
        WHERE policy_no = ? AND status != 'closed'
      `).run(data.status, data.result ?? null, data.status, data.policyNo)
      return { ok: true, updated: r.changes }
    }
    default:
      throw new Error(`未注册的事件类型：${key}`)
  }
}

/** 重放单个事件（webhook 入口、补单 Job、运营端手工重放共用） */
export function replayEvent(event) {
  try {
    processEvent(event.provider, event.event_type, JSON.parse(event.payload))
    db.prepare(`UPDATE webhook_events SET status = 'processed', error = NULL, processed_at = datetime('now','localtime') WHERE id = ?`)
      .run(event.id)
    return { ok: true }
  } catch (err) {
    db.prepare(`UPDATE webhook_events SET status = 'failed', error = ? WHERE id = ?`)
      .run(String(err.message).slice(0, 200), event.id)
    return { ok: false, error: err.message }
  }
}

// 各服务商验签基于原始字节：本路由必须挂载在全局 express.json 之前
router.post('/:provider', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const provider = req.params.provider
  if (!PROVIDERS.has(provider)) {
    return res.status(404).json({ error: { code: 'UNKNOWN_PROVIDER', message: '未知服务商' } })
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))

  if (!verifySignature(raw, req.headers['x-webhook-signature'])) {
    // 伪造回调攻击留痕（不落事件表，避免污染补单队列）
    raiseAlert('高', '回调验签失败', `服务商 ${provider} 回调验签失败（来源IP ${req.ip}），疑似伪造回调，请安全核查`)
    return res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: '验签失败' } })
  }

  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: '报文非合法JSON' } })
  }
  const { eventId, eventType, data } = body
  if (!eventId || !eventType) {
    return res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: '缺少 eventId / eventType' } })
  }

  // 幂等消重：同 provider+eventId 重复推送直接成功应答
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO webhook_events (provider, event_id, event_type, payload) VALUES (?, ?, ?, ?)
  `).run(provider, String(eventId), String(eventType), JSON.stringify(data ?? {}))
  const event = db.prepare(`SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?`).get(provider, String(eventId))
  if (!inserted.changes && event.status === 'processed') {
    return res.json({ code: 'SUCCESS', duplicated: true })
  }

  // 同步处理（mock 时延可忽略；真实接入后处理失败由补单 Job 兜底重放）
  const r = replayEvent(event)
  res.json(r.ok ? { code: 'SUCCESS' } : { code: 'RETRY_LATER', message: r.error })
})

export default router
