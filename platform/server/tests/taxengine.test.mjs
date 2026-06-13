// 算税引擎边界单测：0元、免征额临界、累进跳档、月份数累计
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDb = path.join(os.tmpdir(), `gigwork-tax-${Date.now()}.db`)
process.env.DB_PATH = tmpDb
process.env.NODE_ENV = 'test'

const { default: db } = await import('../src/db.js')
const { calcWithholding } = await import('../src/services/taxEngine.js')

let passed = 0
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`) }

// 造零工 + 占位企业与任务（满足外键）
db.prepare(`INSERT INTO users (role, phone, password_hash, name) VALUES ('worker','13000000001','x','边界测试')`).run()
const wid = db.prepare(`SELECT id FROM users WHERE phone='13000000001'`).get().id
db.prepare(`INSERT INTO users (role, phone, password_hash, name) VALUES ('company','13000000002','x','占位企业')`).run()
const cuid = db.prepare(`SELECT id FROM users WHERE phone='13000000002'`).get().id
db.prepare(`INSERT INTO companies (user_id, company_name, license_no, industry) VALUES (?,'占位企业','L00000001','软件')`).run(cuid)
const cid = db.prepare(`SELECT id FROM companies WHERE user_id=?`).get(cuid).id
db.prepare(`INSERT INTO tasks (company_id, title, category, pay_method, price, sub_price, deadline) VALUES (?,'占位任务','设计','按成果',1,1,'2099-01-01')`).run(cid)
const tid = db.prepare(`SELECT id FROM tasks WHERE company_id=?`).get(cid).id
const insertRecord = db.prepare(`
  INSERT INTO tax_records (worker_id, task_id, company_id, gross, tax, vat, net, method, period)
  VALUES (?, ${tid}, ${cid}, ?, ?, ?, ?, 'cumulative', ?)
`)

console.log('— 算税引擎边界 —')

// 0 元
let r = calcWithholding(wid, 0, '2026-01')
ok('0元报酬税额为0', r.tax === 0 && r.vat === 0)

// 月减除以内（5000元月减除 → 6250元毛额*0.8=5000 恰好不纳税）
r = calcWithholding(wid, 625000, '2026-01')
ok('应纳税所得恰为0时不预扣', r.tax === 0)

// 略超减除：6262.5元*0.8=5010 → 10元*3%=0.3元
r = calcWithholding(wid, 626250, '2026-01')
ok('超出部分按3%档精确到分', r.tax === 30)

// 增值税免征额临界：单月恰好10万 → 免征
r = calcWithholding(wid, 10000000, '2026-02')
ok('月销售额恰为10万免征增值税', r.vat === 0)

// 超1分钱 → 超额部分1%
r = calcWithholding(wid, 10000001, '2026-03')
ok('超免征额1分起征（超额部分1%）', r.vat === Math.round(1 * 0.01))

// 累计预扣跳档：第一笔3万（3%档内），落库后第二笔10万应跳到10%档
insertRecord.run(wid, 3000000, calcWithholding(wid, 3000000, '2026-04').tax, 0, 0, '2026-04')
const first = db.prepare(`SELECT tax FROM tax_records WHERE worker_id=? AND period='2026-04'`).get(wid).tax
r = calcWithholding(wid, 10000000, '2026-04')
// 累计 13万*0.8 - 5000 = 99000 → 9900-2520=7380元 cumTax；减去已扣
ok('累计预扣跳档差额准确', first + r.tax === 738000)

// 连续月份数：4月已落库3万（taxable 19000 → 570元），5月再结7000 → 月份数2
// 累计 3.7万*0.8 - 10000 = 19600 → 588元 cumTax → 本次 588-570 = 18元
r = calcWithholding(wid, 700000, '2026-05')
ok('跨月减除费用按月累计', r.tax === 1800)

// 断月重置（16号公告）：8月有收入、9月断档，10月重新起算累计
// 仅本月（10月）计入连续段 → 月份数=1、减除费用只扣一次 5000
insertRecord.run(wid, 1000000, calcWithholding(wid, 1000000, '2026-08').tax, 0, 0, '2026-08')
r = calcWithholding(wid, 626250, '2026-10')
ok('断月后连续月份数重置为1', r.detail.months === 1 && r.detail.startPeriod === '2026-10')
ok('断月后累计区间不含断档前收入', r.tax === 30) // 6262.5*0.8-5000=10元 → 0.3元

// 不断月则继续累计：紧接 10 月再在 11 月结算 → 月份数=2
insertRecord.run(wid, 626250, r.tax, 0, 0, '2026-10')
r = calcWithholding(wid, 626250, '2026-11')
ok('连续月份数随月递增', r.detail.months === 2 && r.detail.startPeriod === '2026-10')

console.log(`\n✅ 算税边界 ${passed} 项通过`)
db.close()
try { fs.rmSync(tmpDb, { force: true }); fs.rmSync(tmpDb + '-wal', { force: true }); fs.rmSync(tmpDb + '-shm', { force: true }) } catch {}
