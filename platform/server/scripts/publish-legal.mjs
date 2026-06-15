// 将 src/services/legalSeeds.js 中的法律文书/合同模板正文发布到“已存在的数据库”。
//
// 为什么需要它：db.js 建库用的是 INSERT OR IGNORE，只对“全新的库”播种；线上库里已有
//   旧版文书行，不会被自动覆盖。本脚本对每份文书做内容比对，有变化才 UPDATE 并升版本，
//   幂等（再次运行即“已是最新”，不再升版本）。
//
// 用法（在 platform/server/ 下，使用与线上一致的 DB_PATH 环境变量）：
//   node scripts/publish-legal.mjs            # 实际发布
//   node scripts/publish-legal.mjs --dry-run  # 仅预览将要发生的变更，不写库
//
// 注意：tos / privacy 升版本会触发用户在下次登录时“重新同意”（这是法律文本重大更新时
//   应有的行为）。运行前建议先 node scripts/backup.mjs 做一次快照。

import db from '../src/db.js'
import { LEGAL_SEEDS } from '../src/services/legalSeeds.js'

const dryRun = process.argv.includes('--dry-run')
const FILL_MARK = '【待填写'

const qGet = db.prepare(`SELECT type, title, version, content FROM legal_docs WHERE type = ?`)
const qInsert = db.prepare(`INSERT INTO legal_docs (type, title, content) VALUES (?, ?, ?)`)
const qUpdate = db.prepare(`
  UPDATE legal_docs SET title = ?, content = ?, version = version + 1,
    updated_at = datetime('now','localtime'), updated_by = NULL WHERE type = ?
`)

let changed = 0
let unchanged = 0
const reconsentBumped = []
const needFill = []

const apply = db.transaction(() => {
  for (const [type, title, content] of LEGAL_SEEDS) {
    const cur = qGet.get(type)
    if (content.includes(FILL_MARK)) needFill.push(type)

    if (!cur) {
      if (!dryRun) qInsert.run(type, title, content)
      console.log(`  + 新增 ${type}「${title}」（${content.length} 字）`)
      changed++
      continue
    }
    if (cur.content === content && cur.title === title) {
      console.log(`  = ${type}「${cur.title}」已是最新（v${cur.version}，${cur.content.length} 字）`)
      unchanged++
      continue
    }
    const delta = `${cur.content.length} 字 → ${content.length} 字`
    if (!dryRun) qUpdate.run(title, content, type)
    console.log(`  ↑ ${type}「${title}」v${cur.version} → v${cur.version + 1}（${delta}）`)
    changed++
    if (type === 'tos' || type === 'privacy') reconsentBumped.push(type)
  }
  // --dry-run：回滚事务，保证不落库
  if (dryRun) throw { __rollback: true }
})

console.log(dryRun ? '【预览模式 --dry-run，不写库】' : '【发布法律文书】')
try {
  apply()
} catch (e) {
  if (!e || e.__rollback !== true) throw e
}

console.log(`\n小结：${changed} 份变更/新增，${unchanged} 份无变化。`)
if (reconsentBumped.length && !dryRun) {
  console.log(`提示：${reconsentBumped.join('、')} 已升版本，用户下次登录将被要求重新同意（符合预期）。`)
}
if (needFill.length) {
  console.log(`⚠ 待填项：${needFill.join('、')} 等文书仍含「${FILL_MARK}…】占位，请在运营端「协议/合同模板」据实补全平台运营主体的工商登记信息后再正式对外签约。`)
}
console.log(dryRun ? '（以上为预览，未写入数据库。去掉 --dry-run 即正式发布。）' : '完成。')

db.close()
