// 「模拟进去看」零工端：复用小程序登录页的一键模拟登录（固定 code → 体验账号 陈志远），
// 然后按 App 的页面顺序逐屏拉取后端数据，打印一份「进去看到了什么」的速览。
// 用法：node scripts/walk-worker.mjs   （需先启动 server 且已 npm run demo）
const API = process.env.API_BASE || 'http://127.0.0.1:3000/api/v1'
const MOCK_CODE = 'demo-worker-2month-001' // 与 demoSeed.js / 登录页 MOCK_CODE 一致

const j = v => JSON.stringify(v)
async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? j(body) : undefined
  })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${j(data)}`)
  return data
}

const H = s => console.log(`\n\x1b[36m━━ ${s} \x1b[0m`)
const L = (k, v) => console.log(`   ${k.padEnd(14)} ${v}`)
const yuan = n => `¥${Number(n).toLocaleString('zh-CN')}`
const arr = v => Array.isArray(v) ? v : (v?.list ?? [])
const tally = (list, key) => {
  const m = {}
  for (const x of list) m[x[key]] = (m[x[key]] || 0) + 1
  return Object.entries(m).map(([k, c]) => `${k}×${c}`).join('  ') || '（无）'
}

// 1) 一键模拟登录
H('① 登录页 → 点「模拟登录（体验账号）」')
const session = await call('/auth/wechat', { method: 'POST', body: { code: MOCK_CODE } })
const T = session.token
L('登录方式', `POST /auth/wechat  code=${MOCK_CODE}（开发态确定性 mock）`)
L('登录身份', `${session.user.name}  ${session.user.phone}  role=${session.user.role}  id=${session.user.id}`)

const me = await call('/auth/me', { token: T })
L('当前用户', `${me.name}（${me.role}）`)

// 2) 我的（个人 + 实名/绑卡）
H('② 我的（pages/mine）')
const profile = await call('/worker/profile', { token: T })
L('实名', profile.verified ? `已实名${profile.faceVerified ? '·已人脸核身' : ''}（${profile.name}）` : '未实名')
L('主体类型', profile.subjectType === 'soletrader' ? '个体工商户(B线)' : '自然人(A线)')
L('绑卡', profile.cardBound ? `已绑卡 ${profile.bankCard}` : '未绑卡')
L('信用', `${profile.credit?.creditScore ?? '—'} 分（${profile.credit?.grade ?? '—'}）  评价${profile.credit?.avgScore ?? '—'}★  已结算${profile.credit?.settledCount ?? 0}单`)
L('框架协议', profile.frameContractNo || '—')

// 3) 收入（pages/income）
H('③ 收入（pages/income）')
const income = await call('/worker/income', { token: T })
L('可提现', yuan(income.account.balance))
L('冻结中', yuan(income.account.frozen))
L('年度税前', yuan(income.taxSummary.yearGross))
L('已预扣个税', yuan(income.taxSummary.yearTax))
L('收入月份数', `${income.taxSummary.months} 个月  连续 ${income.taxSummary.consecutiveMonths} 个月`)
L('个税记录', `${income.records.length} 条；最近：${income.records.slice(0, 3).map(r => `${r.taskTitle} 税前${yuan(r.gross)}/到手${yuan(r.net)}`).join(' | ')}`)
try {
  const monthly = await call('/worker/income/monthly', { token: T })
  const pts = arr(monthly)
  L('收入曲线', `${pts.length} 个月：${pts.map(p => `${p.period || p.month}:${yuan(p.net ?? p.amount ?? 0)}`).join('  ')}`)
} catch (e) { L('收入曲线', `（/income/monthly：${e.message}）`) }

// 4) 我的接单（pages/orders）
H('④ 我的接单（pages/orders）')
const orders = arr(await call('/worker/orders', { token: T }))
L('订单总数', `${orders.length} 单`)
L('按状态', tally(orders, 'status'))
L('在接/待验收', orders.filter(o => ['working', 'delivered'].includes(o.status)).map(o => `${o.title}(${o.status})`).join('  ') || '（无）')

// 5) 任务大厅（pages/index）
H('⑤ 任务大厅（pages/index）')
const hall = arr(await call('/worker/tasks', { token: T }))
L('招募中', `${hall.length} 个任务`)
L('举例', hall.slice(0, 5).map(t => `${t.title} ${yuan(t.price)}`).join('  |  '))

// 6) 派单邀约（pages/orders 内）
H('⑥ 派单邀约（dispatches）')
const disp = arr(await call('/worker/dispatches', { token: T }))
L('邀约', `${disp.length} 条：${tally(disp, 'status')}`)

// 7) 收藏 / 技能 / 合同 / 发票 / 保险 / 提现
H('⑦ 其它页')
const safe = async (label, p) => { try { const d = arr(await call(p, { token: T })); L(label, `${d.length} 条`); return d } catch (e) { L(label, `（${e.message}）`); return [] } }
await safe('收藏', '/worker/favorites')
const skills = await safe('技能认证', '/worker/skills')
if (skills.length) L('  技能明细', skills.map(s => `${s.skill}/${s.level}(${s.status})`).join('  '))
await safe('合同', '/worker/contracts')
await safe('发票', '/worker/invoices')
await safe('保单', '/worker/policies')
await safe('理赔', '/worker/claims')
const wds = await safe('提现记录', '/worker/withdrawals')
if (wds.length) L('  提现明细', wds.map(w => `${yuan(w.amount)}(${w.status})`).join('  '))

console.log('\n\x1b[32m✓ 已模拟「点一键登录 → 进去看」走完零工端主要页面。\x1b[0m')
