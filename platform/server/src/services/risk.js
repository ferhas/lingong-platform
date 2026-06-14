// 风控引擎：阈值与清单实时读取 system_configs（运营端可在线调整）
import db from '../db.js'
import { badRequest } from '../utils/errors.js'
import { getConfig } from './configStore.js'
import { notify } from './notify.js'
import { rolling12mStartPeriod } from '../utils/ids.js'

const qAlert = db.prepare(`INSERT INTO risk_alerts (level, type, detail, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)`)

export function raiseAlert(level, type, detail, refType = null, refId = null) {
  return qAlert.run(level, type, detail, refType, refId)
}

/** 反洗钱基础规则：大额 / 单日高频 / 夜间交易（结算与提现共用钩子） */
export function amlChecks({ workerId, workerName, amountCents, kind }) {
  const singleMax = getConfig('amlSingleMax') * 100
  const dailyCount = getConfig('amlDailyCount')
  const label = kind === 'withdraw' ? '提现' : '结算'

  if (amountCents > singleMax) {
    raiseAlert('中', '反洗钱-大额交易',
      `零工「${workerName}」单笔${label} ¥${(amountCents / 100).toFixed(2)} 超过大额阈值 ¥${(singleMax / 100).toFixed(0)}，请人工核查交易背景`, 'worker', workerId)
  }

  const hour = new Date().getHours()
  if (hour >= 0 && hour < 5) {
    raiseAlert('低', '反洗钱-夜间交易',
      `零工「${workerName}」于凌晨 ${hour} 点发生${label} ¥${(amountCents / 100).toFixed(2)}，纳入可疑交易观察`, 'worker', workerId)
  }

  const todayCount = kind === 'withdraw'
    ? db.prepare(`SELECT COUNT(*) AS n FROM withdrawals WHERE worker_id = ? AND date(created_at) = date('now','localtime')`).get(workerId).n
    : db.prepare(`SELECT COUNT(*) AS n FROM tax_records WHERE worker_id = ? AND date(created_at) = date('now','localtime')`).get(workerId).n
  if (todayCount > dailyCount) {
    raiseAlert('中', '反洗钱-高频交易',
      `零工「${workerName}」今日${label}已达 ${todayCount} 笔，超过 ${dailyCount} 笔阈值，请人工核查`, 'worker', workerId)
  }
}

/** 发布前置校验：计酬方式白名单 + 伪劳务违禁词（命中即阻断并留痕） */
export function checkPublish({ title, description, payMethod, companyName, companyId = null }) {
  const payMethods = getConfig('payMethods')
  const forbiddenWords = getConfig('forbiddenWords')
  if (!payMethods.includes(payMethod)) {
    raiseAlert('中', '伪劳务特征', `企业「${companyName}」尝试以非法计酬方式「${payMethod}」发布任务「${title}」，已阻断`, 'company', companyId)
    throw badRequest('PAY_METHOD_FORBIDDEN', `计酬方式仅允许：${payMethods.join('/')}（承揽合规要求）`)
  }
  const text = `${title} ${description}`
  const hit = forbiddenWords.find(w => text.includes(w))
  if (hit) {
    raiseAlert('高', '伪劳务特征', `企业「${companyName}」发布的任务「${title}」命中违禁词「${hit}」，已阻断发布`, 'company', companyId)
    throw badRequest('FORBIDDEN_WORD', `任务内容包含违禁词「${hit}」：平台禁止发布按月固定薪资/打卡考勤类任务`)
  }
}

/** 行业准入风险评级（注册时执行，结论供运营审核参考） */
export function rateIndustry(industry) {
  const blacklist = getConfig('industryBlacklist')
  const hit = blacklist.find(w => industry.includes(w))
  if (hit) return { level: '高', note: `命中行业负面清单：${hit}，建议拒绝准入或人工加强审核` }
  if (/直播|电商代运营|广告/.test(industry)) return { level: '中', note: '行业需人工加强审核业务真实性' }
  return { level: '低', note: '不在负面清单' }
}

/**
 * 结算后风控：集中度监控 + 市场主体登记双阈值。
 * 返回 locked=true 表示该零工已被锁定接单权限。
 */
export function postSettlementChecks({ workerId, workerName, companyId, companyName, period }) {
  const concentrationThreshold = getConfig('concentrationThreshold')
  const concentrationMinMonthGross = getConfig('concentrationMinMonthGross')
  const soletraderGuideMonthGross = getConfig('soletraderGuideMonthGross')
  const forceRegisterRolling12m = getConfig('forceRegisterRolling12m')

  // 主体类型：个体户（B线）已是市场主体，"个体户引导"与"强制登记阈值锁"对其均不适用；
  // 且其无 /worker/soletrader 自助解锁路径（ALREADY_SOLETRADER），一旦误锁将卡死接单。
  // 与 jobs/housekeeping.js 的 subject_type='person' 兜底保持一致（修复双站点判定不一致）。
  const subjectType = db.prepare(`SELECT subject_type FROM worker_profiles WHERE user_id = ?`).get(workerId)?.subject_type ?? 'person'

  const rows = db.prepare(`
    SELECT company_id, SUM(gross) AS g FROM tax_records
    WHERE worker_id = ? AND period = ? GROUP BY company_id
  `).all(workerId, period)
  const monthGross = rows.reduce((s, r) => s + r.g, 0)
  const fromThis = rows.find(r => r.company_id === companyId)?.g ?? 0

  // 集中度：单C端对单B端收入占比
  if (monthGross >= concentrationMinMonthGross * 100 && fromThis / monthGross > concentrationThreshold) {
    raiseAlert('高', '集中度超标',
      `零工「${workerName}」本月收入 ¥${(monthGross / 100).toFixed(2)}，来自企业「${companyName}」占比 ${Math.round(fromThis / monthGross * 100)}%，超过 ${concentrationThreshold * 100}% 阈值，请人工核查是否存在事实劳动关系`, 'worker', workerId)
  }

  // 以下"个体户引导"与"强制登记阈值锁"仅对自然人（A线）生效；个体户（已是市场主体）直接返回。
  if (subjectType !== 'person') return { locked: false }

  // 引导阈值：月收入超限推送个体户注册引导
  if (monthGross > soletraderGuideMonthGross * 100) {
    raiseAlert('低', '个体户引导',
      `零工「${workerName}」本月收入 ¥${(monthGross / 100).toFixed(2)} 已超引导阈值，系统已推送个体工商户注册引导`, 'worker', workerId)
    notify(workerId, 'guide', '个体工商户注册引导',
      '您本月收入已超过引导阈值，注册个体工商户可转入经营所得线（结算不代扣个税），详见"我的-个体工商户登记"。')
  }

  // 强制阈值：滚动12个月累计逼近上限，锁定自然人接单权限
  const sincePeriod = rolling12mStartPeriod()
  const rolling = db.prepare(`
    SELECT COALESCE(SUM(gross),0) AS g FROM tax_records WHERE worker_id = ? AND period >= ?
  `).get(workerId, sincePeriod).g
  if (rolling >= forceRegisterRolling12m * 100) {
    // lock_reason='threshold'：阈值锁，零工完成个体户登记后可自助解除（与风控人工锁 'risk' 区分，见 worker/soletrader）
    db.prepare(`UPDATE worker_profiles SET locked = 1, lock_reason = 'threshold' WHERE user_id = ?`).run(workerId)
    raiseAlert('高', '强制市场主体登记',
      `零工「${workerName}」滚动12个月累计收入 ¥${(rolling / 100).toFixed(2)} 已达强制登记阈值，自然人接单权限已锁定`, 'worker', workerId)
    notify(workerId, 'risk', '接单权限已锁定',
      '您滚动12个月累计收入已达市场主体强制登记阈值，自然人接单权限已锁定。完成个体工商户登记后即可恢复接单。')
    return { locked: true }
  }
  return { locked: false }
}
