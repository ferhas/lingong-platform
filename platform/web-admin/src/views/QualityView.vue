<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">回访与理赔</h2>
        <p class="page-sub">电话回访已结算任务核实真实性,防止企业虚构交易;协助零工处理保险报案</p>
      </div>
      <el-button :icon="Refresh" circle @click="reload" />
    </div>

    <div class="panel">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="抽查回访" name="callbacks" />
        <el-tab-pane label="保险理赔" name="claims" />
      </el-tabs>

      <!-- ===== 抽查回访 ===== -->
      <template v-if="activeTab === 'callbacks'">
        <div class="toolbar">
          <div class="toolbar-left">
            <el-tooltip
              :content="canResolve
                ? '按配置的抽查比例,从近30天已结算且未回访过的任务里随机抽取一批,生成待回访名单'
                : '需要「处理风控预警」权限(risk:resolve)'"
              placement="top"
            >
              <span>
                <el-button
                  type="primary"
                  :icon="Phone"
                  :disabled="!canResolve"
                  :loading="sampling"
                  @click="onSample"
                >
                  抽取本期回访名单
                </el-button>
              </span>
            </el-tooltip>
          </div>
          <el-radio-group v-model="cbStatus" @change="loadCallbacks">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="pending">待回访</el-radio-button>
            <el-radio-button value="confirmed">已确认真实</el-radio-button>
            <el-radio-button value="abnormal">回访异常</el-radio-button>
          </el-radio-group>
        </div>

        <el-table :data="callbacks" v-loading="cbLoading" stripe>
          <el-table-column label="任务" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span>{{ row.taskTitle }}</span>
              <span class="mono sub-id">#{{ row.taskId }}</span>
            </template>
          </el-table-column>
          <el-table-column label="零工" min-width="170">
            <template #default="{ row }">
              <div>{{ row.workerName }}</div>
              <div class="mono sub-id">{{ row.workerPhone }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="companyName" label="发单企业" min-width="180" show-overflow-tooltip />
          <el-table-column label="状态" width="120" align="center">
            <template #default="{ row }">
              <el-tag :type="CB_STATUS[row.status]?.tag || 'info'" size="small">
                {{ CB_STATUS[row.status]?.text || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="note" label="回访备注" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ row.note || '—' }}</template>
          </el-table-column>
          <el-table-column label="抽取时间" width="150">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending' && canResolve"
                type="primary"
                link
                size="small"
                @click="openCbResolve(row)"
              >
                记录回访结果
              </el-button>
              <el-tooltip
                v-else-if="row.status === 'pending'"
                content="需要「处理风控预警」权限"
                placement="top"
              >
                <span>
                  <el-button type="primary" link size="small" disabled>记录回访结果</el-button>
                </span>
              </el-tooltip>
              <span v-else class="done-time">{{ fmtTime(row.doneAt) }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="90">
              <template #description>
                <p>暂无回访记录</p>
                <p class="empty-guide">
                  {{ canResolve ? '点击上方「抽取本期回访名单」,系统会自动从近期已结算任务里抽出需要电话核实的名单' : '请联系有风控处置权限的同事抽取本期名单' }}
                </p>
              </template>
            </el-empty>
          </template>
        </el-table>
      </template>

      <!-- ===== 保险理赔 ===== -->
      <template v-else>
        <el-table :data="claims" v-loading="claimsLoading" stripe>
          <el-table-column label="任务" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.taskTitle }}</template>
          </el-table-column>
          <el-table-column prop="workerName" label="报案零工" min-width="110" />
          <el-table-column label="保单号" min-width="170">
            <template #default="{ row }">
              <span class="mono">{{ row.policyNo }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="事故描述" min-width="220" show-overflow-tooltip />
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="CLAIM_STATUS[row.status]?.tag || 'info'" size="small">
                {{ CLAIM_STATUS[row.status]?.text || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="result" label="处理结果" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ row.result || '—' }}</template>
          </el-table-column>
          <el-table-column label="报案时间" width="150">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status !== 'closed' && canResolve"
                type="primary"
                link
                size="small"
                @click="openClaim(row)"
              >
                处 理
              </el-button>
              <el-tooltip
                v-else-if="row.status !== 'closed'"
                content="需要「处理风控预警」权限"
                placement="top"
              >
                <span>
                  <el-button type="primary" link size="small" disabled>处 理</el-button>
                </span>
              </el-tooltip>
              <span v-else class="done-time">已办结</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="90">
              <template #description>
                <p>暂无理赔报案</p>
                <p class="empty-guide">零工在小程序端对有保单的任务「一键报案」后,会出现在这里,由运营协助保险公司跟进</p>
              </template>
            </el-empty>
          </template>
        </el-table>
      </template>
    </div>

    <!-- 记录回访结果 -->
    <el-dialog v-model="cbDialog.visible" title="记录回访结果" width="500px" destroy-on-close>
      <el-descriptions v-if="cbDialog.row" :column="1" border size="small" style="margin-bottom: 14px">
        <el-descriptions-item label="任务">{{ cbDialog.row.taskTitle }}(#{{ cbDialog.row.taskId }})</el-descriptions-item>
        <el-descriptions-item label="回访对象">
          {{ cbDialog.row.workerName }} <span class="mono">{{ cbDialog.row.workerPhone }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="发单企业">{{ cbDialog.row.companyName }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-position="top">
        <el-form-item label="回访结论">
          <el-radio-group v-model="cbDialog.confirmed">
            <el-radio :value="true">确认真实(零工本人确认提供过服务)</el-radio>
            <el-radio :value="false">异常(否认接单 / 联系不上 / 描述对不上)</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-alert
          v-if="cbDialog.confirmed === false"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 14px"
        >
          提交后系统将自动生成一条「回访异常」高风险预警,指向涉事企业,提示业务可能虚构,请在风控预警页跟进处置。
        </el-alert>
        <el-form-item label="回访备注">
          <el-input
            v-model="cbDialog.note"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如:零工本人电话确认 6 月 3 日完成配送任务,金额一致 / 零工表示从未接过该任务"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cbDialog.visible = false">取 消</el-button>
        <el-button
          :type="cbDialog.confirmed === false ? 'danger' : 'primary'"
          :loading="cbDialog.submitting"
          @click="submitCbResolve"
        >
          提交回访结果
        </el-button>
      </template>
    </el-dialog>

    <!-- 处理理赔 -->
    <el-dialog v-model="claimDialog.visible" title="处理理赔" width="500px" destroy-on-close>
      <el-descriptions v-if="claimDialog.row" :column="1" border size="small" style="margin-bottom: 14px">
        <el-descriptions-item label="保单号">
          <span class="mono">{{ claimDialog.row.policyNo }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="报案零工">{{ claimDialog.row.workerName }}</el-descriptions-item>
        <el-descriptions-item label="事故描述">{{ claimDialog.row.description }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-position="top">
        <el-form-item label="处理动作">
          <el-radio-group v-model="claimDialog.status">
            <el-radio value="processing">受理中(已转交保险公司,持续跟进)</el-radio>
            <el-radio value="closed">办结(理赔流程已结束)</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="结果说明(将通知零工本人)">
          <el-input
            v-model="claimDialog.result"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如:保险公司已受理,理赔专员将在3个工作日内联系 / 已赔付 ¥2,000,款项由保险公司直接打款"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="claimDialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="claimDialog.submitting" @click="submitClaim">确认提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Phone } from '@element-plus/icons-vue'
import { sampleCallbacks, getCallbacks, resolveCallback, getClaims, processClaim } from '../api/admin'
import { fmtTime } from '../utils/format'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const canResolve = computed(() => auth.can('risk:resolve'))

const activeTab = ref('callbacks')

const CB_STATUS = {
  pending: { text: '待回访', tag: 'warning' },
  confirmed: { text: '已确认真实', tag: 'success' },
  abnormal: { text: '回访异常', tag: 'danger' }
}

const CLAIM_STATUS = {
  reported: { text: '已报案', tag: 'warning' },
  processing: { text: '受理中', tag: 'primary' },
  closed: { text: '已办结', tag: 'success' }
}

// —— 抽查回访 ——
const cbStatus = ref('pending')
const cbLoading = ref(false)
const callbacks = ref([])
const sampling = ref(false)

const cbDialog = reactive({ visible: false, row: null, confirmed: true, note: '', submitting: false })

async function loadCallbacks() {
  cbLoading.value = true
  try {
    const data = await getCallbacks(cbStatus.value)
    callbacks.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    cbLoading.value = false
  }
}

async function onSample() {
  sampling.value = true
  try {
    const res = await sampleCallbacks()
    if (res.sampled > 0) {
      ElMessage.success(`本期已抽中 ${res.sampled} 笔(候选 ${res.candidates} 笔),请逐一电话回访`)
      cbStatus.value = 'pending'
    } else {
      ElMessage.info('近30天没有新的已结算任务可抽取(已抽过的不会重复抽)')
    }
    loadCallbacks()
  } catch {
    /* 错误已统一提示 */
  } finally {
    sampling.value = false
  }
}

function openCbResolve(row) {
  cbDialog.row = row
  cbDialog.confirmed = true
  cbDialog.note = ''
  cbDialog.visible = true
}

async function submitCbResolve() {
  cbDialog.submitting = true
  try {
    await resolveCallback(cbDialog.row.id, {
      confirmed: cbDialog.confirmed,
      note: cbDialog.note.trim()
    })
    cbDialog.visible = false
    if (cbDialog.confirmed) {
      ElMessage.success('已记录:回访确认真实')
    } else {
      ElMessage.warning('已记录回访异常,系统已生成高风险预警,请到「风控预警」页跟进')
    }
    loadCallbacks()
  } catch {
    /* 错误已统一提示 */
  } finally {
    cbDialog.submitting = false
  }
}

// —— 保险理赔 ——
const claimsLoading = ref(false)
const claims = ref([])
const claimDialog = reactive({ visible: false, row: null, status: 'processing', result: '', submitting: false })

async function loadClaims() {
  claimsLoading.value = true
  try {
    const data = await getClaims()
    claims.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    claimsLoading.value = false
  }
}

function openClaim(row) {
  claimDialog.row = row
  claimDialog.status = row.status === 'processing' ? 'closed' : 'processing'
  claimDialog.result = ''
  claimDialog.visible = true
}

async function submitClaim() {
  if (claimDialog.status === 'closed' && !claimDialog.result.trim()) {
    ElMessage.warning('办结时请填写结果说明,零工会收到该通知')
    return
  }
  claimDialog.submitting = true
  try {
    await processClaim(claimDialog.row.id, {
      status: claimDialog.status,
      result: claimDialog.result.trim()
    })
    claimDialog.visible = false
    ElMessage.success(claimDialog.status === 'closed' ? '理赔已办结,零工已收到通知' : '已标记受理中,零工已收到通知')
    loadClaims()
  } catch {
    /* 错误已统一提示 */
  } finally {
    claimDialog.submitting = false
  }
}

function reload() {
  if (activeTab.value === 'callbacks') loadCallbacks()
  else loadClaims()
}

watch(activeTab, tab => {
  if (tab === 'claims' && claims.value.length === 0) loadClaims()
})

onMounted(loadCallbacks)
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.sub-id {
  margin-left: 6px;
  font-size: 12px;
  color: var(--text-3);
}

.done-time {
  font-size: 12px;
  color: var(--text-3);
}

.empty-guide {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
  max-width: 420px;
}
</style>
