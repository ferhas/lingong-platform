import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/Login.vue'),
    meta: { title: '登录' }
  },
  {
    path: '/',
    component: () => import('../layout/Layout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/Dashboard.vue'), meta: { title: '工作台' } },
      { path: 'tasks', name: 'tasks', component: () => import('../views/Tasks.vue'), meta: { title: '任务管理' } },
      { path: 'publish', name: 'publish', component: () => import('../views/Publish.vue'), meta: { title: '发布任务' } },
      { path: 'batch-publish', name: 'batchPublish', component: () => import('../views/BatchPublish.vue'), meta: { title: '批量发单' } },
      { path: 'funds', name: 'funds', component: () => import('../views/Funds.vue'), meta: { title: '资金账户' } },
      { path: 'statement', name: 'statement', component: () => import('../views/Statement.vue'), meta: { title: '月结单' } },
      { path: 'invoices', name: 'invoices', component: () => import('../views/Invoices.vue'), meta: { title: '发票中心' } },
      { path: 'disputes', name: 'disputes', component: () => import('../views/Disputes.vue'), meta: { title: '争议中心' } },
      { path: 'tickets', name: 'tickets', component: () => import('../views/Tickets.vue'), meta: { title: '客服工单' } },
      { path: 'contracts', name: 'contracts', component: () => import('../views/Contracts.vue'), meta: { title: '合同档案' } },
      { path: 'members', name: 'members', component: () => import('../views/Members.vue'), meta: { title: '成员管理' } },
      { path: 'profile', name: 'profile', component: () => import('../views/Profile.vue'), meta: { title: '企业资料' } },
      { path: 'password', name: 'password', component: () => import('../views/ChangePassword.vue'), meta: { title: '修改密码' } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(to => {
  const token = localStorage.getItem('token')
  if (to.path !== '/login' && !token) {
    return { path: '/login' }
  }
  if (to.path === '/login' && token) {
    return { path: '/dashboard' }
  }
  document.title = to.meta?.title ? `${to.meta.title}｜灵工云·企业端` : '灵工云·企业端'
  return true
})

export default router
