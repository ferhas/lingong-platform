// 任务生命周期超时治理：
//   runAutoAccept（每小时）：delivered 超 autoAcceptDays 自动验收结算（零工资金保护兜底）
//   runTimeoutReminders（每日）：delivered 第 N 天提醒企业验收；working 逾期提醒双方；recruiting 过期建议取消
import db from '../db.js'
import { getConfig } from '../services/configStore.js'
import { acceptAndSettle } from '../services/settlement.js'
import { notify, notifyCompany } from '../services/notify.js'
import { raiseAlert } from '../services/risk.js'

export async function runAutoAccept() {
  const days = getConfig('autoAcceptDays')
  const overdue = db.prepare(`
    SELECT t.*, c.id AS cid FROM tasks t JOIN companies c ON c.id = t.company_id
    WHERE t.status = 'delivered' AND t.delivered_at <= datetime('now', 'localtime', ?)
  `).all(`-${days} days`)
  let settled = 0, blocked = 0
  for (const t of overdue) {
    const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(t.company_id)
    try {
      await acceptAndSettle(t, company)
      notifyCompany(t.company_id, 'settle', '任务已超期自动验收',
        `「${t.title}」交付已超过 ${days} 天未处理，按平台规则自动验收并结算（资金保护条款）。`)
      settled++
    } catch (err) {
      // B线缺发票 / 外部通道异常等：留痕，下轮再试
      if (err.code === 'NO_INPUT_INVOICE') {
        notify(t.worker_id, 'risk', '请上传发票以完成结算', `「${t.title}」已到自动结算期，但您尚未向平台上传发票，请尽快上传。`)
      } else if (err.code !== 'SETTLING') {
        raiseAlert('中', '自动验收受阻', `任务#${t.id} 自动验收失败：${err.message}`)
      }
      blocked++
    }
  }
  return { scanned: overdue.length, settled, blocked }
}

export function runTimeoutReminders() {
  const remindDays = getConfig('deliverRemindDays')
  let count = 0

  // 交付后第 N 天未验收 → 提醒企业
  const deliveredStale = db.prepare(`
    SELECT * FROM tasks WHERE status = 'delivered' AND date(delivered_at) = date('now', 'localtime', ?)
  `).all(`-${remindDays} days`)
  for (const t of deliveredStale) {
    notifyCompany(t.company_id, 'deliver', '验收提醒',
      `「${t.title}」交付已 ${remindDays} 天未验收，超期将按平台规则自动验收结算，请及时处理。`)
    count++
  }

  // 进行中逾期 3 天未交付 → 提醒双方
  const workingStale = db.prepare(`
    SELECT * FROM tasks WHERE status = 'working' AND date(deadline, '+3 days') = date('now', 'localtime')
  `).all()
  for (const t of workingStale) {
    notify(t.worker_id, 'deliver', '交付逾期提醒', `「${t.title}」已超截止日期 3 天，请尽快上传交付物或与企业沟通。`)
    notifyCompany(t.company_id, 'deliver', '任务逾期提醒', `「${t.title}」零工已超截止日期 3 天未交付，可与零工沟通或联系平台协商处理。`)
    count++
  }

  // 报名中过期 7 天无人录用 → 建议企业取消（解冻资金）
  const recruitingStale = db.prepare(`
    SELECT * FROM tasks WHERE status = 'recruiting' AND date(deadline, '+7 days') = date('now', 'localtime')
  `).all()
  for (const t of recruitingStale) {
    notifyCompany(t.company_id, 'cancelled', '任务长期无人承接',
      `「${t.title}」已过期 7 天仍未录用零工，建议取消任务以解冻预算资金 ¥${(t.price / 100).toFixed(2)}。`)
    count++
  }

  return { reminders: count }
}
