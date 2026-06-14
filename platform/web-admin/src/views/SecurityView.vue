<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">账号安全</h2>
        <p class="page-sub">绑定动态码（2FA）后，裁决执行、导出审批、资金开关等敏感操作须二次验证</p>
      </div>
    </div>

    <div class="panel sec-panel">
      <div class="sec-head">
        <div>
          <div class="sec-title">动态码二次验证（TOTP）</div>
          <div class="sec-desc">
            使用任意认证器 App（如 Google Authenticator、Microsoft Authenticator）绑定后，每 30 秒生成一个 6 位动态码。
            已绑定的账号在执行敏感操作时必须输入动态码，可有效防止账号被盗后的资金类误操作。
          </div>
        </div>
        <el-tag :type="enabled ? 'success' : 'info'" effect="dark">
          {{ enabled ? '已绑定' : '未绑定' }}
        </el-tag>
      </div>

      <!-- 未绑定:绑定流程 -->
      <template v-if="!enabled">
        <el-steps :active="setupStep" align-center class="sec-steps">
          <el-step title="获取密钥" />
          <el-step title="录入认证器" />
          <el-step title="输码启用" />
        </el-steps>

        <div v-if="setupStep === 0" class="sec-action">
          <el-button type="primary" :loading="settingUp" @click="onSetup">开始绑定，获取密钥</el-button>
        </div>

        <template v-else>
          <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 14px">
            请打开认证器 App，选择「手动输入密钥」，把下方密钥录入（基于时间，30 秒刷新）。密钥仅展示一次，请勿截图外传。
          </el-alert>
          <div class="secret-box">
            <div class="secret-label">密钥（Secret）</div>
            <div class="secret-value mono">{{ setup.secret }}</div>
            <div class="secret-label">或在支持的 App 中粘贴完整链接（otpauth URL）</div>
            <div class="secret-url mono">{{ setup.otpauthUrl }}</div>
          </div>

          <el-form label-position="top" class="code-form">
            <el-form-item label="输入认证器 App 当前显示的 6 位动态码完成启用">
              <div class="code-row">
                <el-input
                  v-model="enableCode"
                  maxlength="6"
                  placeholder="6 位动态码"
                  class="code-input mono"
                  @keyup.enter="onEnable"
                />
                <el-button type="primary" :loading="enabling" :disabled="!/^\d{6}$/.test(enableCode)" @click="onEnable">
                  验证并启用
                </el-button>
              </div>
            </el-form-item>
          </el-form>
        </template>
      </template>

      <!-- 已绑定:解绑入口 -->
      <template v-else>
        <el-alert type="success" :closable="false" show-icon style="margin: 14px 0">
          动态码已生效。执行争议裁决/执行、导出审批、结算重推、资金应急开关、API 凭据创建、发票重开等敏感操作时，系统会要求输入动态码。
        </el-alert>
        <el-form label-position="top" class="code-form">
          <el-form-item label="如需更换设备或解除绑定，请输入当前 6 位动态码">
            <div class="code-row">
              <el-input
                v-model="disableCode"
                maxlength="6"
                placeholder="6 位动态码"
                class="code-input mono"
                @keyup.enter="onDisable"
              />
              <el-button type="danger" plain :loading="disabling" :disabled="!/^\d{6}$/.test(disableCode)" @click="onDisable">
                解除绑定
              </el-button>
            </div>
          </el-form-item>
        </el-form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { setup2fa, enable2fa, disable2fa } from '../api/admin'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
// 绑定状态来自 /auth/me 的 totpEnabled；先用本地缓存初始化，再刷新真实状态
const enabled = ref(!!auth.user?.totpEnabled)

onMounted(async () => {
  try {
    const me = await auth.fetchProfile()
    enabled.value = !!me?.totpEnabled
  } catch {
    /* 刷新失败则保留本地状态；setup 的 409 仍可兜底纠正 */
  }
})

const setupStep = ref(0)
const settingUp = ref(false)
const setup = reactive({ secret: '', otpauthUrl: '' })
const enableCode = ref('')
const enabling = ref(false)
const disableCode = ref('')
const disabling = ref(false)

async function onSetup() {
  settingUp.value = true
  try {
    const res = await setup2fa()
    setup.secret = res.secret
    setup.otpauthUrl = res.otpauthUrl
    setupStep.value = 1
  } catch (err) {
    if (err?.response?.status === 409) {
      enabled.value = true
      ElMessage.info('当前账号已绑定动态码，如需更换请先解绑')
    } else {
      ElMessage.error(err?.response?.data?.error?.message || '获取密钥失败，请稍后重试')
    }
  } finally {
    settingUp.value = false
  }
}

async function onEnable() {
  if (!/^\d{6}$/.test(enableCode.value)) return
  enabling.value = true
  try {
    await enable2fa(enableCode.value)
    enabled.value = true
    setupStep.value = 0
    enableCode.value = ''
    ElMessage.success('动态码已启用，后续敏感操作将要求二次验证')
  } catch {
    /* 错误已统一提示 */
  } finally {
    enabling.value = false
  }
}

async function onDisable() {
  if (!/^\d{6}$/.test(disableCode.value)) return
  try {
    await ElMessageBox.confirm(
      '解绑后敏感操作不再要求动态码，账号安全等级将降低。确定解除绑定？',
      '解绑确认',
      { type: 'warning', confirmButtonText: '确认解绑', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  disabling.value = true
  try {
    await disable2fa(disableCode.value)
    enabled.value = false
    disableCode.value = ''
    ElMessage.success('已解除动态码绑定')
  } catch (err) {
    if (err?.response?.status === 409) {
      enabled.value = false
    }
    /* 其余错误已统一提示 */
  } finally {
    disabling.value = false
  }
}
</script>

<style scoped>
.sec-panel {
  max-width: 760px;
}

.sec-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.sec-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.sec-desc {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.7;
}

.sec-steps {
  margin: 22px 0;
}

.sec-action {
  text-align: center;
  padding: 10px 0 6px;
}

.secret-box {
  border: 1px dashed var(--accent);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--accent-weak);
}

.secret-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 4px;
}

.secret-value {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 3px;
  color: var(--accent);
  margin-bottom: 12px;
  word-break: break-all;
}

.secret-url {
  font-size: 12px;
  color: var(--text-2);
  word-break: break-all;
  line-height: 1.6;
}

.code-form {
  margin-top: 16px;
}

.code-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.code-input {
  width: 180px;
}

.code-input :deep(input) {
  letter-spacing: 4px;
  font-size: 16px;
}
</style>
