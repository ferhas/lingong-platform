export function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '0.00'
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtDateTime(s) {
  if (!s) return '—'
  return String(s).replace('T', ' ').slice(0, 19)
}

// 状态色语义：红色仅留给错误/危险；进行中=品牌色(活跃)、待验收=琥珀(需企业处理)、已结算=绿、报名中/已取消=中性灰
export const TASK_STATUS = {
  recruiting: { label: '报名中', tag: 'info' },
  working: { label: '进行中', tag: 'primary' },
  delivered: { label: '待验收', tag: 'warning' },
  settled: { label: '已结算', tag: 'success' },
  cancelled: { label: '已取消', tag: 'info' }
}

// 覆盖 fund_flows.type 全部 8 个枚举（与后端 db.js CHECK 一致），避免出现原始码
export const FLOW_TYPE = {
  recharge: { label: '充值', tag: 'success' },
  freeze: { label: '冻结', tag: 'warning' },
  unfreeze: { label: '解冻', tag: 'info' },
  settle_out: { label: '结算划扣', tag: 'danger' },
  settle_in: { label: '结算入账', tag: 'success' },
  withdraw: { label: '提现', tag: 'danger' },
  tax_in: { label: '税款入账', tag: 'info' },
  revenue_in: { label: '平台收益', tag: 'success' }
}

export const CONTRACT_TYPE = {
  master: '总承揽框架合同',
  frame_sub: '分包框架协议',
  work_order: '任务工单',
  sub_order: '分包工单'
}

export const COMPANY_STATUS = {
  pending: { label: '审核中', tag: 'warning' },
  approved: { label: '已准入', tag: 'success' },
  rejected: { label: '已拒绝', tag: 'danger' }
}

export const SUBJECT_TYPE = {
  person: '自然人',
  soletrader: '个体工商户'
}

export const MEMBER_ROLE = {
  owner: { label: '企业主', tag: 'primary' },
  operator: { label: '运营', tag: 'info' },
  finance: { label: '财务', tag: 'success' }
}

export const INVOICE_STATUS = {
  issuing: { label: '开具中', tag: 'warning' },
  issued: { label: '已开具', tag: 'success' },
  voided: { label: '已红冲', tag: 'danger' }
}

export const RECHARGE_ORDER_STATUS = {
  created: { label: '待入金', tag: 'warning' },
  paid: { label: '已到账', tag: 'success' },
  expired: { label: '已过期', tag: 'info' }
}

export const DISPUTE_STATUS = {
  negotiating: { label: '协商期', tag: 'warning' },
  arbitrating: { label: '仲裁举证', tag: 'danger' },
  ruled: { label: '已裁决', tag: 'primary' },
  executed: { label: '已执行', tag: 'success' },
  closed: { label: '已关闭', tag: 'info' },
  withdrawn: { label: '已撤回', tag: 'info' },
  escalated: { label: '线下升级', tag: 'danger' }
}

export const DISPUTE_TYPE = {
  worker_missing: '零工失联',
  quality_after: '结算后质量争议',
  acceptance: '验收争议',
  payment_overdue: '超期未验收',
  other: '其他'
}

export const RULING_TYPE = {
  full_pay: '全额支付',
  partial_pay: '部分支付',
  no_pay: '不予支付',
  redeliver: '重新交付'
}

export const TICKET_STATUS = {
  open: { label: '待受理', tag: 'warning' },
  pending_agent: { label: '处理中', tag: 'primary' },
  pending_user: { label: '待我回复', tag: 'danger' },
  resolved: { label: '已解决', tag: 'success' },
  closed: { label: '已关闭', tag: 'info' }
}

export const TICKET_PRIORITY = {
  urgent: { label: '紧急', tag: 'danger' },
  high: { label: '高', tag: 'warning' },
  normal: { label: '普通', tag: 'info' }
}

// 全量分类字典：用于展示既有工单（任何分类都要有中文标签）
export const TICKET_CATEGORY = {
  account: '账号问题',
  realname: '实名认证',
  settlement: '结算问题',
  withdraw: '提现问题',
  invoice: '发票问题',
  tax: '税务咨询',
  insurance: '保险理赔',
  complaint: '投诉举报',
  other: '其他'
}

// 企业端可发起的工单分类（剔除零工专属的实名/提现/保险理赔，避免误选与错误 SLA 路由）
export const COMPANY_TICKET_CATEGORIES = ['account', 'settlement', 'invoice', 'tax', 'complaint', 'other']

// 评价可选标签（企业评零工）
export const REVIEW_TAGS = ['按时交付', '质量过硬', '沟通顺畅', '响应及时', '需求清晰', '验收爽快']

// 专业术语白话解释（配合 TermTip 组件使用）
export const TERM_TIPS = {
  承揽价: '承揽价 = 企业支付的任务总价。平台以该价格整体承揽任务，其中包含零工报酬、平台服务费与税费',
  分包价: '分包价 = 零工实际获得的税前报酬，即平台承揽任务后再分包给零工的价格',
  四流: '四流 = 合同流、资金流、发票流、业务流。四类凭证一一对应、相互印证，用于证明业务真实发生',
  数电票: '数电票 = 全面数字化的电子发票，由税务平台统一赋码开具，与纸质发票具有同等法律效力，可直接用于入账抵扣',
  存管户: '存管户 = 开立在合作银行的专用监管账户。企业资金由银行托管、专款专用，平台无法挪用'
}

// 通知类型字典：覆盖后端 notify()/notifyWithSms() 发出的全部 16 种类型
// （见 server/src/services/notify.js 各调用方），避免新增类型时出现未映射通知
export const NOTIFY_TYPE = {
  review: '准入审核',
  hired: '录用',
  deliver: '交付',
  rejected: '驳回',
  settle: '结算',
  risk: '风控',
  guide: '指引',
  cancelled: '取消',
  member: '成员',
  dispatch: '派单',
  dispute: '争议',
  recharge: '充值',
  invoice: '发票',
  skill: '技能',
  ticket: '工单',
  export: '导出'
}
