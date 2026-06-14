<template>
  <el-container class="admin-layout">
    <el-aside width="232px" class="sidebar">
      <div class="brand">
        <div class="brand-logo">灵</div>
        <div class="brand-text">
          <div class="brand-name">灵活用工平台</div>
          <div class="brand-role">平台运营端</div>
        </div>
      </div>
      <el-menu
        class="side-menu"
        :default-active="route.path"
        background-color="transparent"
        text-color="#9ca3af"
        active-text-color="#ffffff"
        unique-opened
        router
      >
        <template v-for="item in visibleMenus" :key="item.key || item.path">
          <!-- 一级分组:展开二级菜单 -->
          <el-sub-menu v-if="item.children" :index="item.key">
            <template #title>
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
            </template>
            <el-menu-item
              v-for="child in item.children"
              :key="child.path"
              :index="child.path"
            >
              <el-icon><component :is="child.icon" /></el-icon>
              <span>{{ child.label }}</span>
            </el-menu-item>
          </el-sub-menu>
          <!-- 独立一级菜单项 -->
          <el-menu-item v-else :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </el-menu-item>
        </template>
      </el-menu>
      <div class="side-footer">合规用工·四流合一</div>
    </el-aside>

    <el-container class="main-area">
      <el-header height="56px" class="topbar">
        <div class="topbar-title">{{ route.meta.title || '运营控制台' }}</div>
        <div class="topbar-right">
          <el-tag size="small" effect="dark" color="#6366f1" style="border: none">
            {{ auth.roleName || '运营人员' }}
          </el-tag>

          <!-- 日/夜主题切换 -->
          <el-tooltip :content="theme.isDark ? '切换到浅色模式' : '切换到深色模式'" placement="bottom">
            <el-button circle text class="topbar-icon-btn" :aria-label="theme.isDark ? '切换到浅色模式' : '切换到深色模式'" @click="theme.toggle()">
              <el-icon :size="18"><Moon v-if="!theme.isDark" /><Sunny v-else /></el-icon>
            </el-button>
          </el-tooltip>

          <!-- 通知铃铛 -->
          <el-popover
            placement="bottom-end"
            :width="380"
            trigger="click"
            @show="loadNotifications"
          >
            <template #reference>
              <span class="bell-wrap">
                <el-badge :value="unread" :hidden="unread === 0" :max="99">
                  <el-button circle text class="topbar-icon-btn" aria-label="通知">
                    <el-icon :size="18"><Bell /></el-icon>
                  </el-button>
                </el-badge>
              </span>
            </template>
            <div class="notify-head">
              <span class="notify-title">站内通知</span>
              <el-button
                size="small"
                text
                type="primary"
                :disabled="unread === 0"
                @click="markAllRead"
              >
                全部已读
              </el-button>
            </div>
            <div v-loading="notifyLoading" class="notify-list">
              <el-empty
                v-if="!notifyLoading && notifications.length === 0"
                description="暂无通知"
                :image-size="60"
              />
              <div
                v-for="n in notifications"
                :key="n.id"
                class="notify-item"
                :class="{ unread: !n.read, clickable: !!notifyTarget(n) }"
                @click="onNotifyClick(n)"
              >
                <div class="notify-item-title">
                  <span v-if="!n.read" class="notify-dot"></span>
                  {{ n.title }}
                </div>
                <div class="notify-item-body">{{ n.body }}</div>
                <div class="notify-item-time">{{ fmtTime(n.created_at) }}</div>
              </div>
            </div>
          </el-popover>

          <el-dropdown trigger="click" @command="onCommand">
            <span class="user-chip">
              <el-avatar :size="28" class="user-avatar">{{ avatarText }}</el-avatar>
              <span class="user-name">{{ auth.user?.name || '管理员' }}</span>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ auth.user?.phone }}</el-dropdown-item>
                <el-dropdown-item divided command="security">
                  <el-icon><Key /></el-icon>账号安全
                </el-dropdown-item>
                <el-dropdown-item command="password">
                  <el-icon><Lock /></el-icon>修改密码
                </el-dropdown-item>
                <el-dropdown-item command="logout">
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="main-content">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowDown, Bell, Key, Lock, Moon, Sunny, SwitchButton } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import { getNotifications, readNotifications } from '../api/admin'
import { fmtTime } from '../utils/format'
import { menus } from './menus'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const theme = useThemeStore()

// —— RBAC:侧边栏按权限过滤 ——
// 独立项按自身权限过滤;分组先过滤子项,再丢弃无可见子项的空分组
const visibleMenus = computed(() =>
  menus
    .map(item => {
      if (!item.children) return auth.can(item.perm) ? item : null
      const children = item.children.filter(c => auth.can(c.perm))
      return children.length ? { ...item, children } : null
    })
    .filter(Boolean)
)

const avatarText = computed(() => (auth.user?.name || '管').slice(0, 1))

// —— 通知:60s 轮询未读数,打开时刷新列表 ——
const unread = ref(0)
const notifications = ref([])
const notifyLoading = ref(false)
let pollTimer = null

async function loadNotifications() {
  notifyLoading.value = true
  try {
    const data = await getNotifications({ page: 1, pageSize: 10 })
    notifications.value = data.list || []
    unread.value = data.unread || 0
  } catch {
    /* 错误已统一提示 */
  } finally {
    notifyLoading.value = false
  }
}

async function pollUnread() {
  try {
    const data = await getNotifications({ page: 1, pageSize: 1 })
    unread.value = data.unread || 0
  } catch {
    /* 轮询失败静默 */
  }
}

async function markAllRead() {
  try {
    await readNotifications('all')
    unread.value = 0
    notifications.value = notifications.value.map(n => ({ ...n, read: 1 }))
    ElMessage.success('已全部标记为已读')
  } catch {
    /* 错误已统一提示 */
  }
}

// —— 通知点击跳转:risk → 风控预警,review → 企业准入,其余不跳 ——
const NOTIFY_ROUTE = { risk: '/risk', review: '/companies' }

function notifyTarget(n) {
  return NOTIFY_ROUTE[n.type] || ''
}

function onNotifyClick(n) {
  const target = notifyTarget(n)
  if (!target) return
  if (route.path !== target) {
    router.push(target)
  }
}

async function onCommand(cmd) {
  if (cmd === 'logout') {
    await auth.logout()
    ElMessage.success('已退出登录')
    router.push('/login')
  } else if (cmd === 'password') {
    router.push('/password')
  } else if (cmd === 'security') {
    router.push('/security')
  }
}

onMounted(() => {
  theme.syncFromServer()
  pollUnread()
  pollTimer = setInterval(pollUnread, 60000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.admin-layout {
  height: 100%;
}

.sidebar {
  background: var(--sidebar-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 18px;
  border-bottom: 1px solid var(--sidebar-divider);
}

.brand-logo {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.35);
}

.brand-name {
  color: #f9fafb;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.brand-role {
  color: var(--sidebar-muted);
  font-size: 12px;
  margin-top: 2px;
}

.side-menu {
  border-right: none;
  flex: 1;
  padding: 10px 10px 0;
  overflow-y: auto;
}

.side-menu :deep(.el-menu-item),
.side-menu :deep(.el-sub-menu__title) {
  height: 44px;
  line-height: 44px;
  margin-bottom: 4px;
  border-radius: 8px;
}

.side-menu :deep(.el-menu-item:hover),
.side-menu :deep(.el-sub-menu__title:hover) {
  background: var(--sidebar-hover);
}

.side-menu :deep(.el-menu-item.is-active) {
  background: #6366f1;
  color: #fff;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.35);
}

/* 展开后的二级菜单容器保持透明,叶子项自然缩进 */
.side-menu :deep(.el-sub-menu .el-menu) {
  background: transparent;
}

.side-menu :deep(.el-sub-menu .el-menu-item) {
  min-width: 0;
}

.side-footer {
  padding: 14px 18px;
  font-size: 12px;
  color: var(--sidebar-muted);
  border-top: 1px solid var(--sidebar-divider);
  text-align: center;
  letter-spacing: 1px;
}

.main-area {
  height: 100%;
  overflow: hidden;
}

.topbar {
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  transition: background-color 0.25s;
}

.topbar-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topbar-icon-btn {
  color: var(--text-2);
}

.bell-wrap {
  display: inline-flex;
  align-items: center;
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-2);
  font-size: 14px;
  outline: none;
}

.user-avatar {
  background: var(--accent);
  color: #fff;
  font-size: 13px;
}

.main-content {
  padding: 0;
  overflow-y: auto;
  background: var(--bg-page);
  transition: background-color 0.25s;
}

/* —— 通知面板 —— */
.notify-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.notify-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
}

.notify-list {
  max-height: 360px;
  overflow-y: auto;
  min-height: 80px;
}

.notify-item {
  padding: 10px 4px;
  border-bottom: 1px solid var(--border);
}

.notify-item:last-child {
  border-bottom: none;
}

.notify-item.clickable {
  cursor: pointer;
  transition: background-color 0.15s;
}

.notify-item.clickable:hover {
  background: var(--bg-hover);
}

.notify-item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}

.notify-item.unread .notify-item-title {
  color: var(--accent);
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
  color: var(--text-2);
  line-height: 1.6;
}

.notify-item-time {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
