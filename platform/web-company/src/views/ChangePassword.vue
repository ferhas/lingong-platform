<template>
  <div>
    <PageHeader title="修改密码" subtitle="新密码须不少于 10 位，且同时包含字母与数字" />

    <div class="page-card pwd-card">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px" @keyup.enter="onSubmit">
        <el-form-item label="原密码" prop="oldPassword">
          <el-input v-model="form.oldPassword" type="password" show-password placeholder="请输入原密码" />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="form.newPassword" type="password" show-password placeholder="不少于 10 位，含字母和数字" />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input v-model="form.confirmPassword" type="password" show-password placeholder="再次输入新密码" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="onSubmit">确认修改</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import { changePassword } from '../api/me'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref()
const submitting = ref(false)
const form = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

function validateNewPassword(rule, value, callback) {
  if (!value) return callback(new Error('请输入新密码'))
  if (value.length < 10) return callback(new Error('密码至少 10 位'))
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return callback(new Error('密码须同时包含字母和数字'))
  }
  if (value === form.oldPassword) return callback(new Error('新密码不能与原密码相同'))
  callback()
}

function validateConfirm(rule, value, callback) {
  if (!value) return callback(new Error('请再次输入新密码'))
  if (value !== form.newPassword) return callback(new Error('两次输入的密码不一致'))
  callback()
}

const rules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [{ required: true, validator: validateNewPassword, trigger: 'blur' }],
  confirmPassword: [{ required: true, validator: validateConfirm, trigger: 'blur' }]
}

async function onSubmit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  submitting.value = true
  try {
    await changePassword(form.oldPassword, form.newPassword)
    ElMessage.success('密码修改成功，请使用新密码重新登录')
    await auth.logout()
    router.push('/login')
  } catch {
    // 错误已由拦截器提示
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.pwd-card {
  max-width: 560px;
}
</style>
