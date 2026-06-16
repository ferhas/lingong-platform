import crypto from 'node:crypto'

// 审计日志防篡改哈希链的「单行规范化哈希」。
// hash(row) = sha256( prev_hash + 关键字段 )，链式串联使任意一行被改/删/插都会令其后所有行的哈希对不上。
// 字段与顺序一旦定下不可随意调整（db.js 升级回填、audit.js 写入、verifyChain 三处必须完全一致）。
export const GENESIS = 'GENESIS'

// 不可打印分隔符，避免相邻字段拼接产生歧义（如 "a"+"bc" 与 "ab"+"c" 撞哈希）
const SEP = String.fromCharCode(1)

export function auditRowHash(prev, r) {
  const canon = [
    prev,
    r.user_id ?? '',
    r.action ?? '',
    r.detail ?? '',
    r.detail_json ?? '',
    r.ip ?? '',
    r.user_agent ?? '',
    r.geo ?? '',
    r.created_at ?? ''
  ].join(SEP)
  return 'sha256:' + crypto.createHash('sha256').update(canon).digest('hex')
}
