// 业务参数读取层：数据库为唯一事实源，进程内缓存，写入时失效。
// 算税引擎、风控、结算均通过本模块取参，运营端改值即时生效。
import db from '../db.js'
import { validateSpecConfig } from './deliverySpecs.js'

// 进程内缓存带 TTL：本进程 setConfig 立即失效（cache=null）；多实例(ROLE=api ×N)下其他进程
// 通过 TTL 在 CONFIG_CACHE_TTL_MS 内自动重读，避免"A 实例改配置、B 实例长期不生效"。
let cache = null
let cachedAt = 0
const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS || 10_000)

function loadAll() {
  if (cache && Date.now() - cachedAt < CONFIG_CACHE_TTL_MS) return cache
  const next = {}
  for (const row of db.prepare(`SELECT key, value FROM system_configs`).all()) {
    next[row.key] = JSON.parse(row.value)
  }
  cache = next
  cachedAt = Date.now()
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
    if (/(Rate|Threshold)$/.test(key) && value > 1) throw new Error(`配置 ${key} 为比率，取值应在 0-1 之间`)
  }
  if (Array.isArray(value) && value.some(v => typeof v !== 'string' || !v.trim())) {
    throw new Error(`配置 ${key} 列表项必须为非空文本`)
  }
  // 结构化对象配置的专项校验（交付模板）
  if (key === 'deliverySpecs') validateSpecConfig(value)
  db.prepare(`
    UPDATE system_configs SET value = ?, updated_at = datetime('now','localtime'), updated_by = ? WHERE key = ?
  `).run(JSON.stringify(value), userId ?? null, key)
  cache = null
  return { key, value, oldValue }
}

export function invalidate() {
  cache = null
}
