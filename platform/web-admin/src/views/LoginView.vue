<template>
  <div class="login-page">
    <div class="bg-glow glow-a"></div>
    <div class="bg-glow glow-b"></div>

    <div class="login-card">
      <div class="brand-area">
        <div class="brand-badge">灵</div>
        <h1 class="brand-title">灵活用工平台</h1>
        <p class="brand-subtitle">平台运营端·合规用工管理控制台</p>
        <ul class="brand-points">
          <li>企业入驻审核·风控预警处置</li>
          <li>代扣代办税务·季度涉税报送</li>
          <li>四流合一凭证·区块链存证</li>
        </ul>
      </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        class="login-form"
        size="large"
        @keyup.enter="onSubmit"
      >
        <h2 class="form-title">运营管理员登录</h2>
        <el-form-item prop="phone">
          <el-input
            v-model="form.phone"
            placeholder="管理员手机号"
            maxlength="11"
            :prefix-icon="Iphone"
            clearable
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="登录密码"
            :prefix-icon="Lock"
            show-password
          />
        </el-form-item>
        <el-button
          type="primary"
          class="submit-btn"
          :loading="loading"
          @click="onSubmit"
        >
          登 录
        </el-button>
        <p class="form-tip">仅限平台运营管理员使用，操作将被审计留痕</p>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Iphone, Lock } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const formRef = ref()
const loading = ref(false)
const form = reactive({ phone: '', password: '' })

const rules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1\d{10}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

async function onSubmit() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await auth.login(form.phone, form.password)
    ElMessage.success('登录成功，欢迎回来')
    router.push(route.query.redirect || '/dashboard')
  } catch (err) {
    if (err?.code === 'NOT_ADMIN') {
      ElMessage.error('请使用运营管理员账号登录')
    } else if (err?.code === 'NEED_TOTP') {
      // 已绑定 2FA 的账号:密码通过后输入动态码完成二段验证
      await onTotpLogin(err.tmpToken)
    }
    // 其余错误已由 axios 拦截器统一提示
  } finally {
    loading.value = false
  }
}

async function onTotpLogin(tmpToken) {
  let code
  try {
    const { value } = await ElMessageBox.prompt(
      '该账号已开启动态码保护，请输入认证器 App 中的 6 位动态码完成登录。',
      '二次验证',
      {
        confirmButtonText: '验证并登录',
        cancelButtonText: '取消',
        inputPattern: /^\s*\d{6}\s*$/,
        inputErrorMessage: '请输入 6 位数字动态码',
        inputPlaceholder: '6 位动态码'
      }
    )
    code = value.trim()
  } catch {
    // 取消二次验证：给出明确反馈，避免用户停在登录页不知所措（手机号/密码仍保留，可直接重试）
    ElMessage.info('已取消二次验证，如需登录请重新点击「登录」')
    return
  }
  try {
    await auth.loginTotp(tmpToken, code)
    ElMessage.success('登录成功，欢迎回来')
    router.push(route.query.redirect || '/dashboard')
  } catch (err) {
    if (err?.code === 'NOT_ADMIN') {
      ElMessage.error('请使用运营管理员账号登录')
    }
    // 动态码错误/过期已由 axios 拦截器统一提示
  }
}
</script>

<style scoped>
.login-page {
  height: 100%;
  background: linear-gradient(135deg, #eef2ff 0%, #e0f2fe 50%, #f5f3ff 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  transition: background 0.25s;
}

html.dark .login-page {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
}

.bg-glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(120px);
  opacity: 0.25;
  pointer-events: none;
}

html.dark .bg-glow {
  opacity: 0.35;
}

.glow-a {
  width: 480px;
  height: 480px;
  background: #6366f1;
  top: -120px;
  left: -100px;
}

.glow-b {
  width: 420px;
  height: 420px;
  background: #0ea5e9;
  bottom: -140px;
  right: -80px;
}

.login-card {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 860px;
  max-width: calc(100vw - 48px);
  border-radius: 18px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(99, 102, 241, 0.16);
  box-shadow: 0 24px 64px rgba(79, 70, 229, 0.18);
}

html.dark .login-card {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
}

/* 左侧品牌区:两主题均为深色品牌底,保证白字可读 */
.brand-area {
  padding: 48px 40px;
  color: #e5e7eb;
  background: linear-gradient(160deg, #312e81, #0f172a);
  display: flex;
  flex-direction: column;
  justify-content: center;
}

html.dark .brand-area {
  background: linear-gradient(160deg, rgba(99, 102, 241, 0.25), rgba(15, 23, 42, 0.15));
}

.brand-badge {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.5);
  margin-bottom: 22px;
}

.brand-title {
  margin: 0;
  font-size: 26px;
  font-weight: 800;
  color: #f9fafb;
  letter-spacing: 1px;
}

.brand-subtitle {
  margin: 10px 0 26px;
  font-size: 14px;
  color: #94a3b8;
}

.brand-points {
  margin: 0;
  padding: 0;
  list-style: none;
}

.brand-points li {
  font-size: 13px;
  color: #cbd5e1;
  padding: 7px 0;
  display: flex;
  align-items: center;
}

.brand-points li::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6366f1;
  margin-right: 10px;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.8);
}

.login-form {
  background: var(--bg-card);
  padding: 48px 40px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.form-title {
  margin: 0 0 28px;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
}

.submit-btn {
  width: 100%;
  margin-top: 8px;
  height: 44px;
  font-size: 15px;
  letter-spacing: 6px;
}

.form-tip {
  margin: 18px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

@media (max-width: 760px) {
  .login-card {
    grid-template-columns: 1fr;
  }

  .brand-area {
    display: none;
  }
}
</style>
