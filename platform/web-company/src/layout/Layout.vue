<template>
  <el-container class="layout">
    <!-- 侧边栏 -->
    <el-aside width="220px" class="sidebar">
      <div class="sidebar-logo">
        <el-icon :size="22"><Platform /></el-icon>
        <span>灵工云·企业端</span>
      </div>
      <el-menu :default-active="$route.path" router class="sidebar-menu" background-color="transparent">
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <span>工作台</span>
        </el-menu-item>
        <el-menu-item index="/tasks">
          <el-icon><List /></el-icon>
          <span>任务管理</span>
        </el-menu-item>
        <el-menu-item index="/publish">
          <el-icon><CirclePlus /></el-icon>
          <span>发布任务</span>
        </el-menu-item>
        <el-menu-item index="/batch-publish">
          <el-icon><Files /></el-icon>
          <span>批量发单</span>
        </el-menu-item>
        <el-menu-item index="/funds">
          <el-icon><Wallet /></el-icon>
          <span>资金账户</span>
        </el-menu-item>
        <el-menu-item index="/statement">
          <el-icon><DataAnalysis /></el-icon>
          <span>月结单</span>
        </el-menu-item>
        <el-menu-item index="/invoices">
          <el-icon><Tickets /></el-icon>
          <span>发票中心</span>
        </el-menu-item>
        <el-menu-item index="/contracts">
          <el-icon><Document /></el-icon>
          <span>合同档案</span>
        </el-menu-item>
        <el-menu-item index="/disputes">
          <el-icon><Opportunity /></el-icon>
          <span>争议中心</span>
        </el-menu-item>
        <el-menu-item index="/tickets">
          <el-icon><Service /></el-icon>
          <span>客服工单</span>
        </el-menu-item>
        <el-menu-item v-if="auth.isOwner" index="/members">
          <el-icon><UserFilled /></el-icon>
          <span>成员管理</span>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footer">承揽后分包 · 合规用工</div>
    </el-aside>

    <el-container>
      <!-- 顶部栏 -->
      <el-header class="topbar" height="60px">
        <div class="topbar-title">{{ $route.meta?.title || '' }}</div>
        <div class="topbar-right">
          <template v-if="profile">
            <span class="company-name">{{ profile.companyName }}</span>
            <el-tag :type="statusMeta.tag" size="small" effect="light">{{ statusMeta.label }}</el-tag>
          </template>

          <!-- 帮助中心 -->
          <el-tooltip content="帮助中心" placement="bottom">
            <button class="icon-btn" @click="openHelp">
              <el-icon :size="18"><QuestionFilled /></el-icon>
            </button>
          </el-tooltip>

          <!-- 主题切换 -->
          <el-tooltip :content="theme.isDark ? '切换到浅色模式' : '切换到深色模式'" placement="bottom">
            <button class="icon-btn" @click="theme.toggle()">
              <el-icon :size="18"><Moon v-if="!theme.isDark" /><Sunny v-else /></el-icon>
            </button>
          </el-tooltip>

          <!-- 通知铃铛 -->
          <el-popover placement="bottom-end" :width="380" trigger="click" @show="fetchNotifications">
            <template #reference>
              <button class="icon-btn">
                <el-badge :value="unread" :hidden="!unread" :max="99">
                  <el-icon :size="18"><Bell /></el-icon>
                </el-badge>
              </button>
            </template>
            <div class="notify-panel">
              <div class="notify-head">
                <span class="notify-title">通知（未读 {{ unread }}）</span>
                <el-button v-if="unread" type="primary" link size="small" @click="markAllRead">全部已读</el-button>
              </div>
              <el-scrollbar max-height="360px">
                <div v-if="notifications.length" class="notify-list">
                  <div
                    v-for="n in notifications"
                    :key="n.id"
                    class="notify-item"
                    :class="{ unread: !n.read }"
                    @click="readOne(n)"
                  >
                    <div class="notify-item-title">
                      <span class="notify-dot" v-if="!n.read"></span>{{ n.title }}
                    </div>
                    <div class="notify-item-body">{{ n.body }}</div>
                    <div class="notify-item-time">{{ fmtDateTime(n.created_at) }}</div>
                  </div>
                </div>
                <el-empty v-else description="暂无通知" :image-size="64" />
              </el-scrollbar>
            </div>
          </el-popover>

          <!-- 用户下拉 -->
          <el-dropdown @command="onCommand">
            <span class="user-chip">
              <el-avatar :size="28" class="user-avatar">{{ avatarText }}</el-avatar>
              <span class="user-name">{{ auth.user?.name || '企业用户' }}</span>
              <el-tag v-if="roleMeta" size="small" :type="roleMeta.tag" effect="plain">{{ roleMeta.label }}</el-tag>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">
                  <el-icon><OfficeBuilding /></el-icon>企业资料
                </el-dropdown-item>
                <el-dropdown-item command="password">
                  <el-icon><Key /></el-icon>修改密码
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 内容区 -->
      <el-main class="content">
        <router-view />
      </el-main>
    </el-container>

    <!-- 帮助中心抽屉 -->
    <el-drawer v-model="helpVisible" title="帮助中心" size="420px">
      <el-input
        v-model="helpKeyword"
        placeholder="搜索帮助文章"
        clearable
        :prefix-icon="Search"
        @keyup.enter="fetchHelp"
        @clear="fetchHelp"
      />
      <div class="help-list" v-loading="helpLoading">
        <template v-if="helpList.length">
          <div v-for="a in helpList" :key="a.id" class="help-item" @click="openArticle(a)">
            <el-tag size="small" effect="plain" class="help-cate">{{ a.category }}</el-tag>
            <span class="help-title">{{ a.title }}</span>
            <el-icon class="help-arrow"><ArrowRight /></el-icon>
          </div>
        </template>
        <el-empty v-else-if="!helpLoading" description="没有找到相关文章，可提交客服工单咨询" :image-size="72">
          <el-button type="primary" size="small" @click="goTickets">提交工单</el-button>
        </el-empty>
      </div>
    </el-drawer>

    <!-- 帮助文章详情 -->
    <el-dialog v-model="articleVisible" :title="article?.title || '帮助文章'" width="620px">
      <div v-loading="articleLoading" class="article-body pre-wrap">{{ article?.content }}</div>
      <template #footer>
        <el-button type="primary" @click="articleVisible = false">我知道了</el-button>
      </template>
    </el-dialog>

    <!-- 协议更新强制重新同意（不可关闭） -->
    <el-dialog
      v-model="reAgreeVisible"
      title="服务协议已更新"
      width="480px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
    >
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="平台协议已更新，请阅读并同意最新版本后继续使用"
        class="reagree-alert"
      />
      <div class="reagree-list">
        <div v-for="d in reAgreeDocs" :key="d.type" class="reagree-item">
          <el-icon class="reagree-icon"><Document /></el-icon>
          <span>{{ d.title || (d.type === 'tos' ? '用户服务协议' : '隐私政策') }}</span>
          <el-tag size="small" effect="plain">v{{ d.currentVersion }}</el-tag>
          <el-button type="primary" link size="small" @click="viewLegal(d.type)">查看全文</el-button>
        </div>
      </div>
      <template #footer>
        <el-button type="primary" size="large" :loading="reAgreeing" @click="onReAgree">
          我已阅读并同意最新协议
        </el-button>
      </template>
    </el-dialog>

    <!-- 协议全文 -->
    <el-dialog v-model="legalVisible" :title="legalDoc?.title || '协议全文'" width="640px" append-to-body>
      <div class="article-body pre-wrap" v-loading="legalLoading">{{ legalDoc?.content }}</div>
      <template #footer>
        <el-button type="primary" @click="legalVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'
import { useProfileStore } from '../stores/profile'
import { useThemeStore } from '../stores/theme'
import {
  getNotifications,
  markNotificationsRead,
  getHelpList,
  getHelpDetail,
  getAgreementsStatus,
  reAgreeAgreements,
  getLegalDoc
} from '../api/me'
import { COMPANY_STATUS, MEMBER_ROLE, fmtDateTime } from '../utils/format'

const router = useRouter()
const auth = useAuthStore()
const profileStore = useProfileStore()
const theme = useThemeStore()

const profile = computed(() => profileStore.profile)
const statusMeta = computed(
  () => COMPANY_STATUS[profile.value?.status] || { label: '未知', tag: 'info' }
)
const roleMeta = computed(() => MEMBER_ROLE[auth.memberRole] || null)
const avatarText = computed(() => (auth.user?.name || '企').slice(0, 1))

// —— 通知 ——
const notifications = ref([])
const unread = ref(0)
let pollTimer = null

async function fetchNotifications(silent = true) {
  try {
    const data = await getNotifications(1, 20, silent)
    notifications.value = data.list || []
    unread.value = data.unread || 0
  } catch {
    // 轮询静默失败
  }
}

async function markAllRead() {
  try {
    await markNotificationsRead('all')
    notifications.value = notifications.value.map(n => ({ ...n, read: 1 }))
    unread.value = 0
  } catch {
    // 错误已由拦截器提示
  }
}

// 通知类型 → 跳转路由（其余类型不跳转）
const NOTIFY_ROUTE = {
  hired: '/tasks',
  deliver: '/tasks',
  settle: '/tasks',
  cancelled: '/tasks',
  review: '/dashboard',
  member: '/members'
}

async function readOne(n) {
  if (!n.read) {
    try {
      await markNotificationsRead([n.id])
      n.read = 1
      unread.value = Math.max(0, unread.value - 1)
    } catch {
      // 错误已由拦截器提示
    }
  }
  const to = NOTIFY_ROUTE[n.type]
  if (to && router.currentRoute.value.path !== to) {
    router.push(to)
  }
}

// —— 帮助中心 ——
const helpVisible = ref(false)
const helpKeyword = ref('')
const helpList = ref([])
const helpLoading = ref(false)
const articleVisible = ref(false)
const articleLoading = ref(false)
const article = ref(null)

function openHelp() {
  helpVisible.value = true
  if (!helpList.value.length) fetchHelp()
}

async function fetchHelp() {
  helpLoading.value = true
  try {
    const data = await getHelpList(helpKeyword.value.trim())
    helpList.value = data.list || []
  } catch {
    // 错误已由拦截器提示
  } finally {
    helpLoading.value = false
  }
}

async function openArticle(a) {
  articleVisible.value = true
  articleLoading.value = true
  article.value = { title: a.title, content: '' }
  try {
    article.value = await getHelpDetail(a.id)
  } finally {
    articleLoading.value = false
  }
}

function goTickets() {
  helpVisible.value = false
  router.push('/tickets')
}

// —— 协议更新强制重新同意 ——
const reAgreeVisible = ref(false)
const reAgreeDocs = ref([])
const reAgreeing = ref(false)
const legalVisible = ref(false)
const legalLoading = ref(false)
const legalDoc = ref(null)

async function checkAgreements() {
  try {
    const data = await getAgreementsStatus()
    if (data?.needReAgree) {
      reAgreeDocs.value = (data.docs || []).filter(d => d.needReAgree)
      reAgreeVisible.value = true
    }
  } catch {
    // 静默失败，不阻断使用
  }
}

async function viewLegal(type) {
  legalVisible.value = true
  legalLoading.value = true
  legalDoc.value = null
  try {
    legalDoc.value = await getLegalDoc(type)
  } finally {
    legalLoading.value = false
  }
}

async function onReAgree() {
  reAgreeing.value = true
  try {
    await reAgreeAgreements()
    reAgreeVisible.value = false
    ElMessage.success('已确认同意最新协议，感谢您的配合')
  } catch {
    // 错误已由拦截器提示
  } finally {
    reAgreeing.value = false
  }
}

onMounted(() => {
  profileStore.fetch().catch(() => {})
  auth.fetchMe().catch(() => {})
  theme.syncFromServer()
  fetchNotifications()
  checkAgreements()
  pollTimer = setInterval(fetchNotifications, 60000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function onCommand(command) {
  if (command === 'profile') {
    router.push('/profile')
  } else if (command === 'password') {
    router.push('/password')
  } else if (command === 'logout') {
    ElMessageBox.confirm('退出后本机登录状态将被清除，再次使用需重新登录。是否继续？', '退出登录', {
      confirmButtonText: '继续退出',
      cancelButtonText: '再想想',
      type: 'warning'
    })
      .then(async () => {
        // 先调后端吊销 refreshToken（静默），再清本地会话
        await auth.logout()
        ElMessage.success('已退出登录')
        router.push('/login')
      })
      .catch(() => {})
  }
}
</script>

<style scoped>
.layout {
  height: 100vh;
}

/* —— 侧边栏：两种主题下均保持深底，文字/高亮/边框用变量 —— */
.sidebar {
  background: linear-gradient(180deg, var(--sidebar-bg-from) 0%, var(--sidebar-bg-to) 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--sidebar-text-active);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 1px;
  border-bottom: 1px solid var(--sidebar-border);
  flex-shrink: 0;
}

.sidebar-menu {
  border-right: none;
  flex: 1;
  padding-top: 8px;
}

.sidebar-menu :deep(.el-menu-item) {
  height: 48px;
  margin: 4px 12px;
  border-radius: 8px;
  color: var(--sidebar-text);
}

.sidebar-menu :deep(.el-menu-item:hover) {
  background: var(--sidebar-hover);
  color: var(--sidebar-text-active);
}

.sidebar-menu :deep(.el-menu-item.is-active) {
  background: var(--brand);
  color: var(--sidebar-text-active);
}

.sidebar-footer {
  padding: 16px;
  text-align: center;
  color: var(--sidebar-text);
  opacity: 0.5;
  font-size: 12px;
  flex-shrink: 0;
}

/* —— 顶栏 —— */
.topbar {
  background: var(--bg-card);
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: var(--shadow-card);
  z-index: 10;
  transition: background-color 0.25s;
}

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.company-name {
  font-size: 14px;
  color: var(--text-2);
  font-weight: 500;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: background-color 0.2s;
}

.icon-btn:hover {
  background: var(--bg-hover);
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
  outline: none;
}

.user-avatar {
  background: var(--brand);
  font-size: 13px;
}

.content {
  background: var(--bg-page);
  padding: 20px 24px;
  overflow-y: auto;
  transition: background-color 0.25s;
}

/* —— 通知面板 —— */
.notify-panel {
  margin: -4px 0;
}

.notify-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}

.notify-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.notify-item {
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.notify-item:hover {
  background: var(--bg-hover);
}

.notify-item-title {
  font-size: 13px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 6px;
}

.notify-item.unread .notify-item-title {
  font-weight: 700;
  color: var(--text-1);
}

.notify-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
  flex-shrink: 0;
}

.notify-item-body {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notify-item-time {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}

/* —— 帮助中心 —— */
.help-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 120px;
}

.help-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.help-item:hover {
  background: var(--bg-hover);
}

.help-cate {
  flex-shrink: 0;
}

.help-title {
  flex: 1;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.help-arrow {
  color: var(--text-3);
  flex-shrink: 0;
}

.article-body {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.9;
  min-height: 80px;
  max-height: 60vh;
  overflow-y: auto;
}

.pre-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}

/* —— 协议重新同意 —— */
.reagree-alert {
  margin-bottom: 14px;
  border-radius: 8px;
}

.reagree-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reagree-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-1);
}

.reagree-icon {
  color: var(--brand);
}
</style>
