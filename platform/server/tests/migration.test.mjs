// 迁移回归测试：构造 v1 旧 schema 的库,跑 db.js 迁移,验证表重建后其他表的外键仍指向新表
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'

const tmpDb = path.join(os.tmpdir(), `gigwork-mig-${Date.now()}.db`)

// —— 构造旧版库（tasks 无 cancelled、applications 无 withdrawn、users 无 status 列）——
{
  const old = new Database(tmpDb)
  old.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('worker','company','admin')),
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  company_name TEXT NOT NULL, license_no TEXT NOT NULL, industry TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT '低', risk_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', review_note TEXT, master_contract_no TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, category TEXT NOT NULL, pay_method TEXT NOT NULL,
  price INTEGER NOT NULL, sub_price INTEGER NOT NULL, deadline TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', standard TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recruiting' CHECK (status IN ('recruiting','working','delivered','settled')),
  worker_id INTEGER REFERENCES users(id),
  task_order_no TEXT, sub_order_no TEXT, policy_no TEXT, deliverable TEXT, delivered_at TEXT,
  confirm_no TEXT, settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','hired','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (task_id, worker_id)
);
-- 外键指向 tasks 的表（重建 tasks 时最容易悬空）
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  amount INTEGER NOT NULL, tax_rate TEXT NOT NULL, item TEXT NOT NULL,
  confirm_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued',
  issued_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
INSERT INTO users (role, phone, password_hash, name) VALUES ('company', '13000000000', 'x', '老企业');
INSERT INTO companies (user_id, company_name, license_no, industry) VALUES (1, '迁移测试企业', 'L123456789', '软件');
INSERT INTO tasks (company_id, title, category, pay_method, price, sub_price, deadline)
  VALUES (1, '旧任务', '设计', '按成果', 10000, 9200, '2026-01-01');
INSERT INTO applications (task_id, worker_id) VALUES (1, 1);
INSERT INTO invoices (no, company_id, task_id, amount, tax_rate, item, confirm_no)
  VALUES ('SDOLD001', 1, 1, 10000, '6%', '服务费', 'QROLD001');
`)
  old.close()
}

// —— 跑迁移（import db.js 即执行）——
process.env.DB_PATH = tmpDb
const { default: db } = await import('../src/db.js')

let passed = 0
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`) }

const tasksSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='tasks'`).get().sql
ok('tasks 表已重建（含 cancelled）', tasksSql.includes("'cancelled'"))

const appsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='applications'`).get().sql
ok('applications 表已重建（含 withdrawn）', appsSql.includes("'withdrawn'"))

const invSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='invoices'`).get().sql
ok('invoices 外键仍指向 tasks（未悬空到 tasks_old）', invSql.includes('REFERENCES tasks(') && !invSql.includes('tasks_old'))

ok('无 tasks_old 残留表', !db.prepare(`SELECT 1 FROM sqlite_master WHERE name='tasks_old'`).get())

const task = db.prepare(`SELECT * FROM tasks WHERE id = 1`).get()
ok('旧数据完整迁移', task.title === '旧任务' && task.price === 10000)

const fkErrors = db.prepare(`PRAGMA foreign_key_check`).all()
ok('全库外键完整性校验通过', fkErrors.length === 0)

// 实际写入验证：cancelled 状态可用、外键约束生效
db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = 1`).run()
ok('新状态 cancelled 可写入', db.prepare(`SELECT status FROM tasks WHERE id=1`).get().status === 'cancelled')

let threw = false
try {
  db.prepare(`INSERT INTO invoices (no, company_id, task_id, amount, tax_rate, item, confirm_no) VALUES ('X', 1, 9999, 1, '6%', 'x', 'x')`).run()
} catch { threw = true }
ok('外键约束实际生效（引用不存在任务被拒）', threw)

ok('用户表新列已补齐', db.prepare(`SELECT status FROM users WHERE id=1`).get().status === 'active')
ok('企业主自动迁移为 owner 成员', db.prepare(`SELECT member_role FROM company_members WHERE user_id=1`).get()?.member_role === 'owner')

console.log(`\n✅ 迁移测试 ${passed} 项通过`)
db.close()
try { fs.rmSync(tmpDb, { force: true }); fs.rmSync(tmpDb + '-wal', { force: true }); fs.rmSync(tmpDb + '-shm', { force: true }) } catch {}
