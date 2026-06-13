// 业务参数读取层：数据库为唯一事实源，进程内缓存，写入时失效。
// 算税引擎、风控、结算均通过本模块取参，运营端改值即时生效。
import db from '../db.js'

let cache = null

function loadAll() {
  if (cache) return cache
  cache = {}
  for (const row of db.prepare(`SELECT key, value FROM system_configs`).all()) {
    cache[row.key] = JSON.parse(row.value)
  }
  return cache
}

export function getConfig(key) {
  const all = loadAll()
  if (!(key in all)) throw new Error(`未知配置项: ${key}`)
  return all[key]
}

export function getAllConfigs() {
  return db.prepare(`SELECT key, value, grp, label, updated_at FROM system_configs ORDER BY grp, key`).all()
    .map(r => ({ key: r.key, value: JSON.parse(r.value), group: r.grp, label: r.label, updatedAt: r.updated_at }))
}

export function setConfig(key, value, userId) {
  const row = db.prepare(`SELECT value FROM system_configs WHERE key = ?`).get(key)
  if (!row) throw new Error(`未知配置项: ${key}`)
  const oldValue = JSON.parse(row.value)
  // 类型一致性：新值必须与默认值同构（数字/字符串/数组）
  if (Array.isArray(oldValue) !== Array.isArray(value) || (!Array.isArray(oldValue) && typeof oldValue !== typeof value)) {
    throw new Error(`配置 ${key} 类型不匹配`)
  }
  // 数值防御：金额/比率类配置不允许负数与非有限值；比率类不得超过 1
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`配置 ${key} 必须为非负有效数字`)
    if (/Rate|Threshold$/.test(key) && value > 1) throw new Error(`配置 ${key} 为比率，取值应在 0-1 之间`)
  }
  if (Array.isArray(value) && value.some(v => typeof v !== 'string' || !v.trim())) {
    throw new Error(`配置 ${key} 列表项必须为非空文本`)
  }
  db.prepare(`
    UPDATE system_configs SET value = ?, updated_at = datetime('now','localtime'), updated_by = ? WHERE key = ?
  `).run(JSON.stringify(value), userId ?? null, key)
  cache = null
  return { key, value, oldValue }
}

export function invalidate() {
  cache = null
}
