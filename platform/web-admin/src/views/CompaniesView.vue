<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">企业入驻审核</h2>
        <p class="page-sub">行业负面清单自动评级，通过后自动签署《总承揽框架合同》并允许发布任务</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
    </div>

    <div class="panel">
      <el-tabs v-model="activeStatus" @tab-change="load">
        <el-tab-pane label="待审核" name="pending" />
        <el-tab-pane label="已入驻" name="approved" />
        <el-tab-pane label="未通过" name="rejected" />
        <el-tab-pane label="全部" name="all" />
      </el-tabs>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="companyName" label="企业名称" min-width="200" show-overflow-tooltip />
        <el-table-column prop="licenseNo" label="统一社会信用代码" min-width="190">
          <template #default="{ row }">
            <span class="mono">{{ row.licenseNo }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="industry" label="行业" min-width="120" />
        <el-table-column label="风险等级" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="riskTagType(row.riskLevel)" effect="dark" size="small">
              {{ row.riskLevel }}风险
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="riskNote" label="风险说明" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ row.riskNote || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="申请时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row.id)">详情</el-button>
            <template v-if="row.status === 'pending'">
              <template v-if="canReview">
                <el-button type="primary" link size="small" @click="openReview(row, true)">通过</el-button>
                <el-button type="danger" link size="small" @click="openReview(row, false)">拒绝</el-button>
              </template>
              <el-tooltip v-else content="需要「企业审核」权限" placement="top">
                <span>
                  <el-button type="primary" link size="small" disabled>审 核</el-button>
                </span>
              </el-tooltip>
            </template>
            <span v-else-if="row.masterContractNo" class="mono contract-no" :title="row.masterContractNo">
              {{ row.masterContractNo }}
            </span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无企业数据" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 审核对话框 -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.pass ? '入驻审核·通过' : '入驻审核·不通过'"
      width="480px"
      destroy-on-close
    >
      <el-alert
        v-if="dialog.company"
        :type="dialog.pass ? 'success' : 'error'"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #title>
          {{ dialog.company.companyName }}（{{ dialog.company.industry }}·{{ dialog.company.riskLevel }}风险）
        </template>
        {{
          dialog.pass
            ? '通过后平台将与该企业电子签署《总承揽框架合同》，企业即可发布任务。'
            : '不通过后该企业将无法发布任务，请填写原因。'
        }}
      </el-alert>
      <el-form label-position="top">
        <el-form-item :label="dialog.pass ? '审核意见（可选）' : '不通过原因（必填）'">
          <el-input
            v-model="dialog.note"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            :placeholder="dialog.pass ? '例如：资质齐全，行业合规，准予准入' : '例如：行业命中负面清单，存在虚开发票风险'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取 消</el-button>
        <el-button
          :type="dialog.pass ? 'primary' : 'danger'"
          :loading="dialog.submitting"
          @click="submitReview"
        >
          {{ dialog.pass ? '确认通过' : '确认拒绝' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 企业详情抽屉 -->
    <el-drawer v-model="drawer.visible" title="企业详情" size="620px" destroy-on-close>
      <div v-loading="drawer.loading" class="detail-body">
        <template v-if="drawer.data">
          <!-- 基本信息 -->
          <div class="detail-section">
            <div class="detail-section-title">基本信息</div>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="企业名称" :span="2">
                {{ drawer.data.company.companyName }}
              </el-descriptions-item>
              <el-descriptions-item label="统一社会信用代码" :span="2">
                <span class="mono">{{ drawer.data.company.licenseNo }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="行业">{{ drawer.data.company.industry }}</el-descriptions-item>
              <el-descriptions-item label="风险等级">
                <el-tag :type="riskTagType(drawer.data.company.riskLevel)" size="small" effect="dark">
                  {{ drawer.data.company.riskLevel }}风险
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="准入状态">
                <el-tag :type="statusTagType(drawer.data.company.status)" size="small">
                  {{ statusText(drawer.data.company.status) }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="总承揽合同号">
                <span class="mono">{{ drawer.data.company.masterContractNo || '—' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="联系电话">
                <span class="mono">{{ drawer.data.company.contactPhone || '—' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="联系邮箱">
                {{ drawer.data.company.contactEmail || '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="入驻时间" :span="2">
                {{ fmtTime(drawer.data.company.createdAt) }}
              </el-descriptions-item>
            </el-descriptions>
          </div>

          <!-- 账户 -->
          <div class="detail-section">
            <div class="detail-section-title">企业账户</div>
            <div v-if="drawer.data.account" class="acct-grid">
              <div class="acct-cell">
                <div class="acct-label">账户余额</div>
                <div class="acct-num">{{ fmtMoney(drawer.data.account.balance) }}</div>
              </div>
              <div class="acct-cell">
                <div class="acct-label">冻结金额（任务预算）</div>
                <div class="acct-num acct-frozen">{{ fmtMoney(drawer.data.account.frozen) }}</div>
              </div>
            </div>
            <el-empty v-else description="尚未开通企业账户" :image-size="60" />
          </div>

          <!-- 任务统计 -->
          <div class="detail-section">
            <div class="detail-section-title">任务统计</div>
            <el-table :data="drawer.data.taskStats" size="small" border>
              <el-table-column label="状态" width="120">
                <template #default="{ row }">
                  <el-tag :type="taskStatusTagType(row.status)" size="small" effect="plain">
                    {{ taskStatusText(row.status) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="count" label="数量" width="90" align="center" />
              <el-table-column label="金额" align="right">
                <template #default="{ row }">
                  <span class="money">{{ fmtMoney(row.amount) }}</span>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无任务" :image-size="50" />
              </template>
            </el-table>
          </div>

          <!-- 成员列表 -->
          <div class="detail-section">
            <div class="detail-section-title">成员列表</div>
            <el-table :data="drawer.data.members" size="small" border>
              <el-table-column prop="name" label="姓名" min-width="100" />
              <el-table-column label="手机号" min-width="130">
                <template #default="{ row }"><span class="mono">{{ row.phone }}</span></template>
              </el-table-column>
              <el-table-column label="角色" width="110" align="center">
                <template #default="{ row }">
                  <el-tag :type="memberRoleTagType(row.memberRole)" size="small" effect="plain">
                    {{ memberRoleText(row.memberRole) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="90" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
                    {{ row.status === 'active' ? '正常' : '停用' }}
                  </el-tag>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无成员" :image-size="50" />
              </template>
            </el-table>
          </div>

          <!-- 近10条流水 -->
          <div class="detail-section">
            <div class="detail-section-title">近10条资金流水</div>
            <el-table :data="drawer.data.recentFlows" size="small" border>
              <el-table-column label="类型" width="100">
                <template #default="{ row }">{{ flowTypeText(row.type) }}</template>
              </el-table-column>
              <el-table-column label="金额" width="120" align="right">
                <template #default="{ row }">
                  <span class="money">{{ fmtMoney(row.amount) }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="remark" label="摘要" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">{{ row.remark || '—' }}</template>
              </el-table-column>
              <el-table-column label="时间" width="140">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无流水" :image-size="50" />
              </template>
            </el-table>
          </div>

          <!-- 关联预警 -->
          <div class="detail-section">
            <div class="detail-section-title">关联风控预警</div>
            <el-empty
              v-if="drawer.data.alerts.length === 0"
              description="暂无关联预警"
              :image-size="50"
            />
            <div v-for="a in drawer.data.alerts" :key="a.id" class="mini-alert">
              <div class="mini-alert-head">
                <el-tag :type="alertLevelTagType(a.level)" size="small" effect="dark">{{ a.level }}风险</el-tag>
                <span class="mini-alert-type">{{ a.type }}</span>
                <el-tag :type="a.status === 'resolved' ? 'success' : 'danger'" size="small" effect="plain">
                  {{ a.status === 'resolved' ? '已处理' : '待处理' }}
                </el-tag>
              </div>
              <div class="mini-alert-detail">{{ a.detail }}</div>
              <div class="mini-alert-time">{{ fmtTime(a.createdAt) }}</div>
            </div>
          </div>

          <!-- 历史发薪名单（防止员工转零工） -->
          <div v-if="canRiskRead" class="detail-section">
            <div class="detail-section-title">历史发薪名单（防止员工转零工）</div>
            <div class="payroll-box">
              <div class="payroll-head">
                <span class="payroll-count">
                  已上传 <b>{{ payroll.total }}</b> 人
                </span>
                <el-tooltip
                  :content="canRiskResolve ? '' : '需要「处理风控预警」权限(risk:resolve)'"
                  :disabled="canRiskResolve"
                  placement="top"
                >
                  <span>
                    <el-button
                      type="primary"
                      size="small"
                      plain
                      :disabled="!canRiskResolve"
                      @click="openPayrollUpload"
                    >
                      上传名单
                    </el-button>
                  </span>
                </el-tooltip>
              </div>
              <div class="payroll-explain">
                用途说明:把这家企业以前发工资的员工名单存进来,用于防止企业把原员工转成零工避税。之后该企业录用的零工如果名字出现在名单里,系统会自动生成高风险预警。
              </div>
              <div v-if="payroll.list.length" class="payroll-names">
                <el-tooltip
                  v-for="(p, i) in payroll.list.slice(0, 30)"
                  :key="`${p.name}-${i}`"
                  :content="canRiskResolve ? '点击发起白名单豁免（存量人员合规迁移评估）' : ''"
                  :disabled="!canRiskResolve"
                  placement="top"
                >
                  <el-tag
                    size="small"
                    effect="plain"
                    :class="{ 'payroll-name-clickable': canRiskResolve }"
                    @click="canRiskResolve && openExempt(p.name)"
                  >
                    {{ p.name }}
                  </el-tag>
                </el-tooltip>
                <span v-if="payroll.total > 30" class="payroll-more">等共 {{ payroll.total }} 人</span>
              </div>
              <div v-if="canRiskResolve && payroll.list.length" class="payroll-exempt-tip">
                豁免说明:存量员工经合规迁移评估（已解除劳动关系、业务真实）后可加入白名单豁免,录用比对不再预警;点击姓名发起豁免。
              </div>
            </div>
          </div>
        </template>
      </div>

      <template #footer>
        <el-tooltip
          v-if="canExportEvidence"
          content="导出该企业业务真实性证明包（实名/交易/支付三流），供税务核查使用"
          placement="top"
        >
          <el-button
            type="primary"
            :icon="Download"
            :loading="drawer.exporting"
            :disabled="!drawer.data"
            @click="onExportEvidence"
          >
            导出证明包
          </el-button>
        </el-tooltip>
        <el-button @click="drawer.visible = false">关 闭</el-button>
      </template>
    </el-drawer>

    <!-- 发薪名单白名单豁免 -->
    <el-dialog v-model="exemptDialog.visible" title="发薪名单白名单豁免" width="480px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 14px">
        <template #title>豁免对象：{{ exemptDialog.name }}</template>
        豁免后该姓名在录用比对中不再触发「员转零」高风险预警，请确认已完成存量人员合规迁移评估（解除劳动关系证明、业务真实性核查）。
      </el-alert>
      <el-form label-position="top">
        <el-form-item label="豁免操作">
          <el-radio-group v-model="exemptDialog.exempt">
            <el-radio :value="true">加入白名单（豁免）</el-radio>
            <el-radio :value="false">移出白名单（恢复比对）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="评估结论（必填）">
          <el-input
            v-model="exemptDialog.note"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如：已核实该人员于2025年12月与企业解除劳动关系，现以个体工商户身份承揽设计业务，业务真实"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="exemptDialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="exemptDialog.submitting" @click="submitExempt">确认提交</el-button>
      </template>
    </el-dialog>

    <!-- 上传发薪名单 -->
    <el-dialog v-model="payrollDialog.visible" title="上传历史发薪名单" width="480px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
        一行填一个姓名(2-30 个字)。重复的名字会自动去重,上传后立即参与录用比对。
      </el-alert>
      <el-input
        v-model="payrollDialog.text"
        type="textarea"
        :rows="10"
        :placeholder="'例如:\n张三\n李四\n王五'"
      />
      <template #footer>
        <span class="payroll-dialog-count">已识别 {{ parsedPayrollNames.length }} 个姓名</span>
        <el-button @click="payrollDialog.visible = false">取 消</el-button>
        <el-button
          type="primary"
          :loading="payrollDialog.submitting"
          :disabled="parsedPayrollNames.length === 0"
          @click="submitPayroll"
        >
          确认上传
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Refresh } from '@element-plus/icons-vue'
import {
  getCompanies,
  getCompanyDetail,
  getCompanyEvidencePack,
  reviewCompany,
  getCompanyPayroll,
  uploadCompanyPayroll,
  exemptPayrollName
} from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'
import { saveJson } from '../utils/download'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const auth = useAuthStore()
const canReview = computed(() => auth.can('company:review'))
const canExportEvidence = computed(() => auth.can('archive:read'))
const canRiskRead = computed(() => auth.can('risk:read'))
const canRiskResolve = computed(() => auth.can('risk:resolve'))

const activeStatus = ref('pending')
const loading = ref(false)
const list = ref([])

const dialog = reactive({
  visible: false,
  pass: true,
  note: '',
  company: null,
  submitting: false
})

const drawer = reactive({
  visible: false,
  loading: false,
  exporting: false,
  data: null
})

const TASK_STATUS_TEXT = {
  recruiting: '报名中',
  working: '进行中',
  delivered: '待验收',
  settled: '已结算',
  cancelled: '已取消'
}

const FLOW_TYPE_TEXT = {
  recharge: '充值入金',
  freeze: '预算冻结',
  unfreeze: '预算解冻',
  settle_out: '结算出账',
  settle_in: '分包款入账',
  tax_in: '税费归集',
  revenue_in: '服务费入账',
  withdraw: '提现出账'
}

function riskTagType(level) {
  return level === '高' ? 'danger' : level === '中' ? 'warning' : 'success'
}

function statusTagType(status) {
  return status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : 'warning'
}

function statusText(status) {
  return { pending: '待审核', approved: '已入驻', rejected: '未通过' }[status] || status
}

function taskStatusText(status) {
  return TASK_STATUS_TEXT[status] || status
}

function taskStatusTagType(status) {
  return {
    recruiting: 'primary',
    working: 'warning',
    delivered: 'info',
    settled: 'success',
    cancelled: 'danger'
  }[status] || 'info'
}

function flowTypeText(type) {
  return FLOW_TYPE_TEXT[type] || type
}

function memberRoleText(role) {
  return { owner: '管理员', operator: '运营', finance: '财务' }[role] || role
}

function memberRoleTagType(role) {
  return { owner: 'danger', operator: 'primary', finance: 'warning' }[role] || 'info'
}

function alertLevelTagType(level) {
  return level === '高' ? 'danger' : level === '中' ? 'warning' : 'info'
}

async function load() {
  loading.value = true
  try {
    const data = await getCompanies(activeStatus.value)
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// —— 详情抽屉 ——
async function openDetail(id) {
  drawer.visible = true
  drawer.loading = true
  drawer.data = null
  payroll.total = 0
  payroll.list = []
  try {
    drawer.data = await getCompanyDetail(id)
    if (canRiskRead.value) loadPayroll(id)
  } catch {
    drawer.visible = false
  } finally {
    drawer.loading = false
  }
}

// —— 历史发薪名单（防止员工转零工） ——
const payroll = reactive({ total: 0, list: [] })
const payrollDialog = reactive({ visible: false, text: '', submitting: false })

const parsedPayrollNames = computed(() =>
  [...new Set(
    payrollDialog.text
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length >= 2 && s.length <= 30)
  )]
)

async function loadPayroll(companyId) {
  try {
    const data = await getCompanyPayroll(companyId)
    payroll.total = data.total
    payroll.list = data.list || []
  } catch {
    /* 错误已统一提示 */
  }
}

function openPayrollUpload() {
  payrollDialog.text = ''
  payrollDialog.visible = true
}

async function submitPayroll() {
  const names = parsedPayrollNames.value
  if (names.length === 0) {
    ElMessage.warning('请至少填写一个有效姓名(每行一个,2-30 个字)')
    return
  }
  payrollDialog.submitting = true
  try {
    const res = await uploadCompanyPayroll(drawer.data.company.id, names)
    payrollDialog.visible = false
    ElMessage.success(`上传成功:新增 ${res.added} 人,名单共 ${res.total} 人`)
    loadPayroll(drawer.data.company.id)
  } catch {
    /* 错误已统一提示 */
  } finally {
    payrollDialog.submitting = false
  }
}

// —— 发薪名单白名单豁免(防员转零的存量合规迁移) ——
const exemptDialog = reactive({
  visible: false,
  name: '',
  exempt: true,
  note: '',
  submitting: false
})

function openExempt(name) {
  exemptDialog.name = name
  exemptDialog.exempt = true
  exemptDialog.note = ''
  exemptDialog.visible = true
}

async function submitExempt() {
  if (exemptDialog.note.trim().length < 2) {
    ElMessage.warning('请填写迁移评估结论')
    return
  }
  exemptDialog.submitting = true
  try {
    await exemptPayrollName(drawer.data.company.id, {
      name: exemptDialog.name,
      exempt: exemptDialog.exempt,
      note: exemptDialog.note.trim()
    })
    exemptDialog.visible = false
    ElMessage.success(
      exemptDialog.exempt
        ? `「${exemptDialog.name}」已加入白名单豁免，录用比对不再预警`
        : `「${exemptDialog.name}」已移出白名单，恢复录用比对`
    )
  } catch {
    /* 错误已统一提示 */
  } finally {
    exemptDialog.submitting = false
  }
}

async function onExportEvidence() {
  drawer.exporting = true
  try {
    const pack = await getCompanyEvidencePack(drawer.data.company.id)
    saveJson(pack, `${drawer.data.company.companyName}-证明包.json`)
    ElMessage.success('证明包已导出')
  } catch {
    /* 错误已统一提示 */
  } finally {
    drawer.exporting = false
  }
}

function openReview(company, pass) {
  dialog.company = company
  dialog.pass = pass
  dialog.note = ''
  dialog.visible = true
}

async function submitReview() {
  if (!dialog.pass && !dialog.note.trim()) {
    ElMessage.warning('拒绝时必须填写理由')
    return
  }
  dialog.submitting = true
  try {
    const res = await reviewCompany(dialog.company.id, {
      pass: dialog.pass,
      note: dialog.note.trim()
    })
    dialog.visible = false
    if (dialog.pass) {
      await ElMessageBox.alert(
        `已与「${dialog.company.companyName}」电子签署《总承揽框架合同》，合同编号：${res.masterContractNo}`,
        '入驻审核通过',
        { confirmButtonText: '知道了', type: 'success' }
      ).catch(() => {})
    } else {
      ElMessage.success('已标记该企业入驻审核不通过')
    }
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    dialog.submitting = false
  }
}

onMounted(() => {
  load()
  // 风控预警等页面通过 ?focus=企业ID 跳转,自动打开详情抽屉
  const focus = Number(route.query.focus)
  if (focus) openDetail(focus)
})
</script>

<style scoped>
.contract-no {
  font-size: 12px;
  color: var(--accent);
}

.detail-body {
  min-height: 200px;
}

.detail-section {
  margin-bottom: 22px;
}

.detail-section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 10px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
}

.acct-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.acct-cell {
  background: var(--bg-hover);
  border-radius: 10px;
  padding: 12px 16px;
}

.acct-label {
  font-size: 12px;
  color: var(--text-3);
}

.acct-num {
  margin-top: 6px;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.acct-frozen {
  color: var(--warning);
}

.mini-alert {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.mini-alert-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini-alert-type {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.mini-alert-detail {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
}

.mini-alert-time {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}

/* —— 历史发薪名单 —— */
.payroll-box {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}

.payroll-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.payroll-count {
  font-size: 13px;
  color: var(--text-2);
}

.payroll-count b {
  color: var(--accent);
  font-size: 16px;
}

.payroll-explain {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.payroll-names {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.payroll-more {
  font-size: 12px;
  color: var(--text-3);
}

.payroll-name-clickable {
  cursor: pointer;
}

.payroll-name-clickable:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.payroll-exempt-tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.payroll-dialog-count {
  float: left;
  font-size: 12px;
  color: var(--text-3);
  line-height: 32px;
}
</style>
