// 造一条 arbitrating（仲裁举证）争议，用于跑运营端"裁决→执行"UI 流程。
import db from '../server/src/db.js'
const task = db.prepare(`SELECT id, company_id, worker_id FROM tasks WHERE worker_id IS NOT NULL AND status IN ('settled','delivered') AND id NOT IN (SELECT task_id FROM disputes) ORDER BY id DESC LIMIT 1`).get()
if (!task) { console.log('no eligible task'); process.exit(1) }
const no = 'DSX' + Date.now()
const id = db.prepare(`INSERT INTO disputes (no,task_id,type,initiator_role,initiator_id,claim,claim_amount,status,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))`)
  .run(no, task.id, 'acceptance', 'worker', task.worker_id, '成果已按标准交付并提交验收材料，企业迟迟未验收，申请平台仲裁并按约结算。', 100000, 'arbitrating').lastInsertRowid
db.prepare(`INSERT INTO dispute_events (dispute_id,actor_role,actor_id,action,content,attachment_ids,created_at) VALUES (?,?,?,?,?,'[]',datetime('now','localtime'))`)
  .run(id, 'worker', task.worker_id, 'create', '发起验收争议，已上传交付物与沟通记录。')
console.log('arbitrating dispute created: id=' + id + ' no=' + no + ' task=' + task.id)
