import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { title: '登录' }
    },
    {
      path: '/',
      component: () => import('../layout/AdminLayout.vue'),
      redirect: '/dashboard',
      children: [
        { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '运营总览', perm: 'dashboard:read' } },
        { path: 'companies', name: 'companies', component: () => import('../views/CompaniesView.vue'), meta: { title: '企业入驻审核', perm: 'company:read' } },
        { path: 'workers', name: 'workers', component: () => import('../views/WorkersView.vue'), meta: { title: '零工管理', perm: 'worker:read' } },
        { path: 'risk', name: 'risk', component: () => import('../views/RiskView.vue'), meta: { title: '风控预警', perm: 'risk:read' } },
        { path: 'quality', name: 'quality', component: () => import('../views/QualityView.vue'), meta: { title: '回访与理赔', perm: 'risk:read' } },
        { path: 'tax', name: 'tax', component: () => import('../views/TaxView.vue'), meta: { title: '税务工作台', perm: 'tax:read' } },
        { path: 'invoices', name: 'invoices', component: () => import('../views/InvoicesView.vue'), meta: { title: '发票管理', perm: 'tax:read' } },
        { path: 'archives', name: 'archives', component: () => import('../views/ArchivesView.vue'), meta: { title: '凭证归档', perm: 'archive:read' } },
        { path: 'integrations', name: 'integrations', component: () => import('../views/IntegrationsView.vue'), meta: { title: '外部服务状态', perm: 'integration:read' } },
        { path: 'flows', name: 'flows', component: () => import('../views/FlowsView.vue'), meta: { title: '资金流水', perm: 'flow:read' } },
        { path: 'funds-orders', name: 'fundsOrders', component: () => import('../views/FundsOrdersView.vue'), meta: { title: '结算/提现单据', perm: 'flow:read' } },
        { path: 'configs', name: 'configs', component: () => import('../views/ConfigsView.vue'), meta: { title: '业务参数配置', perm: 'config:read' } },
        { path: 'legal', name: 'legal', component: () => import('../views/LegalView.vue'), meta: { title: '协议/合同模板', perm: 'config:read' } },
        { path: 'users', name: 'users', component: () => import('../views/UsersView.vue'), meta: { title: '用户管理', perm: 'user:read' } },
        { path: 'audit', name: 'audit', component: () => import('../views/AuditLogsView.vue'), meta: { title: '审计日志', perm: 'audit:read' } },
        { path: 'disputes', name: 'disputes', component: () => import('../views/DisputesView.vue'), meta: { title: '争议仲裁', perm: 'dispute:read' } },
        { path: 'tickets', name: 'tickets', component: () => import('../views/TicketsView.vue'), meta: { title: '客服工单', perm: 'ticket:read' } },
        { path: 'skills', name: 'skills', component: () => import('../views/SkillsView.vue'), meta: { title: '技能认证审核', perm: 'skill:review' } },
        { path: 'input-invoices', name: 'inputInvoices', component: () => import('../views/InputInvoicesView.vue'), meta: { title: '进项发票台账', perm: 'tax:read' } },
        { path: 'finance', name: 'finance', component: () => import('../views/FinanceView.vue'), meta: { title: '财务报表中心', perm: 'finance:read' } },
        { path: 'exports', name: 'exports', component: () => import('../views/ExportsView.vue'), meta: { title: '导出审批', perm: 'export:approve' } },
        { path: 'events', name: 'events', component: () => import('../views/EventsView.vue'), meta: { title: '集成事件监控', perm: 'integration:read' } },
        { path: 'system-health', name: 'systemHealth', component: () => import('../views/SystemHealthView.vue'), meta: { title: '系统健康', perm: 'integration:read' } },
        { path: 'templates', name: 'templates', component: () => import('../views/TemplatesView.vue'), meta: { title: '消息中心', perm: 'message:manage' } },
        { path: 'help-admin', name: 'helpAdmin', component: () => import('../views/HelpAdminView.vue'), meta: { title: '帮助中心管理', perm: 'help:manage' } },
        { path: 'credentials', name: 'credentials', component: () => import('../views/CredentialsView.vue'), meta: { title: '开放API凭据', perm: 'config:read' } },
        { path: 'security', name: 'security', component: () => import('../views/SecurityView.vue'), meta: { title: '账号安全' } },
        { path: 'password', name: 'password', component: () => import('../views/ChangePasswordView.vue'), meta: { title: '修改密码' } }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
})

router.beforeEach(async to => {
  const auth = useAuthStore()
  if (to.path === '/login') {
    if (auth.token && auth.user?.role === 'admin') return auth.firstAllowedPath || '/dashboard'
    return true
  }
  if (!auth.token) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (auth.user?.role !== 'admin') {
    ElMessage.error('请使用运营管理员账号登录')
    await auth.logout()
    return '/login'
  }
  // 每个会话至少刷新一次权限(401 由拦截器统一处理)
  if (!auth.profileLoaded) {
    try {
      await auth.fetchProfile()
    } catch {
      return false
    }
  }
  // RBAC:无权访问时跳转到第一个有权限的菜单
  if (to.meta.perm && !auth.can(to.meta.perm)) {
    const fallback = auth.firstAllowedPath
    if (!fallback) {
      ElMessage.error('当前账号未配置任何后台权限,请联系超级管理员')
      await auth.logout()
      return '/login'
    }
    if (fallback !== to.path) {
      ElMessage.warning('暂无该页面的访问权限')
      return fallback
    }
    return false
  }
  return true
})

router.afterEach(to => {
  document.title = to.meta.title
    ? `${to.meta.title}·灵活用工平台运营端`
    : '灵活用工平台·运营管理端'
})

export default router
