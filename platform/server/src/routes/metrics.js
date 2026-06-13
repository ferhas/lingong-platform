// Prometheus 文本格式业务指标（仅内网/监控系统抓取；配置 METRICS_TOKEN 后须携带 ?token= 或 Bearer）
// 关键告警指标：结算 pending 最老龄 / failed 数 / 提现在途最老龄 / 对账差异 / 负余额账户 / Job 哑死 / 回调积压
import { Router } from 'express'
import db from '../db.js'
import config from '../config.js'

const router = Router()

router.get('/', (req, res) => {
  if (config.metricsToken) {
    const token = req.query.token || String(req.headers.authorization || '').replace('Bearer ', '')
    if (token !== config.metricsToken) return res.status(401).send('# unauthorized\n')
  }
  const lines = []
  const gauge = (name, help, value, labels = '') => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`)
  }
  const ageSeconds = ts => ts ? Math.max(0, Math.round((Date.now() - new Date(ts.replace(' ', 'T')).getTime()) / 1000)) : 0

  const pending = db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM settlements WHERE status = 'pending'`).get()
  gauge('settlement_pending_total', '待推进结算单数', pending.n)
  gauge('settlement_pending_oldest_age_seconds', '最老 pending 结算单龄期（秒）', ageSeconds(pending.oldest))
  gauge('settlement_failed_total', 'failed 结算单数（>0 应立即告警）',
    db.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE status = 'failed'`).get().n)

  const wd = db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM withdrawals WHERE status IN ('applied','processing')`).get()
  gauge('withdrawal_inflight_total', '在途提现单数', wd.n)
  gauge('withdrawal_inflight_oldest_age_seconds', '最老在途提现龄期（秒，>86400 告警）', ageSeconds(wd.oldest))

  const recon = db.prepare(`SELECT * FROM reconciliation_daily ORDER BY day DESC LIMIT 1`).get()
  gauge('recon_daily_diff_cents', '最近一日对账差异（分，≠0 电话告警）', recon?.diff ?? 0)
  gauge('recon_open_diff_items', '未处置逐笔对账差异数',
    db.prepare(`SELECT COUNT(*) AS n FROM recon_diffs WHERE status = 'open'`).get().n)

  gauge('account_negative_balance_total', '负余额/冻结异常账户数（>0 资金完整性破坏，立即电话）',
    db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE balance < 0 OR frozen < 0 OR balance < frozen`).get().n)

  gauge('risk_alerts_open_high', '未处置高风险预警数',
    db.prepare(`SELECT COUNT(*) AS n FROM risk_alerts WHERE status = 'open' AND level = '高'`).get().n)

  gauge('webhook_backlog_total', '待处理/失败回调事件数',
    db.prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE status IN ('received','failed')`).get().n)

  gauge('disputes_open_total', '处理中争议数',
    db.prepare(`SELECT COUNT(*) AS n FROM disputes WHERE status IN ('negotiating','arbitrating','ruled')`).get().n)

  gauge('tickets_open_urgent', '未首响紧急工单数',
    db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE priority = 'urgent' AND first_reply_at IS NULL AND status NOT IN ('resolved','closed')`).get().n)

  // Job 哑死检测：now - last_success > 2×周期 即告警（阈值在告警侧配置）
  for (const j of db.prepare(`SELECT * FROM job_runs`).all()) {
    gauge('job_last_success_age_seconds', '各定时任务距上次成功执行的秒数', ageSeconds(j.last_success_at), `{job="${j.job}"}`)
  }

  const sms = db.prepare(`
    SELECT status, COUNT(*) AS n FROM message_logs WHERE created_at >= datetime('now','localtime','-1 day') GROUP BY status
  `).all()
  for (const s of sms) {
    gauge('sms_sent_24h_total', '近24小时短信外发量', s.n, `{status="${s.status}"}`)
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(lines.join('\n') + '\n')
})

export default router
