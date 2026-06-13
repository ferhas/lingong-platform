// 合同正文渲染：从 legal_docs 模板读取条款，签署时替换占位符生成快照存档
import db from '../db.js'

const qDoc = db.prepare(`SELECT * FROM legal_docs WHERE type = ?`)

export function getLegalDoc(type) {
  return qDoc.get(type)
}

/** 渲染模板：{{key}} → vars[key]，缺失值留空 */
export function renderContract(type, vars) {
  const doc = qDoc.get(type)
  if (!doc) return ''
  return doc.content.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''))
}

export function bumpLegalDoc(type, content, userId) {
  const doc = qDoc.get(type)
  if (!doc) throw new Error('未知文书类型')
  db.prepare(`
    UPDATE legal_docs SET content = ?, version = version + 1,
      updated_at = datetime('now','localtime'), updated_by = ? WHERE type = ?
  `).run(content, userId, type)
  return qDoc.get(type)
}

export function listLegalDocs() {
  return db.prepare(`SELECT type, title, version, content, updated_at FROM legal_docs ORDER BY type`).all()
}

/** 注册时记录协议同意（当前版本留痕） */
export function recordAgreements(userId, types = ['tos', 'privacy']) {
  const stmt = db.prepare(`INSERT INTO agreements (user_id, doc_type, version) VALUES (?, ?, ?)`)
  for (const t of types) {
    const doc = qDoc.get(t)
    if (doc) stmt.run(userId, t, doc.version)
  }
}
