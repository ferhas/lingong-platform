<template>
  <div>
    <el-alert type="success" show-icon :closable="false" class="tip-alert">
      <template #title>验收即自动全额开具数电发票，凭票即可企业所得税税前扣除</template>
      <div class="tip-desc">
        任务验收通过后，平台按任务全额向贵司开具 6% 现代服务<TermTip term="数电票" text="数电专用发票" />，与框架合同、工单、结算确认单共同构成<TermTip term="四流" text="四流合一" />证据链。
      </div>
    </el-alert>

    <div class="page-card">
      <h3 class="page-title">发票中心</h3>
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="no" label="发票号" width="200" />
        <el-table-column prop="taskTitle" label="关联任务" min-width="180" show-overflow-tooltip />
        <el-table-column label="发票金额" width="130" align="right">
          <template #default="{ row }">
            <span class="money amount">¥{{ fmtMoney(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="税率" width="80" align="center">
          <template #default="{ row }">
            <el-tag type="primary" effect="light" size="small">{{ row.taxRate }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.status === 'voided'" placement="top">
              <template #content>
                <div>红字发票号：{{ row.redInvoiceNo || '—' }}</div>
                <div>红冲原因：{{ row.voidReason || '—' }}</div>
              </template>
              <el-tag type="danger" effect="light" size="small" class="void-tag">
                {{ statusMeta(row.status).label }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else :type="statusMeta(row.status).tag" effect="light" size="small">
              {{ statusMeta(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="item" label="开票项目" min-width="150" show-overflow-tooltip />
        <el-table-column label="开票日期" width="170">
          <template #default="{ row }">{{ fmtDateTime(row.issuedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" link @click="openDetail(row)">查看</el-button>
            <el-tooltip content="该发票已红冲作废" :disabled="row.status !== 'voided'" placement="top">
              <span class="print-wrap">
                <el-button type="primary" link :disabled="row.status === 'voided'" @click="printInvoice(row)">
                  打印
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无发票">
            <div class="empty-hint">任务验收通过后，平台将自动按任务全额开具 6% 数电专用发票并归档于此。</div>
          </el-empty>
        </template>
      </el-table>
    </div>

    <!-- 发票详情 -->
    <el-dialog v-model="detailVisible" title="发票详情" width="600px">
      <el-alert
        v-if="current?.status === 'voided'"
        type="error"
        show-icon
        :closable="false"
        class="void-alert"
      >
        <template #title>该发票已红冲作废，不可再作为入账抵扣凭证</template>
        <div class="void-detail">
          <span>红字发票号：<span class="mono">{{ current.redInvoiceNo || '—' }}</span></span>
          <span v-if="current.voidReason" class="void-reason">红冲原因：{{ current.voidReason }}</span>
        </div>
      </el-alert>
      <el-descriptions v-if="current" :column="1" border>
        <el-descriptions-item label="发票号码">{{ current.no }}</el-descriptions-item>
        <el-descriptions-item label="发票状态">
          <el-tag :type="statusMeta(current.status).tag" effect="light" size="small">
            {{ statusMeta(current.status).label }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="current.status === 'voided'" label="红字发票号">
          <span class="mono">{{ current.redInvoiceNo || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="current.status === 'voided'" label="红冲原因">
          {{ current.voidReason || '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="开票项目">{{ current.item }}</el-descriptions-item>
        <el-descriptions-item label="价税合计">
          <span class="money amount">¥{{ fmtMoney(current.amount) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="税率">{{ current.taxRate }}</el-descriptions-item>
        <el-descriptions-item label="购方抬头">{{ current.buyer?.title || '—' }}</el-descriptions-item>
        <el-descriptions-item label="购方税号">
          <span class="mono">{{ current.buyer?.taxNo || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="关联任务">{{ current.taskTitle }}</el-descriptions-item>
        <el-descriptions-item label="关联结算确认单">{{ current.confirmNo || '—' }}</el-descriptions-item>
        <el-descriptions-item label="开票日期">{{ fmtDateTime(current.issuedAt) }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-tooltip content="该发票已红冲作废" :disabled="current?.status !== 'voided'" placement="top">
          <span class="print-wrap">
            <el-button type="primary" :disabled="current?.status === 'voided'" @click="printInvoice(current)">
              <el-icon style="margin-right: 4px"><Printer /></el-icon>打印
            </el-button>
          </span>
        </el-tooltip>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { getInvoices } from '../api/company'
import { fmtMoney, fmtDateTime, INVOICE_STATUS } from '../utils/format'
import { printHtml, esc } from '../utils/print'
import TermTip from '../components/TermTip.vue'

const list = ref([])
const loading = ref(false)

const detailVisible = ref(false)
const current = ref(null)

const statusMeta = s => INVOICE_STATUS[s] || { label: s || '—', tag: 'info' }

function openDetail(row) {
  current.value = row
  detailVisible.value = true
}

function printInvoice(i) {
  if (!i || i.status === 'voided') return
  printHtml(`发票 ${i.no}`, `
    <h2>增值税数电专用发票</h2>
    <table>
      <tr><th>发票号码</th><td class="mono">${esc(i.no)}</td></tr>
      <tr><th>发票状态</th><td>${esc(statusMeta(i.status).label)}</td></tr>
      <tr><th>开票项目</th><td>${esc(i.item)}</td></tr>
      <tr><th>价税合计</th><td class="money">¥${fmtMoney(i.amount)}</td></tr>
      <tr><th>税率</th><td>${esc(i.taxRate)}</td></tr>
      <tr><th>购方抬头</th><td>${esc(i.buyer?.title)}</td></tr>
      <tr><th>购方税号</th><td class="mono">${esc(i.buyer?.taxNo)}</td></tr>
      <tr><th>关联任务</th><td>${esc(i.taskTitle)}</td></tr>
      <tr><th>关联结算确认单</th><td class="mono">${esc(i.confirmNo)}</td></tr>
      <tr><th>开票日期</th><td>${esc(fmtDateTime(i.issuedAt))}</td></tr>
    </table>
    <div class="footer">由灵工云平台开具 · 仅供演示</div>
  `)
}

onMounted(async () => {
  loading.value = true
  try {
    const data = await getInvoices()
    list.value = data.list
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.tip-alert {
  margin-bottom: 16px;
  border-radius: 12px;
}

.tip-desc {
  font-size: 12px;
  line-height: 1.7;
}

.amount {
  font-weight: 600;
  color: var(--text-1);
}

.empty-hint {
  max-width: 420px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}

/* tooltip 包裹后按钮失去默认 sibling 间距，由包裹层补回 */
.print-wrap {
  display: inline-block;
  margin-left: 12px;
}

.void-alert {
  margin-bottom: 14px;
  border-radius: 8px;
}

.void-detail {
  font-size: 12px;
  line-height: 1.7;
}

.void-reason {
  margin-left: 14px;
}

.void-tag {
  cursor: help;
}
</style>
