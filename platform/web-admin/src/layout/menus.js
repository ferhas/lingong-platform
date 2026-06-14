// 侧边栏菜单单一事实源:布局渲染、路由守卫兜底跳转共用
// 结构:顶层为「分组」(带 children) 或「独立菜单项」(带 path);分组内的 children 均为叶子菜单项。
import {
  DataLine,
  OfficeBuilding,
  User,
  Warning,
  PhoneFilled,
  Coin,
  Postcard,
  FolderChecked,
  Connection,
  Tickets,
  Wallet,
  Setting,
  Reading,
  UserFilled,
  Document,
  Stamp,
  Service,
  Medal,
  Notebook,
  TrendCharts,
  Download,
  Link,
  Monitor,
  Message,
  QuestionFilled,
  Key,
  Files
} from '@element-plus/icons-vue'

export const menus = [
  { path: '/dashboard', label: '运营总览', icon: DataLine, perm: 'dashboard:read' },
  {
    key: 'subjects',
    label: '用工管理',
    icon: UserFilled,
    children: [
      { path: '/companies', label: '企业入驻审核', icon: OfficeBuilding, perm: 'company:read' },
      { path: '/workers', label: '零工管理', icon: User, perm: 'worker:read' },
      { path: '/skills', label: '技能认证审核', icon: Medal, perm: 'skill:review' }
    ]
  },
  {
    key: 'risk',
    label: '风控合规',
    icon: Warning,
    children: [
      { path: '/risk', label: '风控预警', icon: Warning, perm: 'risk:read' },
      { path: '/disputes', label: '争议仲裁', icon: Stamp, perm: 'dispute:read' }
    ]
  },
  {
    key: 'service',
    label: '客户服务',
    icon: Service,
    children: [
      { path: '/tickets', label: '客服工单', icon: Tickets, perm: 'ticket:read' },
      { path: '/quality', label: '回访与理赔', icon: PhoneFilled, perm: 'risk:read' }
    ]
  },
  {
    key: 'tax',
    label: '财税管理',
    icon: Coin,
    children: [
      { path: '/tax', label: '税务工作台', icon: Coin, perm: 'tax:read' },
      { path: '/invoices', label: '发票管理', icon: Postcard, perm: 'tax:read' },
      { path: '/input-invoices', label: '进项发票台账', icon: Notebook, perm: 'tax:read' },
      { path: '/archives', label: '凭证归档', icon: FolderChecked, perm: 'archive:read' }
    ]
  },
  {
    key: 'funds',
    label: '资金财务',
    icon: Wallet,
    children: [
      { path: '/flows', label: '资金流水', icon: Tickets, perm: 'flow:read' },
      { path: '/funds-orders', label: '结算/提现单据', icon: Wallet, perm: 'flow:read' },
      { path: '/finance', label: '财务报表中心', icon: TrendCharts, perm: 'finance:read' },
      { path: '/exports', label: '个人信息导出', icon: Download, perm: 'worker:read' }
    ]
  },
  {
    key: 'integration',
    label: '运维监控',
    icon: Monitor,
    children: [
      { path: '/integrations', label: '外部服务状态', icon: Connection, perm: 'integration:read' },
      { path: '/events', label: '集成事件监控', icon: Link, perm: 'integration:read' },
      { path: '/system-health', label: '系统健康', icon: Monitor, perm: 'integration:read' }
    ]
  },
  {
    key: 'system',
    label: '系统设置',
    icon: Setting,
    children: [
      { path: '/configs', label: '业务参数配置', icon: Setting, perm: 'config:read' },
      { path: '/delivery-specs', label: '交付物模板', icon: Files, perm: 'config:read' },
      { path: '/legal', label: '协议/合同模板', icon: Reading, perm: 'config:read' },
      { path: '/credentials', label: '开放API凭据', icon: Key, perm: 'config:read' },
      { path: '/templates', label: '消息中心', icon: Message, perm: 'message:manage' },
      { path: '/help-admin', label: '帮助中心管理', icon: QuestionFilled, perm: 'help:manage' },
      { path: '/users', label: '用户管理', icon: UserFilled, perm: 'user:read' },
      { path: '/audit', label: '审计日志', icon: Document, perm: 'audit:read' }
    ]
  }
]

// 拍平为叶子菜单项(保持原顺序),供权限兜底跳转 firstAllowedPath 使用
export const flatMenus = menus.flatMap(m => (m.children ? m.children : [m]))
