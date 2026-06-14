<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">审计日志</h2>
        <p class="page-sub">全平台关键操作留痕,可按动作类型筛选追溯</p>
      </div>
      <div class="page-actions">
        <el-select
          v-model="action"
          placeholder="按动作筛选(可手输)"
          clearable
          filterable
          allow-create
          default-first-option
          style="width: 220px"
          @change="onFilter"
        >
          <el-option
            v-for="a in actionOptions"
            :key="a"
            :label="`${ACTION_TEXT[a] || a}(${a})`"
            :value="a"
          />
        </el-select>
        <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
      </div>
    </div>

    <div class="panel">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="id" label="ID" width="80" align="center" />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作人" min-width="150">
          <template #default="{ row }">
            <span>{{ row.userName || `用户#${row.userId}` }}</span>
            <el-tag size="small" effect="plain" :type="roleTagType(row.userRole)" style="margin-left: 6px">
              {{ roleText(row.userRole) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="180">
          <template #default="{ row }">
            <el-tag size="small" :type="actionTagType(row.action)" effect="plain">
              {{ actionText(row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="320" show-overflow-tooltip>
          <template #default="{ row }">{{ row.detail || '—' }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无审计日志" :image-size="90" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="load"
          @size-change="onSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { getAuditLogs, getAuditActions } from '../api/admin'
import { fmtTime } from '../utils/format'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const action = ref('')
// 筛选下拉的动作清单从后端实时拉取（库中实际出现过的动作），与写死清单解耦
const actionOptions = ref([])

// 覆盖 logAction 全部 85 个动作的中文标签，避免审计列表出现英文原始码
const ACTION_TEXT = {
  login: '登录', logout: '登出', register: '注册', change_password: '修改密码',
  '2fa_enable': '绑定动态码', '2fa_disable': '解绑动态码',
  task_publish: '发布任务', task_batch_publish: '批量发单', task_accept: '验收任务', task_reject: '驳回交付',
  task_cancel: '取消任务', task_hire: '录用零工', task_dispatch: '定向派单', openapi_task_publish: '开放API发单',
  dispatch_accept: '接受派单', dispatch_reject: '拒绝派单', review_submit: '提交互评',
  review_company: '企业准入审核', skill_apply: '申请技能认证', skill_review: '技能认证审核',
  worker_verify: '零工实名', worker_verify_face: '零工人脸核身', worker_lock: '锁定零工接单',
  soletrader_register: '个体户登记', bank_card_bind: '绑定银行卡',
  recharge: '充值', recharge_order_create: '创建充值单', recharge_mock_pay: '模拟入金',
  withdraw_apply: '申请提现', settlement_retry: '重试结算', fund_switches: '资金应急开关',
  recon_diff_resolve: '处理对账差异', esign_authorize: '电子签授权', webhook_replay: '重放回调事件',
  tax_declare: '个税申报', tax_quarter_report: '季度报送', tax_receipt_fill: '回执号回填',
  platform_init_report: '平台初始化报送', input_invoice_verify: '进项发票认证', upload_input_invoice: '上传进项发票',
  invoice_void: '发票红冲', invoice_reissue: '发票红冲重开',
  dispute_create: '发起争议', dispute_accept: '接受争议方案', dispute_rule: '争议裁决',
  dispute_execute: '执行裁决', dispute_withdraw: '撤回争议', dispute_escalate: '争议线下升级',
  ticket_create: '创建工单', ticket_assign: '指派工单', ticket_resolve: '处理工单',
  claim_report: '申报理赔', claim_process: '处理理赔', callback_sample: '回访抽查', callback_resolve: '处理回访',
  risk_resolve: '处置风控预警', config_update: '修改业务参数', legal_update: '修改协议模板',
  message_template_update: '修改消息模板', help_create: '新建帮助文章', help_update: '编辑帮助文章',
  admin_user_create: '创建运营账号', admin_user_role: '调整运营角色',
  role_create: '新建角色', role_update: '修改角色', role_delete: '删除角色',
  user_disable: '停用账号', user_enable: '启用账号', user_reset_password: '重置密码',
  api_credential_create: '创建API凭据', api_credential_disable: '停用API凭据',
  pii_view: '查看完整个人信息', pii_decrypt: '解密个人信息',
  export_apply: '申请数据导出', export_review: '审批导出', export_download: '下载导出', evidence_pack_export: '导出证据包',
  member_create: '添加企业成员', member_role_change: '变更成员角色', member_disable: '停用企业成员',
  update_profile: '修改资料', update_company_profile: '修改企业资料',
  agreements_reagree: '重新同意协议', payroll_upload: '上传发薪名单', payroll_exempt: '发薪名单豁免'
}

// 危险/敏感动作高亮（PII/资金/解绑/删除/锁定 等）
const DANGER = ['pii_view', 'pii_decrypt', 'invoice_void', 'fund_switches', '2fa_disable', 'role_delete', 'user_disable', 'worker_lock', 'task_cancel', 'export_download']
const WARNING = ['config_update', 'admin_user_role', 'role_update', 'legal_update', 'message_template_update', 'dispute_rule', 'dispute_execute', 'export_review', 'invoice_reissue']
const SUCCESS = ['tax_declare', 'tax_quarter_report', 'review_company', 'skill_review', 'user_enable']

function actionText(a) {
  return ACTION_TEXT[a] || a
}

function actionTagType(a) {
  if (DANGER.includes(a)) return 'danger'
  if (WARNING.includes(a)) return 'warning'
  if (SUCCESS.includes(a)) return 'success'
  if (['login', 'logout', 'register'].includes(a)) return 'info'
  return 'primary'
}

function roleText(role) {
  return { admin: '运营', company: '企业', worker: '零工' }[role] || role || '—'
}

function roleTagType(role) {
  return { admin: 'primary', company: 'warning', worker: 'success' }[role] || 'info'
}

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (action.value) params.action = action.value
    const data = await getAuditLogs(params)
    list.value = data.list
    total.value = data.total
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

function onFilter() {
  page.value = 1
  load()
}

function onSizeChange() {
  page.value = 1
  load()
}

async function loadActions() {
  try {
    const data = await getAuditActions()
    actionOptions.value = data.actions || []
  } catch {
    // 拉取失败时下拉为空，仍可手动输入（allow-create）
  }
}

onMounted(() => {
  loadActions()
  load()
})
</script>
