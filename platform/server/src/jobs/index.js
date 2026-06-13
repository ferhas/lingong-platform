// 定时任务注册器：index.js 启动时调用（测试环境不启动，测试直接调用各 run* 纯函数）。
// 每次执行结果记录至 job_runs（/metrics 与运营端系统健康页据此做"Job 哑死"检测）。
import cron from 'node-cron'
import db from '../db.js'
import { runSettlementRetry } from './settlementRetry.js'
import { runWithdrawals } from './withdrawals.js'
import { runAutoAccept, runTimeoutReminders } from './taskTimeout.js'
import { runDailyRecon } from './dailyRecon.js'
import { runHousekeeping } from './housekeeping.js'
import { runDisputeTimeouts, runTicketSla, runWebhookRetry, runRechargeExpire } from './housekeeping2.js'

const qRun = db.prepare(`
  INSERT INTO job_runs (job, last_run_at, last_success_at, last_result, last_error)
  VALUES (?, datetime('now','localtime'), ?, ?, ?)
  ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at,
    last_success_at = COALESCE(excluded.last_success_at, job_runs.last_success_at),
    last_result = COALESCE(excluded.last_result, job_runs.last_result),
    last_error = excluded.last_error
`)

function wrap(name, fn) {
  return async () => {
    try {
      const r = await fn()
      qRun.run(name, new Date().toISOString().replace('T', ' ').slice(0, 19), JSON.stringify(r ?? {}), null)
      if (r && Object.values(r).some(v => v > 0)) console.log(`[job:${name}]`, JSON.stringify(r))
    } catch (err) {
      qRun.run(name, null, null, String(err.message).slice(0, 200))
      console.error(`[job:${name}] 执行失败:`, err.message)
    }
  }
}

export function startJobs() {
  cron.schedule('*/5 * * * *', wrap('settlementRetry', runSettlementRetry))   // 每5分钟：结算重试
  cron.schedule('*/2 * * * *', wrap('withdrawals', runWithdrawals))           // 每2分钟：提现处理（生产可改 T+1）
  cron.schedule('0 * * * *', wrap('autoAccept', runAutoAccept))               // 每小时：超期自动验收
  cron.schedule('0 9 * * *', wrap('timeoutReminders', runTimeoutReminders))   // 每日09:00：超时提醒
  cron.schedule('0 1 * * *', wrap('dailyRecon', () => runDailyRecon()))       // 每日01:00：T+1对账（含逐笔差异）
  cron.schedule('30 3 * * *', wrap('housekeeping', runHousekeeping))          // 每日03:30：数据治理
  cron.schedule('*/10 * * * *', wrap('disputeTimeouts', runDisputeTimeouts))  // 每10分钟：争议超时流转
  cron.schedule('*/15 * * * *', wrap('ticketSla', runTicketSla))              // 每15分钟：工单 SLA 升级
  cron.schedule('*/5 * * * *', wrap('webhookRetry', runWebhookRetry))         // 每5分钟：回调事件补单重放
  cron.schedule('*/30 * * * *', wrap('rechargeExpire', runRechargeExpire))    // 每30分钟：充值单/导出申请过期
  console.log('[jobs] 10 个定时任务已注册')
}
