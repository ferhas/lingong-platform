<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">修改密码</h2>
        <p class="page-sub">为保障账号安全,新密码须不少于 10 位且同时包含字母与数字</p>
      </div>
    </div>

    <div class="panel pwd-panel">
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        size="large"
        @keyup.enter="onSubmit"
      >
        <el-form-item label="原密码" prop="oldPassword">
          <el-input
            v-model="form.oldPassword"
            type="password"
            show-password
            placeholder="当前登录密码"
            :prefix-icon="Lock"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="form.newPassword"
            type="password"
            show-password
            placeholder="≥10位,须包含字母和数字"
            :prefix-icon="Key"
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            placeholder="再次输入新密码"
            :prefix-icon="Key"
          />
        </el-form-item>
        <el-button type="primary" class="submit-btn" :loading="submitting" @click="onSubmit">
          确认修改
        </el-button>
        <p class="pwd-tip">修改成功后将自动退出,请使用新密码重新登录</p>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Lock, Key } from '@element-plus/icons-vue'
import { changePassword } from '../api/admin'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref()
const submitting = ref(false)
const form = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

function validateStrength(_rule, value, callback) {
  if (value.length < 10) return callback(new Error('密码至少 10 位'))
  if (!/[A-Za-z]/.test(value)) return callback(new Error('密码须包含字母'))
  if (!/\d/.test(value)) return callback(new Error('密码须包含数字'))
  callback()
}

function validateConfirm(_rule, value, callback) {
  if (value !== form.newPassword) return callback(new Error('两次输入的新密码不一致'))
  callback()
}

const rules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { validator: validateStrength, trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    { validator: validateConfirm, trigger: 'blur' }
  ]
}

async function onSubmit() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await changePassword({
      oldPassword: form.oldPassword,
      newPassword: form.newPassword
    })
    ElMessage.success('密码修改成功,请使用新密码重新登录')
    await auth.logout()
    router.push('/login')
  } catch {
    /* 错误已统一提示 */
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.pwd-panel {
  max-width: 460px;
}

.submit-btn {
  width: 100%;
  margin-top: 4px;
}

.pwd-tip {
  margin: 14px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
</style>
