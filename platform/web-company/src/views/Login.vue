<template>
  <div class="login-page">
    <!-- 左侧品牌区 -->
    <div class="brand-panel">
      <div class="brand-inner">
        <div class="brand-logo">灵工云·企业端</div>
        <div class="brand-slogan">承揽后分包模式 · 一站式灵活用工合规平台</div>
        <ul class="brand-points">
          <li>
            <el-icon><CircleCheckFilled /></el-icon>
            <span>平台总承揽、再分包给实名零工，<TermTip term="四流" text="四流合一" />、链路可溯</span>
          </li>
          <li>
            <el-icon><CircleCheckFilled /></el-icon>
            <span>验收即自动开具 6% <TermTip term="数电票" text="数电专票" />，凭票即可税前扣除</span>
          </li>
          <li>
            <el-icon><CircleCheckFilled /></el-icon>
            <span>资金<TermTip term="存管户" text="银行存管" />、按单投保、电子签全程留痕</span>
          </li>
        </ul>
      </div>
    </div>

    <!-- 右侧表单区 -->
    <div class="form-panel">
      <div class="form-card">
        <h2 class="form-title">欢迎使用灵工云</h2>
        <p class="form-subtitle">企业控制台 · 仅限企业账号登录</p>

        <el-tabs v-model="activeTab" class="login-tabs">
          <el-tab-pane label="登录" name="login">
            <el-form ref="loginRef" :model="loginForm" :rules="loginRules" size="large" @keyup.enter="onLogin">
              <el-form-item prop="phone">
                <el-input v-model="loginForm.phone" placeholder="手机号" maxlength="11" :prefix-icon="Iphone" />
              </el-form-item>
              <el-form-item prop="password">
                <el-input v-model="loginForm.password" type="password" show-password placeholder="密码" :prefix-icon="Lock" />
              </el-form-item>
              <el-button type="primary" size="large" class="submit-btn" :loading="loading" @click="onLogin">
                登 录
              </el-button>
            </el-form>
          </el-tab-pane>

          <el-tab-pane label="注册" name="register">
            <el-form ref="registerRef" :model="registerForm" :rules="registerRules" size="large">
              <el-form-item prop="phone">
                <el-input v-model="registerForm.phone" placeholder="手机号" maxlength="11" :prefix-icon="Iphone" />
              </el-form-item>
              <el-form-item prop="password">
                <el-input v-model="registerForm.password" type="password" show-password placeholder="密码（至少 10 位，含字母和数字）" :prefix-icon="Lock" />
              </el-form-item>
              <el-form-item prop="name">
                <el-input v-model="registerForm.name" placeholder="联系人姓名" :prefix-icon="User" />
              </el-form-item>
              <el-form-item prop="companyName">
                <el-input v-model="registerForm.companyName" placeholder="企业名称" :prefix-icon="OfficeBuilding" />
              </el-form-item>
              <el-form-item prop="licenseNo">
                <el-input v-model="registerForm.licenseNo" placeholder="统一社会信用代码" :prefix-icon="Postcard" />
              </el-form-item>
              <el-form-item prop="industry">
                <el-select v-model="registerForm.industry" placeholder="所属行业" style="width: 100%">
                  <el-option v-for="item in industries" :key="item" :label="item" :value="item" />
                </el-select>
              </el-form-item>
              <div class="agree-row">
                <el-checkbox v-model="agreed" class="agree-check">我已阅读并同意</el-checkbox>
                <el-link type="primary" :underline="false" class="agree-link" @click="openLegal('tos')">《平台服务协议》</el-link>
                <span class="agree-and">和</span>
                <el-link type="primary" :underline="false" class="agree-link" @click="openLegal('privacy')">《隐私政策》</el-link>
              </div>
              <el-tooltip content="请先勾选同意《平台服务协议》和《隐私政策》" placement="top" :disabled="agreed">
                <span class="submit-wrap">
                  <el-button
                    type="primary"
                    size="large"
                    class="submit-btn"
                    :loading="loading"
                    :disabled="!agreed"
                    @click="onRegister"
                  >
                    注 册
                  </el-button>
                </span>
              </el-tooltip>
            </el-form>
          </el-tab-pane>
        </el-tabs>
      </div>
    </div>

    <!-- 协议全文（免登录查看） -->
    <el-dialog v-model="legalVisible" :title="legalTitle" width="640px" top="6vh">
      <div v-loading="legalLoading" class="legal-body">
        <pre v-if="legalDoc" class="legal-content">{{ legalDoc.content }}</pre>
      </div>
      <template #footer>
        <el-button type="primary" @click="legalVisible = false">我已阅读</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Iphone, Lock, User, OfficeBuilding, Postcard } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'
import { getLegalDoc } from '../api/me'
import TermTip from '../components/TermTip.vue'

const router = useRouter()
const auth = useAuthStore()

const activeTab = ref('login')
const loading = ref(false)
const loginRef = ref()
const registerRef = ref()

// —— 注册协议 ——
const agreed = ref(false)
const legalVisible = ref(false)
const legalLoading = ref(false)
const legalDoc = ref(null)
const legalCache = {}

const legalTitle = computed(() =>
  legalDoc.value ? `${legalDoc.value.title}（第 ${legalDoc.value.version} 版）` : '协议加载中…'
)

async function openLegal(type) {
  legalVisible.value = true
  if (legalCache[type]) {
    legalDoc.value = legalCache[type]
    return
  }
  legalDoc.value = null
  legalLoading.value = true
  try {
    const doc = await getLegalDoc(type)
    legalCache[type] = doc
    legalDoc.value = doc
  } catch {
    // 错误已由拦截器提示
    legalVisible.value = false
  } finally {
    legalLoading.value = false
  }
}

const industries = ['软件信息服务', '电商零售', '文化传媒', '教育培训', '建筑劳务分包', '其他']

const phoneRule = [
  { required: true, message: '请输入手机号', trigger: 'blur' },
  { pattern: /^1\d{10}$/, message: '手机号格式不正确', trigger: 'blur' }
]

const loginForm = reactive({ phone: '', password: '' })
const loginRules = {
  phone: phoneRule,
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

const registerForm = reactive({
  phone: '',
  password: '',
  name: '',
  companyName: '',
  licenseNo: '',
  industry: ''
})
const registerRules = {
  phone: phoneRule,
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 10, max: 64, message: '密码长度应为 10 至 64 位', trigger: 'blur' },
    { pattern: /^(?=.*[A-Za-z])(?=.*\d)/, message: '密码须同时包含字母和数字', trigger: 'blur' }
  ],
  name: [{ required: true, message: '请输入联系人姓名', trigger: 'blur' }],
  companyName: [
    { required: true, message: '请输入企业名称', trigger: 'blur' },
    { min: 4, max: 60, message: '企业名称长度应为 4 至 60 个字符', trigger: 'blur' }
  ],
  licenseNo: [
    { required: true, message: '请输入统一社会信用代码', trigger: 'blur' },
    { min: 8, max: 30, message: '统一社会信用代码长度应为 8 至 30 位', trigger: 'blur' }
  ],
  industry: [{ required: true, message: '请选择所属行业', trigger: 'change' }]
}

async function onLogin() {
  await loginRef.value.validate().catch(() => Promise.reject())
  loading.value = true
  try {
    await auth.login(loginForm.phone, loginForm.password)
    ElMessage.success('登录成功')
    router.push('/dashboard')
  } catch (err) {
    if (!err.response) {
      ElMessage.error(err.message || '登录失败')
    }
  } finally {
    loading.value = false
  }
}

async function onRegister() {
  if (!agreed.value) {
    ElMessage.warning('请先阅读并同意《平台服务协议》和《隐私政策》')
    return
  }
  await registerRef.value.validate().catch(() => Promise.reject())
  loading.value = true
  try {
    // agree: true —— 后端校验并对同意的协议版本留痕
    await auth.register({ ...registerForm, agree: true })
    ElMessage.success('已提交，等待平台准入审核')
    router.push('/dashboard')
  } catch {
    // 错误已由拦截器统一提示
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.brand-panel {
  flex: 1.1;
  background: linear-gradient(135deg, #4f46e5 0%, #7c6ff0 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
}

/* 深色主题：登录页另一套渐变背景 */
html.dark .brand-panel {
  background: linear-gradient(135deg, #1e1b4b 0%, #3b2f8f 55%, #4338ca 100%);
}

.brand-inner {
  max-width: 520px;
}

.brand-logo {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: 2px;
  margin-bottom: 16px;
}

.brand-slogan {
  font-size: 18px;
  opacity: 0.92;
  margin-bottom: 48px;
}

.brand-points {
  list-style: none;
  margin: 0;
  padding: 0;
}

.brand-points li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 15px;
  line-height: 1.7;
  margin-bottom: 20px;
  opacity: 0.95;
}

.brand-points .el-icon {
  margin-top: 4px;
  font-size: 18px;
}

.form-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
  overflow-y: auto;
  padding: 32px 24px;
}

html.dark .form-panel {
  background: linear-gradient(180deg, #0f1117 0%, #16142e 100%);
}

.form-card {
  width: 420px;
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-pop);
  padding: 36px 40px;
}

.form-title {
  margin: 0 0 4px;
  font-size: 24px;
  font-weight: 700;
  color: var(--text-1);
}

.form-subtitle {
  margin: 0 0 20px;
  color: var(--text-3);
  font-size: 13px;
}

.submit-btn {
  width: 100%;
  margin-top: 4px;
  font-weight: 600;
  letter-spacing: 4px;
}

.submit-wrap {
  display: block;
  width: 100%;
}

.agree-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-2);
}

.agree-check :deep(.el-checkbox__label) {
  font-size: 13px;
}

.agree-link {
  font-size: 13px;
  vertical-align: baseline;
}

.agree-and {
  margin: 0 2px;
  font-size: 13px;
}

.legal-body {
  min-height: 240px;
}

.legal-content {
  margin: 0;
  max-height: 56vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-2);
}

@media (max-width: 900px) {
  .brand-panel {
    display: none;
  }
}
</style>
