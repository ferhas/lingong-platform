// 智能税务计算引擎：按主体类型路由
// A线（自然人）：劳务报酬所得，平台为法定扣缴义务人，个税"累计预扣法"+ 增值税免征额监控
// B线（个体工商户）：经营所得，平台不代扣，结算前校验其开票，此处 tax=0
// 全部参数实时读取 system_configs（运营端可在线调整）
import db from '../db.js'
import { mulRate } from '../utils/money.js'
import { currentPeriod } from '../utils/ids.js'
import { getConfig } from './configStore.js'

// 综合所得七级累进（年度，元）
const BRACKETS = [
  [36000, 0.03, 0],
  [144000, 0.1, 2520],
  [300000, 0.2, 16920],
  [420000, 0.25, 31920],
  [660000, 0.3, 52920],
  [960000, 0.35, 85920],
  [Infinity, 0.45, 181920]
]

function progressiveTaxCents(taxableCents) {
  if (taxableCents <= 0) return 0
  const taxableYuan = taxableCents / 100
  for (const [cap, rate, quick] of BRACKETS) {
    if (taxableYuan <= cap) {
      return Math.max(0, Math.round((taxableYuan * rate - quick) * 100))
    }
  }
  return 0
}

const qYearStats = db.prepare(`
  SELECT COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(tax),0) AS tax,
         COUNT(DISTINCT period) AS months
  FROM tax_records WHERE worker_id = ? AND period LIKE ? AND method='cumulative'
`)

const qMonthSales = db.prepare(`
  SELECT COALESCE(SUM(gross),0) AS sales FROM tax_records WHERE worker_id = ? AND period = ?
`)

// 连续段（同一年内、断月即止）已结算累计：用于累计预扣的"累计收入/累计已预扣"
const qSegStats = db.prepare(`
  SELECT COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(tax),0) AS tax
  FROM tax_records WHERE worker_id = ? AND method='cumulative' AND period >= ? AND period <= ?
`)

// 某月是否取得 A 线（劳务报酬累计预扣）报酬：仅按 cumulative 口径判断连续性
const qMonthCumSales = db.prepare(`
  SELECT COALESCE(SUM(gross),0) AS sales FROM tax_records
  WHERE worker_id = ? AND period = ? AND method='cumulative'
`)

export function yearStats(workerId, year) {
  return qYearStats.get(workerId, `${year}-%`)
}

export function monthSales(workerId, period) {
  return qMonthSales.get(workerId, period).sales
}

/**
 * 连续取得劳务报酬的月份数（含本月）与连续段起始月份。
 * 依据国税总局2025年第16号公告：从本月起在同一纳税年度内逐月向前回溯，
 * 遇到无 A 线报酬的月份即中断，断月之后重新起算累计（减除费用 5000×连续月份）。
 * @returns {{months:number, startPeriod:string}}
 */
export function consecutiveRun(workerId, period) {
  const year = Number(period.slice(0, 4))
  const curMonth = Number(period.slice(5, 7))
  let months = 1 // 本月计入（正在结算本月报酬）
  for (let m = curMonth - 1; m >= 1; m--) {
    const p = `${year}-${String(m).padStart(2, '0')}`
    if (qMonthCumSales.get(workerId, p).sales > 0) months++
    else break
  }
  const startMonth = curMonth - (months - 1)
  return { months, startPeriod: `${year}-${String(startMonth).padStart(2, '0')}` }
}

/** 截至 period（含本月）的连续接单月份数，供零工端展示 */
export function consecutiveMonths(workerId, period) {
  return consecutiveRun(workerId, period).months
}

/**
 * 计算本次结算应预扣个税与代办增值税（A线）。
 * @returns {{tax:number, vat:number, detail:object}} 均为分
 */
export function calcWithholding(workerId, grossCents, period) {
  const laborExpenseRate = getConfig('laborExpenseRate')
  const monthlyDeduction = getConfig('monthlyDeduction')
  const vatFreeMonthlySales = getConfig('vatFreeMonthlySales')
  const vatRate = getConfig('vatRate')

  // 累计区间对齐到"当前连续段"：断月后重新起算，累计收入与累计已预扣均限本连续段内
  const { months, startPeriod } = consecutiveRun(workerId, period)
  const seg = qSegStats.get(workerId, startPeriod, period)

  const cumGross = seg.gross + grossCents
  const taxable = mulRate(cumGross, 1 - laborExpenseRate) - months * monthlyDeduction * 100
  const cumTax = progressiveTaxCents(taxable)
  const tax = Math.max(0, cumTax - seg.tax)

  // 增值税：月销售额（含本次）超免征额，超额部分按减按征收率代办
  const salesBefore = monthSales(workerId, period)
  const salesAfter = salesBefore + grossCents
  const freeCents = vatFreeMonthlySales * 100
  let vat = 0
  if (salesAfter > freeCents) {
    const taxedBefore = Math.max(0, salesBefore - freeCents)
    vat = mulRate(salesAfter - freeCents, vatRate) - mulRate(taxedBefore, vatRate)
  }

  return {
    tax,
    vat,
    detail: {
      method: 'cumulative',
      months,
      startPeriod,
      cumGross,
      taxable: Math.max(0, taxable),
      cumTax,
      prevWithheld: seg.tax,
      monthSales: salesAfter,
      vatFree: salesAfter <= freeCents
    }
  }
}

const qSubjectType = db.prepare(`SELECT subject_type FROM worker_profiles WHERE user_id = ?`)

/** 任务详情页收入预估（按当前累计口径试算，按主体类型路由） */
export function estimateForWorker(workerId, subPriceCents) {
  const subjectType = qSubjectType.get(workerId)?.subject_type ?? 'person'
  // B线（个体工商户）：经营所得，平台不代扣个税、不代办增值税，结算前由其自行开票、自行申报
  if (subjectType === 'soletrader') {
    return { subjectType, gross: subPriceCents, tax: 0, vat: 0, net: subPriceCents }
  }
  const period = currentPeriod()
  const { tax, vat } = calcWithholding(workerId, subPriceCents, period)
  return { subjectType, gross: subPriceCents, tax, vat, net: subPriceCents - tax - vat }
}
