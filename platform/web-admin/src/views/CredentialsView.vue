<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">开放API凭据</h2>
        <p class="page-sub">
          大客户系统直连的 HMAC 签名凭据（仅开放任务创建/查询）
          <el-tag v-if="!canWrite" size="small" type="info" effect="plain" style="margin-left: 8px">只读</el-tag>
        </p>
      </div>
      <div class="page-actions">
        <el-button v-if="canWrite" type="primary" :icon="Plus" @click="openCreate">创建凭据</el-button>
        <el-button :icon="Refresh" circle @click="load" />
      </div>
    </div>

    <div class="panel">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" align="center" />
        <el-table-column prop="companyName" label="企业" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.companyName }}
            <span class="sub-id">#{{ row.companyId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="AppKey" min-width="220">
          <template #default="{ row }"><span class="mono">{{ row.appKey }}</span></template>
        </el-table-column>
        <el-table-column label="授权范围" min-width="180">
          <template #default="{ row }">
            <el-tag v-for="s in row.scopes" :key="s" size="small" effect="plain" class="scope-tag">
              {{ scopeText(s) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
              {{ row.status === 'active' ? '启用中' : '已停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column v-if="canWrite" label="操作" width="90" fixed="right" align="center">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'active'"
              type="danger"
              link
              size="small"
              @click="onDisable(row)"
            >
              停 用
            </el-button>
            <span v-else class="empty-dash">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无API凭据" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 创建凭据 -->
    <el-dialog v-model="createDialog.visible" title="创建API凭据" width="520px" destroy-on-close>
      <template v-if="!createDialog.result">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
          仅已通过准入的企业可创建。创建成功后 AppSecret 只展示一次，平台不留存明文。
        </el-alert>
        <el-form label-position="top">
          <el-form-item label="企业ID（须已通过准入审核）">
            <el-input-number
              v-model="createDialog.companyId"
              :min="1"
              :precision="0"
              controls-position="right"
              style="width: 200px"
            />
          </el-form-item>
          <el-form-item label="授权范围">
            <el-checkbox-group v-model="createDialog.scopes">
              <el-checkbox value="task:create">任务创建</el-checkbox>
              <el-checkbox value="task:read">任务查询</el-checkbox>
            </el-checkbox-group>
          </el-form-item>
        </el-form>
      </template>

      <!-- 一次性 secret 展示 -->
      <template v-else>
        <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 14px">
          <template #title>AppSecret 仅此一次展示，关闭后无法再次查看！</template>
          请立即复制并通过安全渠道交付给企业技术负责人，泄露须立即停用并重建。
        </el-alert>
        <div class="secret-box">
          <div class="secret-label">AppKey</div>
          <div class="secret-value mono">{{ createDialog.result.appKey }}</div>
          <div class="secret-label">AppSecret（仅展示一次）</div>
          <div class="secret-value mono secret-strong">{{ createDialog.result.appSecret }}</div>
        </div>
        <el-button type="primary" plain :icon="CopyDocument" style="margin-top: 12px" @click="copySecret">
          复制 AppKey / AppSecret
        </el-button>
      </template>

      <template #footer>
        <template v-if="!createDialog.result">
          <el-button @click="createDialog.visible = false">取 消</el-button>
          <el-button
            type="primary"
            :loading="createDialog.submitting"
            :disabled="!createDialog.companyId || createDialog.scopes.length === 0"
            @click="submitCreate"
          >
            创 建
          </el-button>
        </template>
        <el-button v-else type="primary" @click="closeResult">我已妥善保存，关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, CopyDocument } from '@element-plus/icons-vue'
import { getApiCredentials, createApiCredential, disableApiCredential } from '../api/admin'
import { withStepUp } from '../utils/stepup'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canWrite = computed(() => auth.can('config:write'))

const loading = ref(false)
const list = ref([])

function scopeText(s) {
  return { 'task:create': '任务创建', 'task:read': '任务查询' }[s] || s
}

async function load() {
  loading.value = true
  try {
    const data = await getApiCredentials()
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// —— 创建(step-up 二次验证 + 一次性 secret 展示) ——
const createDialog = reactive({
  visible: false,
  companyId: null,
  scopes: ['task:create', 'task:read'],
  submitting: false,
  result: null
})

function openCreate() {
  createDialog.companyId = null
  createDialog.scopes = ['task:create', 'task:read']
  createDialog.result = null
  createDialog.visible = true
}

async function submitCreate() {
  createDialog.submitting = true
  try {
    createDialog.result = await withStepUp(totp =>
      createApiCredential({ companyId: createDialog.companyId, scopes: createDialog.scopes }, totp)
    )
    load()
  } catch {
    /* 错误已统一提示/用户取消 */
  } finally {
    createDialog.submitting = false
  }
}

async function copySecret() {
  const r = createDialog.result
  try {
    await navigator.clipboard.writeText(`AppKey: ${r.appKey}\nAppSecret: ${r.appSecret}`)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

function closeResult() {
  createDialog.visible = false
  createDialog.result = null
}

async function onDisable(row) {
  try {
    await ElMessageBox.confirm(
      `停用后「${row.companyName}」使用该凭据（${row.appKey}）的所有 API 调用将立即失败。确定停用？`,
      '停用确认',
      { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await disableApiCredential(row.id)
    ElMessage.success('凭据已停用')
    load()
  } catch {
    /* 错误已统一提示 */
  }
}

onMounted(load)
</script>

<style scoped>
.sub-id {
  font-size: 12px;
  color: var(--text-3);
}

.scope-tag {
  margin-right: 6px;
}

.empty-dash {
  color: var(--text-3);
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
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  word-break: break-all;
  margin-bottom: 12px;
}

.secret-strong {
  color: var(--accent);
}
</style>
