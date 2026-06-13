<template>
  <div>
    <PageHeader title="企业资料" subtitle="企业准入信息与联系方式管理" />

    <!-- 电子签授权引导（已准入但未授权时醒目展示） -->
    <div v-if="profile?.status === 'approved' && !profile.esignAuthorized" class="esign-card">
      <div class="esign-icon">
        <el-icon :size="26"><EditPen /></el-icon>
      </div>
      <div class="esign-body">
        <div class="esign-title">完成电子签授权，工单自动静默签署</div>
        <div class="esign-desc">
          完成一次性签署授权后，后续任务工单、分包工单将由平台自动静默签署，无需逐单确认，发单与录用流程更顺畅。
          {{ isOwner ? '' : '该操作需企业主账号完成。' }}
        </div>
      </div>
      <el-button
        v-if="isOwner"
        type="primary"
        size="large"
        :loading="authorizing"
        @click="onEsignAuth"
      >
        立即授权
      </el-button>
    </div>

    <div class="page-card" v-loading="profileStore.loading">
      <template v-if="profile">
        <el-alert
          v-if="!isOwner"
          type="info"
          show-icon
          :closable="false"
          title="您是企业成员账号，资料仅供查看，编辑联系方式请联系企业主"
          class="readonly-alert"
        />

        <el-descriptions :column="2" border>
          <el-descriptions-item label="企业名称">{{ profile.companyName }}</el-descriptions-item>
          <el-descriptions-item label="统一社会信用代码">{{ profile.licenseNo }}</el-descriptions-item>
          <el-descriptions-item label="所属行业">{{ profile.industry }}</el-descriptions-item>
          <el-descriptions-item label="准入状态">
            <el-tag :type="statusMeta.tag" effect="light">{{ statusMeta.label }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="框架合同编号">{{ profile.masterContractNo || '—' }}</el-descriptions-item>
          <el-descriptions-item label="我的角色">
            <el-tag :type="roleMeta.tag" effect="plain">{{ roleMeta.label }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="电子签授权">
            <el-tag :type="profile.esignAuthorized ? 'success' : 'warning'" effect="light">
              {{ profile.esignAuthorized ? '已授权（工单自动静默签署）' : '未授权' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="profile.reviewNote" label="审核备注" :span="2">
            {{ profile.reviewNote }}
          </el-descriptions-item>
          <el-descriptions-item label="账户总额">
            <span class="money">¥{{ fmtMoney(profile.account?.balance) }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="可用余额">
            <span class="money">¥{{ fmtMoney(profile.account?.available) }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 零工邀请码（owner/operator 可见） -->
        <template v-if="invite">
          <h3 class="page-title contact-title">零工邀请码</h3>
          <div class="invite-box">
            <div class="invite-code mono">{{ invite.inviteCode }}</div>
            <el-button type="primary" plain size="small" @click="copyInviteCode">
              <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制邀请码
            </el-button>
            <div class="invite-meta">
              已邀请 <b>{{ invite.invitedWorkers }}</b> 名零工注册
            </div>
          </div>
          <div class="invite-tip">将邀请码分享给长期合作的零工，注册时填写即可与贵司建立定向合作关系</div>
        </template>

        <h3 class="page-title contact-title">联系方式</h3>
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-width="100px"
          class="contact-form"
          :disabled="!isOwner"
        >
          <el-form-item label="联系电话" prop="contactPhone">
            <el-input v-model="form.contactPhone" maxlength="20" placeholder="企业联系电话" />
          </el-form-item>
          <el-form-item label="联系邮箱" prop="contactEmail">
            <el-input v-model="form.contactEmail" maxlength="60" placeholder="企业联系邮箱" />
          </el-form-item>
          <el-form-item v-if="isOwner">
            <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
          </el-form-item>
        </el-form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import { patchProfile, esignAuth, getInviteCode } from '../api/company'
import { useAuthStore } from '../stores/auth'
import { useProfileStore } from '../stores/profile'
import { fmtMoney, COMPANY_STATUS, MEMBER_ROLE } from '../utils/format'

const auth = useAuthStore()
const profileStore = useProfileStore()

const profile = computed(() => profileStore.profile)
const isOwner = computed(() => auth.isOwner || profile.value?.memberRole === 'owner')
const statusMeta = computed(
  () => COMPANY_STATUS[profile.value?.status] || { label: '未知', tag: 'info' }
)
const roleMeta = computed(
  () => MEMBER_ROLE[profile.value?.memberRole || auth.memberRole] || { label: '成员', tag: 'info' }
)

const formRef = ref()
const saving = ref(false)
const form = reactive({ contactPhone: '', contactEmail: '' })

const rules = {
  contactEmail: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }]
}

watch(
  profile,
  p => {
    if (p) {
      form.contactPhone = p.contactPhone || ''
      form.contactEmail = p.contactEmail || ''
    }
  },
  { immediate: true }
)

async function onSave() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  saving.value = true
  try {
    await patchProfile({
      contactPhone: form.contactPhone || undefined,
      contactEmail: form.contactEmail || undefined
    })
    ElMessage.success('联系方式已保存')
    await profileStore.fetch()
  } catch {
    // 错误已由拦截器提示
  } finally {
    saving.value = false
  }
}

// —— 电子签授权 ——
const authorizing = ref(false)

async function onEsignAuth() {
  try {
    await ElMessageBox.confirm(
      '授权后，平台将代为对任务工单、分包工单进行自动静默签署（与逐单签署具有同等法律效力），授权一次长期有效。是否继续？',
      '电子签静默签授权',
      { confirmButtonText: '同意并授权', cancelButtonText: '再想想', type: 'info' }
    )
  } catch {
    return
  }
  authorizing.value = true
  try {
    const res = await esignAuth()
    ElMessage.success(`电子签授权完成（授权编号 ${res.authId}），后续工单将自动静默签署`)
    await profileStore.fetch()
  } catch {
    // 错误已由拦截器提示
  } finally {
    authorizing.value = false
  }
}

// —— 零工邀请码（finance 角色无权限，静默忽略） ——
const invite = ref(null)

async function copyInviteCode() {
  try {
    await navigator.clipboard.writeText(invite.value.inviteCode)
    ElMessage.success('邀请码已复制，可分享给合作零工')
  } catch {
    ElMessage.warning('复制失败，请手动复制')
  }
}

onMounted(() => {
  profileStore.fetch().catch(() => {})
  getInviteCode()
    .then(data => {
      invite.value = data
    })
    .catch(() => {})
})
</script>

<style scoped>
.readonly-alert {
  margin-bottom: 16px;
  border-radius: 8px;
}

.contact-title {
  margin-top: 28px;
}

.contact-form {
  max-width: 480px;
}

/* —— 电子签授权引导卡 —— */
.esign-card {
  background: var(--brand-gradient);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.25);
  color: #fff;
  padding: 22px 28px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}

.esign-icon {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.esign-body {
  flex: 1;
  min-width: 260px;
}

.esign-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 6px;
}

.esign-desc {
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.85;
}

/* —— 邀请码 —— */
.invite-box {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.invite-code {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--brand);
  background: var(--bg-hover);
  border: 1px dashed var(--brand);
  border-radius: 8px;
  padding: 8px 18px;
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
}

.invite-meta {
  font-size: 13px;
  color: var(--text-2);
}

.invite-meta b {
  color: var(--brand);
}

.invite-tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
