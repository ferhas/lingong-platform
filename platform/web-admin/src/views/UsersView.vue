<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">用户管理</h2>
        <p class="page-sub">管理运营后台的登录账号和角色权限,谁能看什么、能操作什么都在这里设置</p>
      </div>
      <div class="page-actions">
        <el-button
          v-if="canManage && activeTab === 'accounts'"
          type="primary"
          :icon="Plus"
          @click="openCreate"
        >
          新建账号
        </el-button>
        <el-button
          v-if="canManage && activeTab === 'roles'"
          type="primary"
          :icon="Plus"
          @click="openRoleCreate"
        >
          新建角色
        </el-button>
        <el-button :icon="Refresh" circle @click="reload" />
      </div>
    </div>

    <div class="panel">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="账号列表" name="accounts" />
        <el-tab-pane label="角色管理" name="roles" />
      </el-tabs>

      <!-- ===== 账号列表 ===== -->
      <template v-if="activeTab === 'accounts'">
        <el-table :data="list" v-loading="loading" stripe>
          <el-table-column prop="id" label="ID" width="70" align="center" />
          <el-table-column prop="name" label="姓名" min-width="110" />
          <el-table-column prop="phone" label="手机号" min-width="140">
            <template #default="{ row }">
              <span class="mono">{{ row.phone }}</span>
            </template>
          </el-table-column>
          <el-table-column label="角色" min-width="130">
            <template #default="{ row }">
              <el-tag size="small" effect="plain" type="primary">{{ row.roleName || '未分配' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
                {{ row.status === 'active' ? '正常' : '已停用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="160">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column v-if="canManage" label="操作" width="240" fixed="right">
            <template #default="{ row }">
              <template v-if="row.id !== auth.user?.id">
                <el-button type="primary" link size="small" @click="openRole(row)">改角色</el-button>
                <el-button
                  v-if="row.status === 'active'"
                  type="danger"
                  link
                  size="small"
                  @click="toggleStatus(row, false)"
                >
                  停用
                </el-button>
                <el-button v-else type="success" link size="small" @click="toggleStatus(row, true)">
                  启用
                </el-button>
                <el-button type="warning" link size="small" @click="resetPassword(row)">重置密码</el-button>
              </template>
              <el-tag v-else size="small" type="info" effect="plain">当前账号</el-tag>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无运营账号" :image-size="90" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="total"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="load"
            @size-change="onSizeChange"
          />
        </div>
      </template>

      <!-- ===== 角色管理 ===== -->
      <template v-else>
        <el-alert type="info" :closable="false" show-icon class="roles-tip">
          角色是一组权限点的集合。给账号分配角色后,该账号就只能访问角色允许的页面和操作。预置角色不可删除,「超级管理员」整体只读。
        </el-alert>
        <div v-loading="rolesLoading" class="role-grid">
          <el-empty
            v-if="!rolesLoading && roles.length === 0"
            description="暂无角色,点击右上角「新建角色」创建"
            :image-size="90"
            class="role-empty"
          />
          <div v-for="r in roles" :key="r.id" class="role-card">
            <div class="role-card-head">
              <span class="role-name">{{ r.name }}</span>
              <el-tag v-if="isPreset(r)" size="small" type="warning" effect="plain">预置</el-tag>
              <el-tag v-else size="small" type="primary" effect="plain">自定义</el-tag>
            </div>
            <div class="perm-tags">
              <el-tag
                v-for="perm in r.permissions"
                :key="perm"
                size="small"
                effect="plain"
                :type="perm === '*' ? 'danger' : 'info'"
              >
                {{ perm === '*' ? '全部权限' : permText(perm) }}
              </el-tag>
            </div>
            <div v-if="canManage" class="role-card-actions">
              <el-tooltip
                v-if="r.name === '超级管理员'"
                content="超级管理员拥有全部权限,角色整体只读,不可修改和删除"
                placement="top"
              >
                <el-tag size="small" type="info" effect="plain">只读</el-tag>
              </el-tooltip>
              <template v-else>
                <el-button type="primary" link size="small" @click="openRoleEdit(r)">编 辑</el-button>
                <el-button
                  v-if="!isPreset(r)"
                  type="danger"
                  link
                  size="small"
                  @click="removeRole(r)"
                >
                  删 除
                </el-button>
                <el-tooltip v-else content="预置角色不可删除,但可以调整权限点" placement="top">
                  <el-icon class="role-lock-icon"><Lock /></el-icon>
                </el-tooltip>
              </template>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 新建账号 -->
    <el-dialog v-model="createDialog.visible" title="新建运营账号" width="520px" destroy-on-close>
      <el-form ref="createFormRef" :model="createDialog.form" :rules="createRules" label-position="top">
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="createDialog.form.phone" maxlength="11" placeholder="登录手机号" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="createDialog.form.name" maxlength="30" placeholder="员工姓名" />
        </el-form-item>
        <el-form-item label="角色" prop="roleId">
          <el-select v-model="createDialog.form.roleId" placeholder="选择角色" style="width: 100%">
            <el-option v-for="r in roles" :key="r.id" :label="r.name" :value="r.id" />
          </el-select>
        </el-form-item>
        <div v-if="selectedRole" class="perm-preview">
          <div class="perm-preview-title">「{{ selectedRole.name }}」权限点预览</div>
          <div class="perm-tags">
            <el-tag
              v-for="perm in selectedRole.permissions"
              :key="perm"
              size="small"
              effect="plain"
              :type="perm === '*' ? 'danger' : 'info'"
            >
              {{ perm === '*' ? '全部权限' : permText(perm) }}
            </el-tag>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="createDialog.submitting" @click="submitCreate">创 建</el-button>
      </template>
    </el-dialog>

    <!-- 临时密码展示 -->
    <el-dialog v-model="tempDialog.visible" :title="tempDialog.title" width="440px">
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 14px">
        临时密码仅展示一次,请立即复制并转交本人,首次登录后建议尽快修改。
      </el-alert>
      <div class="temp-pwd-box">
        <span class="mono temp-pwd">{{ tempDialog.password }}</span>
        <el-button type="primary" size="small" :icon="CopyDocument" @click="copyTempPassword">复 制</el-button>
      </div>
      <template #footer>
        <el-button type="primary" @click="tempDialog.visible = false">我已保存</el-button>
      </template>
    </el-dialog>

    <!-- 修改账号角色 -->
    <el-dialog v-model="roleDialog.visible" title="修改角色" width="440px" destroy-on-close>
      <p class="role-dialog-tip">
        为「{{ roleDialog.user?.name }}」({{ roleDialog.user?.phone }})指定新角色:
      </p>
      <el-select v-model="roleDialog.roleId" placeholder="选择角色" style="width: 100%">
        <el-option v-for="r in roles" :key="r.id" :label="r.name" :value="r.id" />
      </el-select>
      <div v-if="roleDialogRole" class="perm-preview">
        <div class="perm-preview-title">权限点预览</div>
        <div class="perm-tags">
          <el-tag
            v-for="perm in roleDialogRole.permissions"
            :key="perm"
            size="small"
            effect="plain"
            :type="perm === '*' ? 'danger' : 'info'"
          >
            {{ perm === '*' ? '全部权限' : permText(perm) }}
          </el-tag>
        </div>
      </div>
      <template #footer>
        <el-button @click="roleDialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="roleDialog.submitting" @click="submitRole">确 定</el-button>
      </template>
    </el-dialog>

    <!-- 新建 / 编辑角色 -->
    <el-dialog
      v-model="roleForm.visible"
      :title="roleForm.id ? `编辑角色「${roleForm.originName}」` : '新建角色'"
      width="640px"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-form-item label="角色名称">
          <el-input
            v-model="roleForm.name"
            maxlength="20"
            placeholder="2-20 个字,例如:客服专员"
            :disabled="roleForm.presetName"
          />
          <div v-if="roleForm.presetName" class="role-form-tip">预置角色不可改名,仅可调整权限点</div>
        </el-form-item>
        <el-form-item label="权限点(按模块分组勾选)">
          <div class="perm-group-list">
            <div v-for="g in permGroups" :key="g.title" class="perm-group">
              <div class="perm-group-title">{{ g.title }}</div>
              <el-checkbox-group v-model="roleForm.permissions">
                <el-checkbox v-for="p in g.items" :key="p.key" :value="p.key">
                  {{ p.label }}
                  <span class="mono perm-key">{{ p.key }}</span>
                </el-checkbox>
              </el-checkbox-group>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="role-form-count">已选 {{ roleForm.permissions.length }} / {{ permCatalog.length }} 项</span>
        <el-button @click="roleForm.visible = false">取 消</el-button>
        <el-button type="primary" :loading="roleForm.submitting" @click="submitRoleForm">
          {{ roleForm.id ? '保 存' : '创 建' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, CopyDocument, Lock } from '@element-plus/icons-vue'
import {
  getRoles,
  getPermissions,
  createRole,
  updateRole,
  deleteRole,
  getAdminUsers,
  createAdminUser,
  updateUserRole,
  disableUser,
  enableUser,
  resetUserPassword
} from '../api/admin'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canManage = computed(() => auth.can('user:manage'))

const activeTab = ref('accounts')
const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const roles = ref([])
const rolesLoading = ref(false)

// 后端预置角色,与 server 端 PRESET_ROLES 对齐
const PRESET_ROLE_NAMES = new Set(['超级管理员', '审核专员', '风控专员', '财务税务', '只读审计'])

function isPreset(role) {
  return PRESET_ROLE_NAMES.has(role.name)
}

// 兜底文案(权限点清单接口加载前/失败时使用)
const PERM_TEXT_FALLBACK = {
  'dashboard:read': '查看运营总览',
  'company:read': '查看企业',
  'company:review': '企业入驻审核',
  'worker:read': '查看零工',
  'worker:manage': '零工锁定/管理',
  'risk:read': '查看风控预警',
  'risk:resolve': '处理风控预警',
  'tax:read': '查看税务',
  'tax:declare': '税务申报与报送',
  'flow:read': '资金流水/单据/对账',
  'archive:read': '凭证归档/证明包',
  'integration:read': '查看外部服务状态',
  'config:read': '查看业务参数配置',
  'config:write': '修改业务参数和协议模板',
  'user:read': '查看运营用户',
  'user:manage': '管理运营用户',
  'audit:read': '查看审计日志'
}

// 权限点中文清单:GET /admin/permissions(17项)
const permCatalog = ref(
  Object.entries(PERM_TEXT_FALLBACK).map(([key, label]) => ({ key, label }))
)

const permLabelMap = computed(() =>
  Object.fromEntries(permCatalog.value.map(p => [p.key, p.label]))
)

function permText(perm) {
  return permLabelMap.value[perm] || PERM_TEXT_FALLBACK[perm] || perm
}

// 勾选时按业务模块分组,降低理解成本
const PERM_GROUP_DEF = [
  { title: '运营总览', prefixes: ['dashboard:'] },
  { title: '企业入驻审核', prefixes: ['company:'] },
  { title: '零工管理', prefixes: ['worker:'] },
  { title: '风控 / 回访 / 理赔', prefixes: ['risk:'] },
  { title: '税务 / 发票', prefixes: ['tax:'] },
  { title: '资金 / 凭证 / 外部服务', prefixes: ['flow:', 'archive:', 'integration:'] },
  { title: '业务参数 / 协议模板', prefixes: ['config:'] },
  { title: '运营用户', prefixes: ['user:'] },
  { title: '审计日志', prefixes: ['audit:'] }
]

const permGroups = computed(() =>
  PERM_GROUP_DEF.map(g => ({
    title: g.title,
    items: permCatalog.value.filter(p => g.prefixes.some(pre => p.key.startsWith(pre)))
  })).filter(g => g.items.length > 0)
)

const createFormRef = ref()
const createDialog = reactive({
  visible: false,
  submitting: false,
  form: { phone: '', name: '', roleId: null }
})

const createRules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1\d{10}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  roleId: [{ required: true, message: '请选择角色', trigger: 'change' }]
}

const selectedRole = computed(() => roles.value.find(r => r.id === createDialog.form.roleId))

const tempDialog = reactive({ visible: false, title: '', password: '' })
const roleDialog = reactive({ visible: false, submitting: false, user: null, roleId: null })
const roleDialogRole = computed(() => roles.value.find(r => r.id === roleDialog.roleId))

// 新建/编辑角色对话框
const roleForm = reactive({
  visible: false,
  submitting: false,
  id: null,
  originName: '',
  presetName: false,
  name: '',
  permissions: []
})

async function load() {
  loading.value = true
  try {
    const data = await getAdminUsers({ page: page.value, pageSize: pageSize.value })
    list.value = data.list
    total.value = data.total
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

function onSizeChange() {
  page.value = 1
  load()
}

async function loadRoles() {
  rolesLoading.value = true
  try {
    const data = await getRoles()
    roles.value = data.list || []
  } catch {
    /* 错误已统一提示 */
  } finally {
    rolesLoading.value = false
  }
}

async function loadPermCatalog() {
  try {
    const data = await getPermissions()
    if (data.list?.length) permCatalog.value = data.list
  } catch {
    /* 用兜底文案 */
  }
}

function reload() {
  if (activeTab.value === 'accounts') load()
  loadRoles()
}

function openCreate() {
  createDialog.form = { phone: '', name: '', roleId: null }
  createDialog.visible = true
}

async function submitCreate() {
  const valid = await createFormRef.value.validate().catch(() => false)
  if (!valid) return
  createDialog.submitting = true
  try {
    const res = await createAdminUser({
      phone: createDialog.form.phone,
      name: createDialog.form.name,
      roleId: createDialog.form.roleId
    })
    createDialog.visible = false
    tempDialog.title = '账号创建成功·临时密码'
    tempDialog.password = res.tempPassword
    tempDialog.visible = true
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    createDialog.submitting = false
  }
}

async function copyTempPassword() {
  try {
    await navigator.clipboard.writeText(tempDialog.password)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败,请手动选中复制')
  }
}

function openRole(user) {
  roleDialog.user = user
  roleDialog.roleId = user.roleId || null
  roleDialog.visible = true
}

async function submitRole() {
  if (!roleDialog.roleId) {
    ElMessage.warning('请选择角色')
    return
  }
  roleDialog.submitting = true
  try {
    await updateUserRole(roleDialog.user.id, roleDialog.roleId)
    roleDialog.visible = false
    ElMessage.success('角色已更新')
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    roleDialog.submitting = false
  }
}

// —— 角色 CRUD ——
function openRoleCreate() {
  roleForm.id = null
  roleForm.originName = ''
  roleForm.presetName = false
  roleForm.name = ''
  roleForm.permissions = []
  roleForm.visible = true
}

function openRoleEdit(role) {
  roleForm.id = role.id
  roleForm.originName = role.name
  roleForm.presetName = isPreset(role)
  roleForm.name = role.name
  // 超管的 '*' 不会进入此分支;普通角色权限点直接回填
  roleForm.permissions = role.permissions.filter(p => p !== '*')
  roleForm.visible = true
}

async function submitRoleForm() {
  const name = roleForm.name.trim()
  if (!roleForm.presetName && (name.length < 2 || name.length > 20)) {
    ElMessage.warning('角色名称需 2-20 个字')
    return
  }
  if (roleForm.permissions.length === 0) {
    ElMessage.warning('请至少勾选一个权限点')
    return
  }
  roleForm.submitting = true
  try {
    if (roleForm.id) {
      const payload = { permissions: [...roleForm.permissions] }
      // 预置角色不可改名,不传 name;自定义角色名称变化才传
      if (!roleForm.presetName && name !== roleForm.originName) payload.name = name
      await updateRole(roleForm.id, payload)
      ElMessage.success(`角色「${roleForm.presetName ? roleForm.originName : name}」已更新`)
    } else {
      await createRole({ name, permissions: [...roleForm.permissions] })
      ElMessage.success(`角色「${name}」已创建,可在新建账号时选用`)
    }
    roleForm.visible = false
    loadRoles()
  } catch {
    /* 错误已统一提示 */
  } finally {
    roleForm.submitting = false
  }
}

async function removeRole(role) {
  try {
    await ElMessageBox.confirm(
      `确定删除自定义角色「${role.name}」吗?若仍有账号在使用该角色,删除会被拒绝,需先把这些账号改为其他角色。`,
      '删除角色确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await deleteRole(role.id)
    ElMessage.success(`角色「${role.name}」已删除`)
    loadRoles()
  } catch {
    /* 409(使用中)等错误已由拦截器提示「仍有 N 个账号使用该角色,请先调整」 */
  }
}

async function toggleStatus(user, enable) {
  const action = enable ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(
      `确定${action}账号「${user.name}」(${user.phone})吗?${enable ? '' : '停用后该账号将无法登录。'}`,
      `${action}确认`,
      { type: 'warning', confirmButtonText: `确认${action}`, cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await (enable ? enableUser(user.id) : disableUser(user.id))
    ElMessage.success(`已${action}该账号`)
    load()
  } catch {
    /* 错误已统一提示 */
  }
}

async function resetPassword(user) {
  try {
    await ElMessageBox.confirm(
      `确定重置「${user.name}」(${user.phone})的登录密码吗?原密码将立即失效。`,
      '重置密码确认',
      { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    const res = await resetUserPassword(user.id)
    tempDialog.title = '密码已重置·新临时密码'
    tempDialog.password = res.tempPassword
    tempDialog.visible = true
  } catch {
    /* 错误已统一提示 */
  }
}

onMounted(() => {
  load()
  loadRoles()
  loadPermCatalog()
})
</script>

<style scoped>
.roles-tip {
  margin-bottom: 16px;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  min-height: 120px;
}

.role-empty {
  grid-column: 1 / -1;
}

.role-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: box-shadow 0.2s;
}

.role-card:hover {
  box-shadow: 0 4px 12px rgba(17, 24, 39, 0.08);
}

.role-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.role-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.role-card-actions {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.role-lock-icon {
  color: var(--text-3);
  font-size: 14px;
}

.perm-preview {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-top: 6px;
}

.perm-preview-title {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 8px;
}

.perm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.perm-group-list {
  width: 100%;
  max-height: 380px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 14px;
}

.perm-group {
  padding: 10px 0;
  border-bottom: 1px dashed var(--border);
}

.perm-group:last-child {
  border-bottom: none;
}

.perm-group-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-2);
  margin-bottom: 4px;
}

.perm-key {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.role-form-tip {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
}

.role-form-count {
  float: left;
  font-size: 12px;
  color: var(--text-3);
  line-height: 32px;
}

.temp-pwd-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--bg-hover);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}

.temp-pwd {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 1px;
  user-select: all;
}

.role-dialog-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-2);
}
</style>
