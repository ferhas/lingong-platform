<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">风控预警</h2>
        <p class="page-sub">违禁词、负面行业、异常交易等风险事件处置</p>
      </div>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <!-- 风控工具入口 -->
    <div class="tool-cards">
      <div class="tool-card" @click="openIpDrawer">
        <div class="tool-icon ip"><el-icon><Share /></el-icon></div>
        <div class="tool-info">
          <div class="tool-title">同IP多账号</div>
          <div class="tool-desc">近30天内同一个网络地址登录过 3 个及以上账号的名单——可能是同一伙人批量注册刷单,点开排查</div>
        </div>
        <el-icon class="tool-arrow"><ArrowRight /></el-icon>
      </div>
      <div class="tool-card" @click="router.push('/quality')">
        <div class="tool-icon quality"><el-icon><PhoneFilled /></el-icon></div>
        <div class="tool-info">
          <div class="tool-title">回访与理赔工作台</div>
          <div class="tool-desc">电话回访已结算任务核实业务真实性;回访异常会自动生成高风险预警回到本页</div>
        </div>
        <el-icon class="tool-arrow"><ArrowRight /></el-icon>
      </div>
    </div>

    <div class="panel">
      <el-tabs v-model="activeStatus" @tab-change="load">
        <el-tab-pane label="待处理" name="open" />
        <el-tab-pane label="已处理" name="resolved" />
        <el-tab-pane label="全部" name="all" />
      </el-tabs>

      <div v-loading="loading" class="alert-list">
        <el-empty v-if="!loading && list.length === 0" description="暂无预警事件" :image-size="90" />
        <div v-for="alert in list" :key="alert.id" class="alert-card" :class="`level-${levelKey(alert.level)}`">
          <div class="alert-main">
            <div class="alert-head">
              <el-tag :type="levelTagType(alert.level)" effect="dark" size="small">
                {{ alert.level }}风险
              </el-tag>
              <span class="alert-type">{{ alert.type }}</span>
              <el-tag v-if="alert.status === 'resolved'" type="success" size="small" effect="plain">已处理</el-tag>
              <el-tag v-else type="danger" size="small" effect="plain">待处理</el-tag>
            </div>
            <div class="alert-detail">{{ alert.detail }}</div>
            <div class="alert-meta">
              <span>触发时间：{{ fmtTime(alert.createdAt) }}</span>
              <span v-if="alert.resolvedAt">处理时间：{{ fmtTime(alert.resolvedAt) }}</span>
              <span v-if="alert.resolveNote">处置说明：{{ alert.resolveNote }}</span>
            </div>
          </div>
          <div class="alert-actions">
            <el-button
              v-if="canJumpRef(alert)"
              size="small"
              plain
              @click="jumpRef(alert)"
            >
              {{ alert.refType === 'company' ? '查看涉事企业' : '查看涉事零工' }}
            </el-button>
            <el-button
              v-if="alert.status === 'open' && canResolve"
              type="primary"
              size="small"
              @click="openResolve(alert)"
            >
              处 理
            </el-button>
            <el-tooltip
              v-else-if="alert.status === 'open'"
              content="需要「风控处置」权限"
              placement="top"
            >
              <span>
                <el-button type="primary" size="small" disabled>处 理</el-button>
              </span>
            </el-tooltip>
          </div>
        </div>
      </div>
    </div>

    <!-- 处理对话框 -->
    <el-dialog v-model="dialog.visible" title="预警处置" width="480px" destroy-on-close>
      <el-alert
        v-if="dialog.alert"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #title>{{ dialog.alert.type }}（{{ dialog.alert.level }}风险）</template>
        {{ dialog.alert.detail }}
      </el-alert>
      <el-form label-position="top">
        <el-form-item label="处置说明">
          <el-input
            v-model="dialog.note"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如：已联系企业整改任务描述，并对发布人进行合规提示"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="dialog.submitting" @click="submitResolve">确认处理</el-button>
      </template>
    </el-dialog>

    <!-- 同IP多账号抽屉 -->
    <el-drawer v-model="ipDrawer.visible" title="同IP多账号关联(近30天)" size="560px">
      <div v-loading="ipDrawer.loading">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
          同一个 IP(网络地址)短期登录多个账号,常见于:一伙人批量注册小号刷单、企业自己注册零工号虚构业务。请结合账号角色与交易记录排查。
        </el-alert>
        <el-empty
          v-if="!ipDrawer.loading && ipDrawer.list.length === 0"
          description="近30天没有发现同IP登录3个及以上账号的情况"
          :image-size="80"
        />
        <div v-for="item in ipDrawer.list" :key="item.ip" class="ip-card">
          <div class="ip-head">
            <span class="mono ip-addr">{{ item.ip }}</span>
            <el-tag type="danger" size="small" effect="plain">{{ item.userCount }} 个账号</el-tag>
          </div>
          <div class="ip-users">
            <el-tag
              v-for="u in item.users"
              :key="u.id"
              size="small"
              effect="plain"
              :type="IP_ROLE_TAG[u.role] || 'info'"
            >
              {{ u.name || `用户#${u.id}` }}·{{ IP_ROLE_TEXT[u.role] || u.role || '未知' }}
            </el-tag>
            <span v-if="item.userCount > item.users.length" class="ip-more">
              等共 {{ item.userCount }} 个账号
            </span>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, Share, PhoneFilled, ArrowRight } from '@element-plus/icons-vue'
import { getRiskAlerts, resolveRiskAlert, getIpGraph } from '../api/admin'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()
const canResolve = computed(() => auth.can('risk:resolve'))

const activeStatus = ref('open')
const loading = ref(false)
const list = ref([])

const dialog = reactive({ visible: false, alert: null, note: '', submitting: false })

// —— 同IP多账号抽屉 ——
const ipDrawer = reactive({ visible: false, loading: false, list: [] })
const IP_ROLE_TEXT = { worker: '零工', company: '企业', admin: '运营' }
const IP_ROLE_TAG = { worker: 'primary', company: 'warning', admin: 'danger' }

async function openIpDrawer() {
  ipDrawer.visible = true
  ipDrawer.loading = true
  try {
    const data = await getIpGraph()
    ipDrawer.list = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    ipDrawer.loading = false
  }
}

function levelKey(level) {
  return { 高: 'high', 中: 'mid', 低: 'low' }[level] || 'low'
}

function levelTagType(level) {
  return level === '高' ? 'danger' : level === '中' ? 'warning' : 'info'
}

// —— 关联跳转:携带 ?focus=ID,目标列表页自动打开详情抽屉 ——
const REF_ROUTE = {
  company: { path: '/companies', perm: 'company:read' },
  worker: { path: '/workers', perm: 'worker:read' }
}

function canJumpRef(alert) {
  const ref = REF_ROUTE[alert.refType]
  return Boolean(ref && alert.refId && auth.can(ref.perm))
}

function jumpRef(alert) {
  router.push({ path: REF_ROUTE[alert.refType].path, query: { focus: alert.refId } })
}

async function load() {
  loading.value = true
  try {
    const data = await getRiskAlerts(activeStatus.value)
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

function openResolve(alert) {
  dialog.alert = alert
  dialog.note = ''
  dialog.visible = true
}

async function submitResolve() {
  dialog.submitting = true
  try {
    await resolveRiskAlert(dialog.alert.id, { note: dialog.note.trim() })
    dialog.visible = false
    ElMessage.success('预警已处理')
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    dialog.submitting = false
  }
}

onMounted(load)
</script>

<style scoped>
.alert-list {
  min-height: 120px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.alert-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-radius: 10px;
  padding: 16px 18px;
  background: var(--bg-card);
  transition: box-shadow 0.2s;
}

.alert-card:hover {
  box-shadow: 0 4px 12px rgba(17, 24, 39, 0.08);
}

.alert-card.level-high {
  border-left-color: var(--danger);
}

.alert-card.level-mid {
  border-left-color: var(--warning);
}

.alert-card.level-low {
  border-left-color: var(--text-3);
}

.alert-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.alert-type {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.alert-detail {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
}

.alert-meta {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.alert-actions {
  flex-shrink: 0;
}

/* —— 风控工具入口卡 —— */
.tool-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.tool-card {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--bg-card);
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
}

.tool-card:hover {
  border-color: var(--accent);
  box-shadow: 0 4px 12px rgba(17, 24, 39, 0.08);
}

.tool-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 18px;
}

.tool-icon.ip {
  background: linear-gradient(135deg, #ef4444, #f97316);
}

.tool-icon.quality {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.tool-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
}

.tool-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}

.tool-arrow {
  flex-shrink: 0;
  color: var(--text-3);
}

/* —— 同IP抽屉 —— */
.ip-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
}

.ip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ip-addr {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
}

.ip-users {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.ip-more {
  font-size: 12px;
  color: var(--text-3);
}
</style>
