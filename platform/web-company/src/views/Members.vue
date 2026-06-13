<template>
  <div>
    <PageHeader title="成员管理" subtitle="企业子账号管理：运营可发布/验收任务，财务可充值">
      <template #actions>
        <el-button type="primary" @click="addVisible = true">
          <el-icon style="margin-right: 4px"><Plus /></el-icon>添加成员
        </el-button>
      </template>
    </PageHeader>

    <div class="page-card">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="name" label="姓名" min-width="120" />
        <el-table-column prop="phone" label="手机号" width="140" />
        <el-table-column label="角色" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="roleMeta(row.memberRole).tag" effect="light">{{ roleMeta(row.memberRole).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'active' ? '正常' : '已停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="加入时间" width="180">
          <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="center">
          <template #default="{ row }">
            <template v-if="row.memberRole !== 'owner'">
              <el-dropdown trigger="click" @command="r => onChangeRole(row, r)">
                <el-button type="primary" link :loading="changingId === row.userId">
                  改角色<el-icon style="margin-left: 2px"><ArrowDown /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="operator" :disabled="row.memberRole === 'operator'">
                      运营（发布/验收任务）
                    </el-dropdown-item>
                    <el-dropdown-item command="finance" :disabled="row.memberRole === 'finance'">
                      财务（充值/对账）
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button
                v-if="row.status === 'active'"
                type="danger"
                link
                style="margin-left: 12px"
                @click="onDisable(row)"
              >停用</el-button>
            </template>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无成员" />
        </template>
      </el-table>
    </div>

    <!-- 添加成员 -->
    <el-dialog v-model="addVisible" title="添加成员" width="460px" destroy-on-close>
      <el-form ref="addRef" :model="addForm" :rules="addRules" label-width="80px">
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="addForm.phone" maxlength="11" placeholder="成员登录手机号" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="addForm.name" maxlength="30" placeholder="成员姓名" />
        </el-form-item>
        <el-form-item label="角色" prop="memberRole">
          <el-radio-group v-model="addForm.memberRole">
            <el-radio-button value="operator">运营（发布/验收任务）</el-radio-button>
            <el-radio-button value="finance">财务（充值/对账）</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="onAdd">确认添加</el-button>
      </template>
    </el-dialog>

    <!-- 临时密码展示 -->
    <el-dialog v-model="tempVisible" title="成员已添加" width="460px" :close-on-click-modal="false">
      <el-result icon="success" title="成员账号已创建">
        <template #sub-title>
          <div class="temp-tip">请将以下临时密码<b>线下转交</b>给成员，成员首次登录后应尽快修改密码。</div>
        </template>
      </el-result>
      <div class="temp-pwd-box">
        <span class="temp-pwd mono">{{ tempPassword }}</span>
        <el-button type="primary" size="small" @click="copyTemp">
          <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制
        </el-button>
      </div>
      <template #footer>
        <el-button type="primary" @click="tempVisible = false">我已转交，关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import { getMembers, addMember, changeMemberRole, disableMember } from '../api/company'
import { fmtDateTime, MEMBER_ROLE } from '../utils/format'

const list = ref([])
const loading = ref(false)

const addVisible = ref(false)
const adding = ref(false)
const addRef = ref()
const addForm = reactive({ phone: '', name: '', memberRole: 'operator' })
const addRules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1\d{10}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  memberRole: [{ required: true, message: '请选择角色', trigger: 'change' }]
}

const tempVisible = ref(false)
const tempPassword = ref('')

const roleMeta = r => MEMBER_ROLE[r] || { label: r, tag: 'info' }

async function fetchList() {
  loading.value = true
  try {
    const data = await getMembers()
    list.value = data.list
  } finally {
    loading.value = false
  }
}

async function onAdd() {
  try {
    await addRef.value.validate()
  } catch {
    return
  }
  adding.value = true
  try {
    const res = await addMember({ ...addForm })
    addVisible.value = false
    tempPassword.value = res.tempPassword
    tempVisible.value = true
    addForm.phone = ''
    addForm.name = ''
    addForm.memberRole = 'operator'
    await fetchList()
  } catch {
    // 错误已由拦截器提示
  } finally {
    adding.value = false
  }
}

async function copyTemp() {
  try {
    await navigator.clipboard.writeText(tempPassword.value)
    ElMessage.success('临时密码已复制')
  } catch {
    ElMessage.warning('复制失败，请手动复制')
  }
}

const changingId = ref(null)

async function onChangeRole(row, memberRole) {
  if (memberRole === row.memberRole) return
  changingId.value = row.userId
  try {
    await changeMemberRole(row.userId, memberRole)
    ElMessage.success(`已将「${row.name}」的角色调整为${roleMeta(memberRole).label}`)
    await fetchList()
  } catch {
    // 错误已由拦截器提示
  } finally {
    changingId.value = null
  }
}

async function onDisable(row) {
  try {
    await ElMessageBox.confirm(
      `停用成员「${row.name}」后，该账号将立即无法登录，其历史操作记录会保留。是否继续？`,
      '停用成员',
      { confirmButtonText: '继续停用', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await disableMember(row.userId)
    ElMessage.success('成员已停用')
    await fetchList()
  } catch {
    // 错误已由拦截器提示
  }
}

onMounted(fetchList)
</script>

<style scoped>
.temp-tip {
  font-size: 13px;
  color: var(--text-2);
}

.temp-pwd-box {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--bg-hover);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}

.temp-pwd {
  font-size: 18px;
  font-weight: 700;
  color: var(--brand);
  letter-spacing: 1px;
}
</style>
