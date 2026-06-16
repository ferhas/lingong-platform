import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import config from './config.js'
import { LEGAL_SEEDS } from './services/legalSeeds.js'
import { auditRowHash, GENESIS } from './utils/auditHash.js'

const dbDir = path.dirname(config.dbPath)
fs.mkdirSync(dbDir, { recursive: true })

const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
// 并发写兜底：多进程（ROLE=api ×N + worker）共享同一库文件时，写锁竞争不立即抛 SQLITE_BUSY，
// 而是最多等待 5s 重试，配合"重读最新态 + 条件更新"的乐观并发模型，避免高并发下偶发写失败。
// 注：这是单机多进程的缓解；真正的高并发资金场景应迁移 PostgreSQL（见审计报告 B 轴）。
db.pragma('busy_timeout = 5000')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('worker','company','admin')),
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  admin_role_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, id DESC);

-- 运营端 RBAC 角色（permissions 为 JSON 数组，'*' 表示全部）
CREATE TABLE IF NOT EXISTS admin_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL
);

-- 企业子账号成员关系
CREATE TABLE IF NOT EXISTS company_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  member_role TEXT NOT NULL CHECK (member_role IN ('owner','operator','finance')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_members_company ON company_members(company_id);

CREATE TABLE IF NOT EXISTS worker_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  verified INTEGER NOT NULL DEFAULT 0,
  real_name TEXT,
  id_card_masked TEXT,
  bank_card_masked TEXT,
  subject_type TEXT NOT NULL DEFAULT 'person' CHECK (subject_type IN ('person','soletrader')),
  frame_contract_no TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  company_name TEXT NOT NULL,
  license_no TEXT NOT NULL,
  industry TEXT NOT NULL,
  contact_phone TEXT,
  contact_email TEXT,
  risk_level TEXT NOT NULL DEFAULT '低',
  risk_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT,
  master_contract_no TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status, id DESC);

-- 资金账户：余额/冻结均以分计
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('company','worker','platform_tax','platform_revenue')),
  owner_id INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  frozen INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS fund_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL CHECK (type IN ('recharge','freeze','unfreeze','settle_out','settle_in','withdraw','tax_in','revenue_in')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_flows_account ON fund_flows(account_id, id DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,            -- 任务大类（categories 配置）
  trade TEXT,                        -- 工种/细分技能（skillCatalog 配置，二级筛选与技能匹配用）
  city TEXT NOT NULL DEFAULT '远程',  -- 工作地点（cities 配置；线上任务为"远程"）
  pay_method TEXT NOT NULL,
  price INTEGER NOT NULL,            -- 承揽价（分）
  sub_price INTEGER NOT NULL,        -- 分包价（分）
  deadline TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  standard TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recruiting'
    CHECK (status IN ('recruiting','working','delivered','settled','cancelled')),
  worker_id INTEGER REFERENCES users(id),
  task_order_no TEXT,                -- 任务工单（总承揽合同附件）
  sub_order_no TEXT,                 -- 分包工单（与零工电子签）
  policy_no TEXT,                    -- 按单保单
  deliverable TEXT,
  delivered_at TEXT,
  confirm_no TEXT,                   -- 业务交易确认单
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, id DESC);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','hired','rejected','withdrawn')),
  source TEXT NOT NULL DEFAULT 'apply',   -- apply=零工主动报名 / dispatch=企业派单后接受
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (task_id, worker_id)
);

-- 派单邀约：企业向指定零工定向派单，零工须接受（电子签分包工单）方可成立承揽关系
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','accepted','rejected','cancelled')),
  note TEXT NOT NULL DEFAULT '',          -- 企业派单留言
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  responded_at TEXT,
  UNIQUE (task_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_dispatches_worker ON dispatches(worker_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_dispatches_task ON dispatches(task_id, id DESC);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('master','frame_sub','work_order','sub_order')),
  no TEXT NOT NULL UNIQUE,
  party_a TEXT NOT NULL,
  party_b TEXT NOT NULL,
  company_id INTEGER,
  worker_id INTEGER,
  task_id INTEGER,
  content_hash TEXT NOT NULL,
  esign_id TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  amount INTEGER NOT NULL,
  tax_rate TEXT NOT NULL,
  item TEXT NOT NULL,
  confirm_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  issued_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 代扣代办税费记录（A线：劳务报酬累计预扣；B线：经营所得不代扣）
CREATE TABLE IF NOT EXISTS tax_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  company_id INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  vat INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cumulative','business_income')),
  income_type TEXT NOT NULL DEFAULT 'labor_continuous',  -- labor_continuous=连续性劳务报酬 / labor_other=其他劳务报酬 / business=经营所得
  consecutive_months INTEGER,                            -- A线累计预扣的连续取得报酬月份数（B线为空）
  period TEXT NOT NULL,
  tax_voucher_no TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tax_worker ON tax_records(worker_id, period);
CREATE INDEX IF NOT EXISTS idx_tax_period ON tax_records(period);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_no TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  premium INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS risk_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('高','中','低')),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolve_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON risk_alerts(status, id DESC);

CREATE TABLE IF NOT EXISTS tax_declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('monthly_declare','quarter_report')),
  period TEXT NOT NULL,
  payload TEXT NOT NULL,
  receipt_no TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (type, period)
);

-- 存管银行指令回执（对账数据源：银行侧）
CREATE TABLE IF NOT EXISTS escrow_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_no TEXT NOT NULL UNIQUE,
  from_acct TEXT NOT NULL,
  to_acct TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  detail_json TEXT,                  -- 结构化明细（含 taskId/before/after 等，供证据链时间轴精确归属）
  ip TEXT,                           -- 发起方 IP（终端证据）
  user_agent TEXT,                   -- 发起方设备/UA（终端证据）
  geo TEXT,                          -- 发起方地理位置（前端 X-Geo 上报，交付/接单取现场佐证）
  prev_hash TEXT,                    -- 防篡改哈希链：上一行 hash
  hash TEXT,                         -- 本行 hash = sha256(prev_hash + 关键字段)
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, id DESC);

-- 登录失败计数（防爆破）
CREATE TABLE IF NOT EXISTS login_attempts (
  phone TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- 用户偏好设置
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 业务参数（运营端在线编辑，算税/风控引擎实时读取）
CREATE TABLE IF NOT EXISTS system_configs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  grp TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by INTEGER
);

-- 上传文件（UUID 主键防遍历）
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 任务附件（交付物 / B线发票）
CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  kind TEXT NOT NULL CHECK (kind IN ('deliverable','invoice')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_attach_task ON task_attachments(task_id);

-- 结算单据（两阶段结算：预结算 pending → 外部分账/开票 → done；失败由 Job 重试）
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
  confirm_no TEXT NOT NULL UNIQUE,
  worker_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  vat INTEGER NOT NULL,
  net INTEGER NOT NULL,
  margin INTEGER NOT NULL,
  method TEXT NOT NULL,
  income_type TEXT NOT NULL DEFAULT 'labor_continuous',
  consecutive_months INTEGER,
  tax_voucher_no TEXT,
  invoice_no TEXT,
  legs_done TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status, id);

-- 提现申请单（applied → processing → done / failed）
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  bank_card TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','processing','done','failed')),
  escrow_txn_no TEXT,
  fail_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_worker ON withdrawals(worker_id, id DESC);

-- 每日对账结果（T+1）
CREATE TABLE IF NOT EXISTS reconciliation_daily (
  day TEXT PRIMARY KEY,
  bank_total INTEGER NOT NULL,
  bank_txns INTEGER NOT NULL,
  platform_total INTEGER NOT NULL,
  platform_flows INTEGER NOT NULL,
  diff INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('balanced','mismatch')),
  checked_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 法律文书：注册协议与合同模板（运营端可编辑，带版本）
CREATE TABLE IF NOT EXISTS legal_docs (
  type TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by INTEGER
);

-- 协议同意留痕（注册即记录文书类型与版本）
CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  doc_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  agreed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_agreements_user ON agreements(user_id);

-- 抽查回访（业务真实性人工核验留痕）
CREATE TABLE IF NOT EXISTS callbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','abnormal')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at TEXT,
  done_by INTEGER,
  UNIQUE (task_id)
);

-- 保险理赔
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_no TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','processing','closed')),
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_worker ON claims(worker_id, id DESC);

-- 防员转零：企业历史发薪名单（录用时比对）
CREATE TABLE IF NOT EXISTS payroll_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (company_id, name)
);

-- 登录日志（IP/UA 画像，支撑同IP多账号关联分析）
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ip TEXT,
  ua TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_logs(ip, user_id);

-- 刷新令牌（可吊销）
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- 审计日志归档
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  detail_json TEXT,
  ip TEXT,
  user_agent TEXT,
  geo TEXT,
  prev_hash TEXT,
  hash TEXT,
  created_at TEXT NOT NULL
);

-- 站内通知
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notify_user ON notifications(user_id, read, id DESC);

-- ============ v5 商用化新增表 ============

-- 入站回调事件（三方服务商异步通知：验签 → 幂等落库 → 异步处理 → 补单兜底）
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  processed_at TEXT,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status, id DESC);

-- 出站三方调用日志（排障与对账依据，入参出参摘要脱敏后存）
CREATE TABLE IF NOT EXISTS integration_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  biz_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','fail')),
  latency_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_intcalls_provider ON integration_calls(provider, id DESC);

-- 存管会员映射（本地账户 ↔ 银行子账户/绑卡协议号；出金用协议号，不存卡号明文）
CREATE TABLE IF NOT EXISTS escrow_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('company','worker')),
  owner_id INTEGER NOT NULL,
  member_no TEXT NOT NULL UNIQUE,
  sub_acct_no TEXT,
  bind_card_token TEXT,
  card_masked TEXT,
  status TEXT NOT NULL DEFAULT 'opened' CHECK (status IN ('opened','card_bound','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (owner_type, owner_id)
);

-- 充值单（真实资金闭环：创建单 → 银行入金回调驱动入账，余额为银行子户镜像）
CREATE TABLE IF NOT EXISTS recharge_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  amount INTEGER NOT NULL,
  pay_account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','expired')),
  escrow_txn_no TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recharge_company ON recharge_orders(company_id, id DESC);

-- 任务争议（negotiating协商 → arbitrating仲裁 → ruled裁决 → executed执行 → closed；可 withdrawn/escalated）
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL CHECK (type IN ('acceptance','payment_overdue','worker_missing','quality_after','other')),
  initiator_role TEXT NOT NULL CHECK (initiator_role IN ('worker','company','admin')),
  initiator_id INTEGER NOT NULL,
  claim TEXT NOT NULL,
  claim_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'negotiating'
    CHECK (status IN ('negotiating','arbitrating','ruled','executed','closed','withdrawn','escalated')),
  arbiter_id INTEGER,
  ruling_type TEXT CHECK (ruling_type IN ('full_pay','partial_pay','no_pay','redeliver')),
  ruling_amount INTEGER,
  ruling_note TEXT,
  stage_deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ruled_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_task ON disputes(task_id);

-- 争议时间线（举证/留言/裁决/执行全程留痕）
CREATE TABLE IF NOT EXISTS dispute_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  actor_role TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_devents_dispute ON dispute_events(dispute_id);

-- 客服工单（可挂业务对象，SLA 超时升级）
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal')),
  title TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_user','pending_agent','resolved','closed')),
  assignee_id INTEGER,
  satisfaction INTEGER,
  escalated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  first_reply_at TEXT,
  resolved_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, id DESC);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  sender TEXT NOT NULL CHECK (sender IN ('user','agent','system')),
  sender_id INTEGER,
  content TEXT NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON ticket_messages(ticket_id);

-- 消息模板（多通道触达：inapp站内信 / sms短信 / subscribe小程序订阅消息，运营端可编辑）
CREATE TABLE IF NOT EXISTS message_templates (
  code TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('inapp','sms','subscribe')),
  title_tpl TEXT NOT NULL,
  body_tpl TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 外发消息日志（短信计费审计与触达率统计）
CREATE TABLE IF NOT EXISTS message_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  phone TEXT,
  channel TEXT NOT NULL,
  template_code TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  provider_msg_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msglogs_user ON message_logs(user_id, id DESC);

-- 短信验证码（注册/登录/提现/绑卡/改密，带频控与错误计数）
CREATE TABLE IF NOT EXISTS sms_codes (
  phone TEXT NOT NULL,
  scene TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (phone, scene)
);

-- 零工敏感凭据（身份证号 AES-256-GCM 信封加密 + HMAC 查重索引；仅投保/涉税报送服务内解密并审计）
CREATE TABLE IF NOT EXISTS worker_secrets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  id_card_cipher TEXT NOT NULL,
  id_card_hmac TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 个人信息批量导出审批（PIPL：申请 → 审批 → 限时下载，全程审计）
CREATE TABLE IF NOT EXISTS export_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  row_estimate INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','downloaded','expired')),
  approver_id INTEGER,
  approve_note TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  approved_at TEXT,
  downloaded_at TEXT
);

-- B线进项发票台账（结构化：发票号/金额/类型/认证状态，支撑进项认证与优化看板）
CREATE TABLE IF NOT EXISTS input_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  upload_id TEXT REFERENCES uploads(id),
  invoice_no TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  invoice_type TEXT NOT NULL DEFAULT 'normal' CHECK (invoice_type IN ('normal','special')),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','verified','rejected','deducted')),
  verify_note TEXT,
  verified_by INTEGER,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_input_inv_task ON input_invoices(task_id);

-- 双向互盲评价（结算后双方互评，双方都评完或窗口期满后互相可见）
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('company','worker')),
  reviewer_id INTEGER NOT NULL,
  reviewee_id INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  tags TEXT NOT NULL DEFAULT '[]',
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (task_id, reviewer_role)
);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id, reviewer_role);

-- 零工技能认证（证书人工审核，徽章展示与推荐使用）
CREATE TABLE IF NOT EXISTS worker_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  skill TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT '初级',
  cert_upload_id TEXT REFERENCES uploads(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verify_note TEXT,
  verified_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (worker_id, skill)
);

-- 任务收藏（零工端"我的收藏"）
CREATE TABLE IF NOT EXISTS task_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (worker_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_worker ON task_favorites(worker_id, id DESC);

-- 帮助中心文章
CREATE TABLE IF NOT EXISTS help_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('worker','company','all')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','draft')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by INTEGER
);

-- 开放 API 凭据（HMAC 签名鉴权，仅开放任务创建/查询，不开放代注册）
CREATE TABLE IF NOT EXISTS api_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  app_key TEXT NOT NULL UNIQUE,
  app_secret_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["task:create","task:read"]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 逐笔对账差异（T+1 对账由总额轧差升级为逐笔核销，差异 3 个工作日内平账）
CREATE TABLE IF NOT EXISTS recon_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('bank_only','platform_only')),
  ref_no TEXT NOT NULL,
  amount INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolve_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recon_diffs ON recon_diffs(status, day);

-- 定时任务运行记录（Job 哑死检测：/metrics 与运营端系统健康页读取）
CREATE TABLE IF NOT EXISTS job_runs (
  job TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_success_at TEXT,
  last_result TEXT,
  last_error TEXT
);
`)

// ============ 幂等迁移（兼容旧库） ============

function hasColumn(table, column) {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column)
}

if (!hasColumn('users', 'status')) {
  db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
}
if (!hasColumn('users', 'admin_role_id')) {
  db.exec(`ALTER TABLE users ADD COLUMN admin_role_id INTEGER`)
}
if (!hasColumn('companies', 'contact_phone')) {
  db.exec(`ALTER TABLE companies ADD COLUMN contact_phone TEXT`)
}
if (!hasColumn('companies', 'contact_email')) {
  db.exec(`ALTER TABLE companies ADD COLUMN contact_email TEXT`)
}
if (!hasColumn('contracts', 'content')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN content TEXT`)
}
if (!hasColumn('users', 'wx_openid')) {
  db.exec(`ALTER TABLE users ADD COLUMN wx_openid TEXT`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_openid ON users(wx_openid) WHERE wx_openid IS NOT NULL`)
}
if (!hasColumn('risk_alerts', 'ref_type')) {
  db.exec(`ALTER TABLE risk_alerts ADD COLUMN ref_type TEXT`)
  db.exec(`ALTER TABLE risk_alerts ADD COLUMN ref_id INTEGER`)
}
if (!hasColumn('escrow_txns', 'idem_key')) {
  db.exec(`ALTER TABLE escrow_txns ADD COLUMN idem_key TEXT`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_idem ON escrow_txns(idem_key) WHERE idem_key IS NOT NULL`)
}

// —— v5 商用化列迁移 ——
if (!hasColumn('tasks', 'dispute_id')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN dispute_id INTEGER`)
}
if (!hasColumn('settlements', 'ruled_gross')) {
  db.exec(`ALTER TABLE settlements ADD COLUMN ruled_gross INTEGER`)
}
if (!hasColumn('invoices', 'red_invoice_no')) {
  db.exec(`ALTER TABLE invoices ADD COLUMN red_invoice_no TEXT`)
  db.exec(`ALTER TABLE invoices ADD COLUMN original_invoice_id INTEGER`)
  db.exec(`ALTER TABLE invoices ADD COLUMN void_reason TEXT`)
}
if (!hasColumn('users', 'totp_secret')) {
  db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`)
  db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`)
}
if (!hasColumn('tax_declarations', 'status')) {
  db.exec(`ALTER TABLE tax_declarations ADD COLUMN status TEXT NOT NULL DEFAULT 'filed'`)
}
if (!hasColumn('worker_profiles', 'credit_score')) {
  db.exec(`ALTER TABLE worker_profiles ADD COLUMN credit_score INTEGER NOT NULL DEFAULT 600`)
  db.exec(`ALTER TABLE worker_profiles ADD COLUMN invited_by_company_id INTEGER`)
  db.exec(`ALTER TABLE worker_profiles ADD COLUMN face_verified INTEGER NOT NULL DEFAULT 0`)
}
// 接单锁定原因：'threshold'=强制登记阈值锁（登记个体户可自助解除）/ 'risk'=风控人工锁（仅运营可解，零工不能绕过）
if (!hasColumn('worker_profiles', 'lock_reason')) {
  db.exec(`ALTER TABLE worker_profiles ADD COLUMN lock_reason TEXT`)
}
if (!hasColumn('companies', 'invite_code')) {
  db.exec(`ALTER TABLE companies ADD COLUMN invite_code TEXT`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_invite ON companies(invite_code) WHERE invite_code IS NOT NULL`)
  db.exec(`ALTER TABLE companies ADD COLUMN esign_authorized INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE companies ADD COLUMN esign_auth_at TEXT`)
}
if (!hasColumn('withdrawals', 'member_no')) {
  db.exec(`ALTER TABLE withdrawals ADD COLUMN member_no TEXT`)
}
if (!hasColumn('payroll_names', 'exempt')) {
  db.exec(`ALTER TABLE payroll_names ADD COLUMN exempt INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE payroll_names ADD COLUMN exempt_note TEXT`)
}
if (!hasColumn('contracts', 'file_url')) {
  db.exec(`ALTER TABLE contracts ADD COLUMN file_url TEXT`)
}

// —— 回调事件死信计数：连续失败达上限转 ignored（毒丸事件熔断，避免补单 Job 无限重放）——
if (!hasColumn('webhook_events', 'attempts')) {
  db.exec(`ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`)
}

// —— v6 派单（定向派单）列迁移 ——
if (!hasColumn('applications', 'source')) {
  db.exec(`ALTER TABLE applications ADD COLUMN source TEXT NOT NULL DEFAULT 'apply'`)
}

// —— 基础数据扩充：任务地点（city）与工种（trade）——
if (!hasColumn('tasks', 'city')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN city TEXT NOT NULL DEFAULT '远程'`)
}
if (!hasColumn('tasks', 'trade')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN trade TEXT`)
}

// —— v6 连续性劳务（16号公告）所得项目与连续月份列迁移 ——
if (!hasColumn('tax_records', 'income_type')) {
  db.exec(`ALTER TABLE tax_records ADD COLUMN income_type TEXT NOT NULL DEFAULT 'labor_continuous'`)
  db.exec(`ALTER TABLE tax_records ADD COLUMN consecutive_months INTEGER`)
  // 旧数据回填：B线（business_income）记为经营所得
  db.exec(`UPDATE tax_records SET income_type = 'business' WHERE method = 'business_income'`)
}
if (!hasColumn('settlements', 'income_type')) {
  db.exec(`ALTER TABLE settlements ADD COLUMN income_type TEXT NOT NULL DEFAULT 'labor_continuous'`)
  db.exec(`ALTER TABLE settlements ADD COLUMN consecutive_months INTEGER`)
  db.exec(`UPDATE settlements SET income_type = 'business' WHERE method = 'business_income'`)
}

// —— 按工种结构化交付：交付内容 JSON 快照列（{specRef, fields[], uploads[]}）——
if (!hasColumn('tasks', 'deliverable_data')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN deliverable_data TEXT`)
}

// —— 证据链强化：审计日志补终端证据列（IP/UA/geo）+ 结构化明细 + 防篡改哈希链 ——
if (!hasColumn('audit_logs', 'detail_json')) {
  db.exec(`ALTER TABLE audit_logs ADD COLUMN detail_json TEXT`)
  db.exec(`ALTER TABLE audit_logs ADD COLUMN ip TEXT`)
  db.exec(`ALTER TABLE audit_logs ADD COLUMN user_agent TEXT`)
  db.exec(`ALTER TABLE audit_logs ADD COLUMN geo TEXT`)
  db.exec(`ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT`)
  db.exec(`ALTER TABLE audit_logs ADD COLUMN hash TEXT`)
}
for (const col of ['detail_json', 'ip', 'user_agent', 'geo', 'prev_hash', 'hash']) {
  if (!hasColumn('audit_logs_archive', col)) {
    db.exec(`ALTER TABLE audit_logs_archive ADD COLUMN ${col} TEXT`)
  }
}
// 升级回填：为既有未上链的历史审计行按 id 顺序计算哈希链，使全表从首行起可验。
if (db.prepare(`SELECT 1 FROM audit_logs WHERE hash IS NULL LIMIT 1`).get()) {
  const rows = db.prepare(`SELECT * FROM audit_logs ORDER BY id ASC`).all()
  const upd = db.prepare(`UPDATE audit_logs SET prev_hash = ?, hash = ? WHERE id = ?`)
  db.transaction(() => {
    let prev = GENESIS
    for (const r of rows) {
      if (r.hash) { prev = r.hash; continue }
      const h = auditRowHash(prev, { ...r, prev_hash: prev })
      upd.run(prev, h, r.id)
      prev = h
    }
  })()
}

// 旧库 tasks.status CHECK 不含 cancelled / applications 不含 withdrawn → 重建表
function rebuildIfCheckMissing(table, marker, createSql) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)
  if (!row || row.sql.includes(marker)) return
  db.exec('PRAGMA foreign_keys = OFF')
  // legacy 模式：RENAME 不改写其他表中指向本表的外键引用（SQLite 官方12步迁移流程要求）
  db.exec('PRAGMA legacy_alter_table = ON')
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`)
    db.exec(createSql)
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name)
    const oldCols = db.prepare(`SELECT name FROM pragma_table_info('${table}_old')`).all().map(c => c.name)
    const common = cols.filter(c => oldCols.includes(c)).join(',')
    db.exec(`INSERT INTO ${table} (${common}) SELECT ${common} FROM ${table}_old`)
    db.exec(`DROP TABLE ${table}_old`)
  })()
  db.exec('PRAGMA legacy_alter_table = OFF')
  const fkErrors = db.prepare(`PRAGMA foreign_key_check`).all()
  db.exec('PRAGMA foreign_keys = ON')
  if (fkErrors.length) {
    console.error(`[FATAL] 表 ${table} 迁移后外键校验失败：`, fkErrors.slice(0, 5))
    process.exit(1)
  }
}

rebuildIfCheckMissing('tasks', "'cancelled'", `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  trade TEXT,
  city TEXT NOT NULL DEFAULT '远程',
  pay_method TEXT NOT NULL,
  price INTEGER NOT NULL,
  sub_price INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  standard TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recruiting'
    CHECK (status IN ('recruiting','working','delivered','settled','cancelled')),
  worker_id INTEGER REFERENCES users(id),
  task_order_no TEXT,
  sub_order_no TEXT,
  policy_no TEXT,
  deliverable TEXT,
  delivered_at TEXT,
  confirm_no TEXT,
  settled_at TEXT,
  dispute_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`)

rebuildIfCheckMissing('applications', "'withdrawn'", `
CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','hired','rejected','withdrawn')),
  source TEXT NOT NULL DEFAULT 'apply',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (task_id, worker_id)
)`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, id DESC)`)

// ============ 种子数据（幂等） ============

// 平台两个内部账户
db.prepare(`INSERT OR IGNORE INTO accounts (owner_type, owner_id) VALUES ('platform_tax', 0)`).run()
db.prepare(`INSERT OR IGNORE INTO accounts (owner_type, owner_id) VALUES ('platform_revenue', 0)`).run()

// RBAC 预置角色
const ROLE_SEEDS = [
  ['超级管理员', ['*']],
  ['审核专员', ['dashboard:read', 'company:read', 'company:review', 'audit:read']],
  ['风控专员', ['dashboard:read', 'risk:read', 'risk:resolve', 'worker:read', 'worker:manage', 'audit:read', 'dispute:read', 'dispute:rule', 'skill:review']],
  ['财务税务', ['dashboard:read', 'tax:read', 'tax:declare', 'flow:read', 'flow:write', 'archive:read', 'integration:read', 'finance:read']],
  ['只读审计', ['dashboard:read', 'company:read', 'worker:read', 'risk:read', 'tax:read', 'flow:read', 'archive:read', 'integration:read', 'config:read', 'audit:read', 'user:read']],
  // 客服为一线，仅 dispute:read（可见争议、走工单）；裁决/执行（动用冻结资金）属仲裁职责，已移交风控专员（最小权限）
  ['客服', ['dashboard:read', 'ticket:read', 'ticket:manage', 'dispute:read', 'worker:read', 'company:read', 'help:manage']],
  // 合规专员（PIPL/数据保护）：个人信息导出审批 + 完整 PII 查看，独立于导出申请方实现职责分离(SoD)
  ['合规专员', ['dashboard:read', 'worker:read', 'user:read_pii', 'export:approve', 'audit:read']]
]
const insertRole = db.prepare(`INSERT OR IGNORE INTO admin_roles (name, permissions) VALUES (?, ?)`)
for (const [name, perms] of ROLE_SEEDS) insertRole.run(name, JSON.stringify(perms))

// 既有 admin 用户没有角色的，赋予超级管理员
const superRole = db.prepare(`SELECT id FROM admin_roles WHERE name = '超级管理员'`).get()
db.prepare(`UPDATE users SET admin_role_id = ? WHERE role = 'admin' AND admin_role_id IS NULL`).run(superRole.id)

// 既有企业主账号迁移为 owner 成员
db.prepare(`
  INSERT OR IGNORE INTO company_members (user_id, company_id, member_role)
  SELECT user_id, id, 'owner' FROM companies
`).run()

// 业务参数入库（仅当 key 不存在时写入默认值）
// 各工种结构化交付物模板（运营端可在线编辑）。解析优先级：byTrade > byCategory > default。
// field.type ∈ text|textarea|number|date|datetime|url|tel|select；upload.accept ∈ image|file|video。
const DELIVERY_SPECS = {
  default: {
    fields: [{ key: 'note', label: '交付说明', type: 'textarea', required: true, max: 500, placeholder: '请说明交付内容、成果链接等' }],
    uploads: [{ key: 'files', label: '交付附件', accept: 'file', required: false, min: 0, max: 10, hint: '可上传成果文件/截图等' }]
  },
  byCategory: {
    设计: {
      fields: [{ key: 'note', label: '成果说明', type: 'textarea', required: true, max: 500 }, { key: 'sourceUrl', label: '源文件链接', type: 'url', required: false, max: 300, placeholder: '网盘/云文档链接' }],
      uploads: [{ key: 'preview', label: '成果预览图', accept: 'image', required: true, min: 1, max: 9 }, { key: 'source', label: '源文件', accept: 'file', required: false, min: 0, max: 3, hint: 'PSD/AI 等源文件' }]
    },
    技术: {
      fields: [{ key: 'repoUrl', label: '仓库或演示地址', type: 'url', required: true, max: 300 }, { key: 'selfTest', label: '自测说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'package', label: '交付物压缩包', accept: 'file', required: false, min: 0, max: 3, hint: '源码/构建产物 zip' }]
    },
    翻译: {
      fields: [{ key: 'wordCount', label: '字数', type: 'number', required: false, min: 0, unit: '字' }, { key: 'deliverUrl', label: '交付链接', type: 'url', required: false, max: 300 }],
      uploads: [{ key: 'manuscript', label: '成稿文件', accept: 'file', required: true, min: 1, max: 3 }]
    },
    文案: {
      fields: [{ key: 'wordCount', label: '字数', type: 'number', required: false, min: 0, unit: '字' }, { key: 'deliverUrl', label: '交付链接', type: 'url', required: false, max: 300 }],
      uploads: [{ key: 'manuscript', label: '成稿文件', accept: 'file', required: true, min: 1, max: 3 }]
    },
    视频: {
      fields: [{ key: 'videoUrl', label: '成片链接', type: 'url', required: true, max: 300 }, { key: 'note', label: '说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'cover', label: '封面截图', accept: 'image', required: false, min: 0, max: 1 }, { key: 'project', label: '工程文件', accept: 'file', required: false, min: 0, max: 3 }]
    },
    直播电商: {
      fields: [{ key: 'sessionTime', label: '直播场次时间', type: 'datetime', required: true }, { key: 'gmv', label: '场观/成交额说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'screenshot', label: '后台数据截图', accept: 'image', required: true, min: 1, max: 5 }]
    },
    跨境边贸: {
      fields: [{ key: 'note', label: '完成说明', type: 'textarea', required: true, max: 500 }, { key: 'refNo', label: '单据/报关单号', type: 'text', required: false, max: 100 }],
      uploads: [{ key: 'docs', label: '单据/凭证', accept: 'file', required: false, min: 0, max: 5 }]
    },
    文旅: {
      fields: [{ key: 'serviceTime', label: '服务时间', type: 'datetime', required: true }, { key: 'note', label: '服务说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'photos', label: '现场照片', accept: 'image', required: true, min: 1, max: 9 }]
    },
    配送: {
      fields: [{ key: 'count', label: '完成单量', type: 'number', required: true, min: 0, unit: '单' }, { key: 'note', label: '异常说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'sign', label: '签收照片', accept: 'image', required: true, min: 1, max: 9 }]
    },
    物流仓储: {
      fields: [{ key: 'count', label: '完成数量', type: 'number', required: true, min: 0, unit: '件' }, { key: 'note', label: '作业说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'photos', label: '现场照片', accept: 'image', required: false, min: 0, max: 9 }]
    },
    安装: {
      fields: [{ key: 'note', label: '完工说明', type: 'textarea', required: true, max: 500 }, { key: 'acceptor', label: '验收人', type: 'text', required: false, max: 50 }],
      uploads: [{ key: 'done', label: '完工照片', accept: 'image', required: true, min: 1, max: 9 }]
    },
    施工: {
      fields: [{ key: 'note', label: '完工说明', type: 'textarea', required: true, max: 500 }, { key: 'acceptor', label: '验收人', type: 'text', required: false, max: 50 }],
      uploads: [{ key: 'done', label: '完工照片', accept: 'image', required: true, min: 1, max: 9 }, { key: 'hidden', label: '隐蔽工程照片', accept: 'image', required: false, min: 0, max: 9 }]
    },
    制造生产: {
      fields: [{ key: 'count', label: '完成数量', type: 'number', required: true, min: 0, unit: '件' }, { key: 'qc', label: '质检说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'photos', label: '成品照片', accept: 'image', required: true, min: 1, max: 9 }]
    },
    农业: {
      fields: [{ key: 'count', label: '完成数量', type: 'number', required: true, min: 0, unit: '斤' }, { key: 'note', label: '说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'photos', label: '成品照片', accept: 'image', required: true, min: 1, max: 9 }]
    },
    家政服务: {
      fields: [{ key: 'hours', label: '服务时长', type: 'number', required: true, min: 0, unit: '小时' }, { key: 'confirm', label: '客户确认', type: 'select', required: true, options: ['已确认', '未确认'] }],
      uploads: [{ key: 'before', label: '服务前照片', accept: 'image', required: true, min: 1, max: 3 }, { key: 'after', label: '服务后照片', accept: 'image', required: true, min: 1, max: 3 }]
    }
  },
  byTrade: {
    短视频剪辑: {
      fields: [{ key: 'videoUrl', label: '成片链接', type: 'url', required: true, max: 300 }, { key: 'duration', label: '成片时长', type: 'number', required: true, min: 0, unit: '秒' }, { key: 'note', label: '说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'cover', label: '封面截图', accept: 'image', required: false, min: 0, max: 1 }, { key: 'project', label: '工程文件', accept: 'file', required: false, min: 0, max: 3 }]
    },
    同城配送: {
      fields: [{ key: 'receiver', label: '收件人', type: 'text', required: true, max: 50 }, { key: 'arriveTime', label: '送达时间', type: 'datetime', required: true }, { key: 'note', label: '异常说明', type: 'textarea', required: false, max: 500 }],
      uploads: [{ key: 'sign', label: '签收照片', accept: 'image', required: true, min: 1, max: 3 }]
    }
  }
}

const CONFIG_SEEDS = [
  ['platformMarginRate', 0.08, 'tax', '平台毛利率（承揽价与分包价之差比例）'],
  ['laborExpenseRate', 0.2, 'tax', '劳务报酬费用减除比例'],
  ['monthlyDeduction', 5000, 'tax', '每月减除费用（元）'],
  ['vatFreeMonthlySales', 100000, 'tax', '增值税月免征额（元）'],
  ['vatRate', 0.01, 'tax', '超额部分减按征收率'],
  ['outputVatRate', '6%', 'tax', '销项税率（对B端全额开票）'],
  ['concentrationThreshold', 0.8, 'risk', '单零工对单企业月收入集中度预警阈值'],
  ['concentrationMinMonthGross', 20000, 'risk', '集中度预警的月收入下限（元）'],
  ['soletraderGuideMonthGross', 100000, 'risk', '个体户注册引导阈值：月收入（元）'],
  ['forceRegisterRolling12m', 4800000, 'risk', '强制市场主体登记：滚动12个月累计收入（元）'],
  ['payMethods', ['按成果', '按件', '按单'], 'task', '计酬方式白名单（承揽特征条款）'],
  ['categories', ['设计', '技术', '文案', '翻译', '视频', '摄影摄像', '直播电商', '电商运营', '营销推广', '客服', '教育培训', '咨询', '数据标注', '跨境边贸', '文旅', '配送', '物流仓储', '安装', '施工', '制造生产', '农业', '家政服务', '其他'], 'task', '任务类目'],
  ['cities', ['远程', '南宁', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左', '其他'], 'task', '任务地点字典（覆盖广西14个地级市；线上任务为"远程"，线下作业按城市筛选）'],
  // 连续性劳务类目白名单（《个税法实施条例》第六条劳务报酬项目归并，约17类）：
  // 命中该清单且为A线自然人的报酬，按16号公告作为"连续性劳务报酬"分类报送/出具凭证
  ['continuousLaborCategories', ['设计', '装潢', '安装', '制图', '化验测试', '医疗', '法律', '会计', '咨询', '讲学', '新闻广播', '翻译', '审稿', '书画雕刻', '影视录音录像', '演出表演', '广告展览', '技术服务', '介绍经纪代办服务', '技术', '文案', '视频', '直播电商', '跨境边贸', '文旅'], 'tax', '连续性劳务类目白名单（16号公告累计预扣，劳务报酬所得）'],
  ['forbiddenWords', ['打卡', '月薪', '固定工资', '底薪', '考勤', '坐班'], 'risk', '伪劳务违禁词（劳动关系隔离风控）'],
  ['industryBlacklist', ['建筑劳务', '医美', '直播打赏', '贸易走账', '金融放贷'], 'risk', '行业负面清单（高风险）'],
  ['offlineCategories', ['配送', '安装', '施工', '物流仓储', '制造生产', '农业', '家政服务'], 'insurance', '线下作业类目（强制高保额方案）'],
  ['insurancePremiumBase', 3, 'insurance', '基础保费（元/单）'],
  ['insurancePremiumHigh', 12, 'insurance', '高保额保费（元/单）'],
  ['deliverRemindDays', 7, 'task', '交付后未验收提醒天数'],
  ['autoAcceptDays', 14, 'task', '交付后超期自动验收天数（资金保护兜底）'],
  ['amlSingleMax', 50000, 'risk', '反洗钱：单笔大额阈值（元）'],
  ['amlDailyCount', 10, 'risk', '反洗钱：单人单日交易笔数阈值'],
  ['safeMarginRate', 0.02, 'tax', '按单税负测算安全线（净毛利率低于此值预警）'],
  ['callbackSampleRatio', 0.2, 'risk', '业务真实性抽查回访比例'],
  // —— v5 商用化参数 ——
  ['disputeNegotiateHours', 48, 'dispute', '争议协商期时长（小时），到期未和解自动转平台仲裁'],
  ['disputeEvidenceHours', 72, 'dispute', '争议举证期时长（小时）'],
  ['acceptOverdueDays', 7, 'dispute', '交付后企业超期未验收天数（达到后零工可发起争议）'],
  ['ticketUrgentHours', 2, 'ticket', '紧急工单首响 SLA（小时）'],
  ['ticketNormalHours', 24, 'ticket', '普通工单首响 SLA（小时）'],
  ['settlementPaused', 0, 'fund', '全局结算应急开关（1=暂停所有结算，仅限资损应急）'],
  ['withdrawalPaused', 0, 'fund', '全局提现应急开关（1=暂停所有提现出金）'],
  ['withdrawSmsRequired', 0, 'fund', '提现强制短信验证码（生产环境建议开启=1）'],
  ['faceVerifyRequired', 0, 'risk', '实名认证强制人脸核身（生产环境建议开启=1）'],
  ['rechargeOrderExpireMinutes', 120, 'fund', '充值单有效期（分钟）'],
  ['reviewWindowDays', 7, 'review', '结算后互评窗口期（天）'],
  ['creditMinForMultiOrder', 450, 'review', '信用分低于此值限制同时在接任务数为1'],
  ['exportApprovalRows', 50, 'security', '批量导出个人信息需审批的行数阈值'],
  ['adminStepUpRequired', 0, 'security', '运营敏感操作强制2FA（1=未绑定动态码的运营账号禁止执行重置密码/角色/资金等敏感操作，生产建议开启）'],
  ['reviewTags', ['按时交付', '质量过硬', '沟通顺畅', '响应及时', '需求清晰', '验收爽快'], 'review', '互评标签字典'],
  ['skillCatalog', ['UI设计', '平面设计', '前端开发', '后端开发', '中英翻译', '越南语翻译', '文案策划', '短视频剪辑', '配音', '带货主播', '跨境电商运营', '电工', '焊工', '育婴师', '茶艺师', '导游'], 'review', '技能认证目录'],
  // 微信订阅消息模板ID（按事件场景，需在小程序后台「订阅消息」申请后填入；为空则仅站内信+短信，不发订阅消息）
  ['subscribeTmplIds', [], 'notify', '微信订阅消息模板ID白名单（小程序 requestSubscribeMessage 用）'],
  ['deliverySpecs', DELIVERY_SPECS, 'task', '各工种结构化交付物模板（按工种动态渲染交付表单/上传项）']
]
const insertConfig = db.prepare(`INSERT OR IGNORE INTO system_configs (key, value, grp, label) VALUES (?, ?, ?, ?)`)
for (const [key, value, grp, label] of CONFIG_SEEDS) insertConfig.run(key, JSON.stringify(value), grp, label)

// 法律文书与合同模板：正文为单一事实源，集中在 services/legalSeeds.js（首次建库播种；
// 升级线上库用 scripts/publish-legal.mjs）。占位符 {{name}} 在签署时由 renderContract 渲染并存档快照。
const insertLegal = db.prepare(`INSERT OR IGNORE INTO legal_docs (type, title, content) VALUES (?, ?, ?)`)
for (const [type, title, content] of LEGAL_SEEDS) insertLegal.run(type, title, content)

// 消息模板（{{var}} 占位符；sms 通道为"必发短信白名单"场景，控制成本）
const TEMPLATE_SEEDS = [
  ['sms_verify_code', 'sms', '验证码', '【灵工云】您的验证码为 {{code}}，{{minutes}}分钟内有效，请勿泄露。'],
  ['sms_hired', 'sms', '录用通知', '【灵工云】您已被录用承接「{{taskTitle}}」，请登录小程序查看分包工单并按时交付。'],
  ['sms_rejected', 'sms', '交付驳回', '【灵工云】您的任务「{{taskTitle}}」交付被驳回：{{reason}}，请修改后重新提交。'],
  ['sms_settled', 'sms', '结算到账', '【灵工云】「{{taskTitle}}」已验收，分包款 {{amount}} 元已结算至您的平台账户。'],
  ['sms_withdraw_done', 'sms', '提现到账', '【灵工云】您的提现 {{amount}} 元已转入尾号 {{cardTail}} 银行卡。'],
  ['sms_withdraw_failed', 'sms', '提现失败', '【灵工云】您的提现 {{amount}} 元因银行通道异常失败，金额已退回余额。'],
  ['sms_account_locked', 'sms', '账号风控', '【灵工云】您的账号触发平台风控限制，详情请登录小程序查看或联系客服。'],
  ['sms_dispute', 'sms', '争议进展', '【灵工云】您参与的争议 {{disputeNo}} 有新进展：{{stage}}，请登录平台查看。'],
  ['sub_settle', 'subscribe', '结算通知', '任务「{{taskTitle}}」已结算，到账 {{amount}} 元。'],
  ['sub_hired', 'subscribe', '录用通知', '您已被录用承接「{{taskTitle}}」，保险已生效。']
]
const insertTemplate = db.prepare(`INSERT OR IGNORE INTO message_templates (code, channel, title_tpl, body_tpl) VALUES (?, ?, ?, ?)`)
for (const [code, channel, title, body] of TEMPLATE_SEEDS) insertTemplate.run(code, channel, title, body)

// 帮助中心首批文章
const HELP_SEEDS = [
  ['worker', '账户', '实名认证失败怎么办', '常见原因：1）姓名与身份证号不一致；2）身份证号格式错误；3）人脸核身光线不足。请核对信息后重试，连续失败请通过"我的-客服工单"反馈。'],
  ['worker', '税务', '我的个税是怎么计算的', '自然人零工的劳务报酬由平台依法按"累计预扣法"代扣代缴：本月及之前累计收入×(1-20%费用) - 5000元/月×累计月份数，按七级累进税率计算后减去已预扣部分。个体工商户零工平台不代扣，自行申报经营所得。'],
  ['worker', '税务', '年度汇算清缴说明', '每年3-6月可在"个人所得税"APP办理上年度汇算。平台已为您生成《个税扣缴凭证》（我的-收入税务-年度凭证），其中的累计收入与已预扣税额可直接用于申报核对。'],
  ['worker', '资金', '提现多久到账', '提现申请提交后由存管银行 T+1 出金，遇节假日顺延。失败会自动退回余额并短信通知。如超 48 小时未到账请提交客服工单（会自动按紧急处理）。'],
  ['worker', '接单', '什么是个体工商户登记引导', '月收入超过引导阈值时建议登记个体工商户：转入经营所得线后平台不再代扣个税，由您自行申报，整体税负通常更优。滚动12个月累计收入达到强制阈值时，自然人接单权限将被锁定，完成登记即恢复。'],
  ['company', '发票', '发票什么时候开具、如何下载', '任务验收通过后平台自动全额开具6%增值税发票（现代服务），可在"发票管理"页查看下载，作为税前扣除凭证。如需红冲或重开请联系平台运营。'],
  ['company', '资金', '充值如何到账', '请通过"资金管理-充值"获取专属存管账户并转账，银行入金确认后自动入账（通常分钟级）。平台不收取充值手续费，资金由持牌银行存管。'],
  ['company', '合规', '为什么不能发布"打卡/月薪"类任务', '平台采用承揽模式：按成果计酬、不约定固定工时、不进行考勤管理。约定固定月薪或打卡考勤的用工属于劳动关系范畴，不适用灵活用工结算，平台依法予以拦截。'],
  ['all', '争议', '争议处理规则简介', '任一方可对验收、酬劳、失联等发起争议：先进入48小时协商期，未和解转平台仲裁（双方72小时内举证），平台3个工作日内裁决（全额结算/部分结算/不予结算/限期重交付）。对裁决不服可向平台所在地仲裁委或法院提起，平台提供完整证据包。'],
  ['all', '账户', '如何注销账号与删除个人信息', '请通过客服工单提交注销申请，平台将在15个工作日内响应。依据税收征管要求，交易与凭证类数据须保存10年，其余个人信息将依法删除。'],
  ['company', '合规', '如何查看与导出工单证据链', '在"任务管理"打开任意工单详情，底部"证据链"可展开查看：①全流程操作留痕时间轴（派单/抢单/签约/交付/验收每一步的操作人、时间、IP、现场定位）；②合同/业务/资金/票据四流凭证（含合同内容哈希、交付物SHA256、业务交易确认单、发票号）；③四流完整性与防篡改校验结论。点"打印/导出"可一键生成完整证据链报告，用于争议举证与税务核查。'],
  ['worker', '接单', '报名/交付时为什么要授权定位', '接单与交付时，平台会在征得你授权后记录一次现场定位，作为"本人在现场完成"的证据链佐证，发生争议时更好地保护你的权益。拒绝授权不影响正常接单，仅相应留痕会缺少现场位置信息。']
]
// 按标题幂等播种：兼容已有库（运营可能已手工新增文章占用了自增 id），新文章按标题判重补齐，避免固定 id 冲突致漏插。
const insertHelp = db.prepare(`INSERT INTO help_articles (audience, category, title, content) VALUES (?, ?, ?, ?)`)
const helpTitleExists = db.prepare(`SELECT 1 FROM help_articles WHERE title = ?`)
HELP_SEEDS.forEach(([audience, category, title, content]) => {
  if (!helpTitleExists.get(title)) insertHelp.run(audience, category, title, content)
})

export default db
