// 录用落地：报名录用与派单接受的统一核心。
// 不论零工是主动报名后被企业录用，还是企业定向派单后零工接受，
// 落地动作完全一致：电子签《分包工单》→ 按单投保 → 任务转 working → 应聘置 hired。
// 调用方各自负责鉴权与来源校验（企业录用校验报名、零工接受校验派单邀约）。
import db from '../db.js'
import { genNo, sha256, currentDate } from '../utils/ids.js'
import { getConfig } from './configStore.js'
import { esign, insurance } from '../integrations/index.js'
import { renderContract } from './contractText.js'
import { notify } from './notify.js'
import * as risk from './risk.js'
import { badRequest, conflict } from '../utils/errors.js'

/**
 * 录用指定零工。task 须处于 recruiting，函数内以条件更新消除并发录用窗口。
 * @returns {{workOrderNo:string, policyNo:string}}
 */
export async function hireWorker(task, company, workerId) {
  const worker = db.prepare(`
    SELECT u.name, p.verified, p.locked, p.real_name FROM users u JOIN worker_profiles p ON p.user_id = u.id WHERE u.id = ?
  `).get(workerId)
  if (!worker) throw badRequest('WORKER_NOT_FOUND', '零工不存在')
  if (!worker.verified) throw badRequest('WORKER_NOT_VERIFIED', '该零工未完成实名认证')
  if (worker.locked) throw badRequest('WORKER_LOCKED', '该零工接单权限已锁定')

  const subOrderNo = genNo('FB')
  const signed = await esign.sign({
    docType: 'sub_order',
    parties: ['平台', worker.real_name || worker.name],
    contentHash: sha256({ subOrderNo, taskId: task.id, subPrice: task.sub_price })
  })
  const offlineCategories = getConfig('offlineCategories')
  const plan = offlineCategories.includes(task.category) ? '高保额方案' : '基础方案'
  const premium = (plan === '高保额方案' ? getConfig('insurancePremiumHigh') : getConfig('insurancePremiumBase')) * 100
  const policy = await insurance.insure({ taskId: task.id, workerId, plan, premiumCents: premium })

  const subContent = renderContract('sub_order', {
    partyB: worker.real_name || worker.name, contractNo: subOrderNo, date: currentDate(),
    taskTitle: task.title, payMethod: task.pay_method,
    subPrice: (task.sub_price / 100).toFixed(2), policyNo: policy.policyNo, hash: signed.contentHash
  })
  db.transaction(() => {
    // 状态条件更新：消除并发录用窗口（多个请求同时通过外层检查时，仅第一个生效）
    const updated = db.prepare(
      `UPDATE tasks SET status = 'working', worker_id = ?, sub_order_no = ?, policy_no = ? WHERE id = ? AND status = 'recruiting'`
    ).run(workerId, subOrderNo, policy.policyNo, task.id)
    if (updated.changes === 0) throw conflict('BAD_STATUS', '该任务已被录用，请刷新')
    // 应聘置 hired：派单零工可能无 applications 行，缺则补一条来源 dispatch 的已录用记录
    const app = db.prepare(`SELECT id FROM applications WHERE task_id = ? AND worker_id = ?`).get(task.id, workerId)
    if (app) db.prepare(`UPDATE applications SET status = 'hired' WHERE id = ?`).run(app.id)
    else db.prepare(`INSERT INTO applications (task_id, worker_id, status, source) VALUES (?, ?, 'hired', 'dispatch')`).run(task.id, workerId)
    // 其余报名者一并落选；未响应的派单邀约置为取消
    db.prepare(`UPDATE applications SET status = 'rejected' WHERE task_id = ? AND worker_id != ? AND status = 'applied'`).run(task.id, workerId)
    db.prepare(`UPDATE dispatches SET status = 'cancelled', responded_at = datetime('now','localtime') WHERE task_id = ? AND worker_id != ? AND status = 'invited'`).run(task.id, workerId)
    db.prepare(`
      INSERT INTO contracts (type, no, party_a, party_b, company_id, worker_id, task_id, content_hash, esign_id, content)
      VALUES ('sub_order', ?, '平台', ?, ?, ?, ?, ?, ?, ?)
    `).run(subOrderNo, worker.real_name || worker.name, company.id, workerId, task.id, signed.contentHash, signed.esignId, subContent)
    db.prepare(`
      INSERT INTO insurance_policies (policy_no, task_id, worker_id, plan, premium)
      VALUES (?, ?, ?, ?, ?)
    `).run(policy.policyNo, task.id, workerId, plan, premium)
  })()

  notify(workerId, 'hired', '已被录用', `您已被录用承接「${task.title}」，分包工单 ${subOrderNo} 已电子签，意外险已生效。请按交付标准完成并上传成果。`)

  // 防"员转零"：录用零工实名在该企业历史发薪名单中 → 高风险预警（方案模块8）。
  // 白名单豁免：运营经《存量人员合规迁移评估》确认为长期合作自由职业者的，标记 exempt 后放行不预警。
  const payrollHit = db.prepare(`SELECT 1 FROM payroll_names WHERE company_id = ? AND name = ? AND exempt = 0`)
    .get(company.id, worker.real_name || worker.name)
  if (payrollHit) {
    risk.raiseAlert('高', '防员转零',
      `企业「${company.company_name}」录用的零工「${worker.real_name || worker.name}」出现在该企业历史发薪名单中，疑似将原员工转为零工接单，请人工核查劳动关系`, 'company', company.id)
  }

  return { workOrderNo: subOrderNo, policyNo: policy.policyNo }
}
