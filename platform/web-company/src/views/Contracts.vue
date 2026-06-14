<template>
  <div>
    <PageHeader
      title="合同档案"
      subtitle="全部合同经电子签平台签署并留存哈希存证，可在线查看与打印"
    />

    <div class="page-card">
      <p class="page-desc desc">
        《<TermTip
          term="承揽价"
          text="总承揽框架合同"
          tip="企业与平台签署的总合同：企业把任务整体发包给平台承揽（承揽价 = 企业支付的任务总价）"
        />》于准入审核通过时签署，任务工单随任务发布生成，<TermTip
          term="分包价"
          text="分包工单"
          tip="平台与零工签署的工单：平台把任务再分包给零工（分包价 = 零工实际获得的税前报酬）"
        />于录用零工时签署。
      </p>
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="no" label="合同编号" width="220" />
        <el-table-column label="合同类型" width="170">
          <template #default="{ row }">
            <el-tag :type="typeTag(row.type)" effect="light">{{
              CONTRACT_TYPE[row.type] || row.type
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="taskTitle" label="关联任务" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.taskTitle || '—' }}</template>
        </el-table-column>
        <el-table-column label="签署时间" width="180">
          <template #default="{ row }">{{ fmtDateTime(row.signedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" link @click="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无合同档案">
            <div class="empty-hint">
              准入审核通过后将自动签署《总承揽框架合同》；之后每发布一个任务生成一份任务工单，每录用一名零工签署一份分包工单。
            </div>
          </el-empty>
        </template>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        class="pager"
        layout="prev, pager, next, total"
        :total="total"
        :current-page="page"
        :page-size="pageSize"
        @current-change="onPage"
      />
    </div>

    <!-- 合同正文 -->
    <el-dialog v-model="detailVisible" title="合同正文" width="760px" top="5vh">
      <div v-loading="detailLoading" class="detail-body">
        <template v-if="current">
          <!-- 顶部元信息：编号 / 双方 / 存证哈希 -->
          <el-descriptions :column="2" border size="small" class="meta-desc">
            <el-descriptions-item label="合同类型">
              <el-tag :type="typeTag(current.type)" effect="light" size="small">{{
                CONTRACT_TYPE[current.type] || current.type
              }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="合同编号">
              <span class="mono">{{ current.no }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="甲方">{{ current.partyA || '—' }}</el-descriptions-item>
            <el-descriptions-item label="乙方">{{ current.partyB || '—' }}</el-descriptions-item>
            <el-descriptions-item label="关联任务">{{
              current.taskTitle || '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="签署时间">{{
              fmtDateTime(current.signedAt)
            }}</el-descriptions-item>
            <el-descriptions-item label="电子签 ID">
              <span class="mono">{{ current.esignId || '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="存证哈希">
              <span class="mono">{{ current.contentHash || '—' }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <!-- 正文快照 -->
          <pre v-if="current.content" class="contract-content">{{ current.content }}</pre>
          <el-empty
            v-else
            description="该合同暂无正文快照（早期签署的合同仅保留要点与哈希存证）"
            :image-size="72"
          />
        </template>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!current" @click="onPrint">
          <el-icon style="margin-right: 4px"><Printer /></el-icon>打印
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import { getContracts, getContractDetail } from '../api/company'
import { fmtDateTime, CONTRACT_TYPE } from '../utils/format'
import { printHtml, esc } from '../utils/print'
import TermTip from '../components/TermTip.vue'

const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)

const detailVisible = ref(false)
const detailLoading = ref(false)
const current = ref(null)

// 合同类型仅作分类区分，红色留给危险/错误：总承揽=琥珀、任务工单=品牌、分包工单=绿、分包框架协议=中性
const typeTag = (t) =>
  ({ master: 'warning', frame_sub: 'info', work_order: 'primary', sub_order: 'success' })[t] ||
  'info'

async function openDetail(row) {
  detailVisible.value = true
  detailLoading.value = true
  current.value = null
  try {
    // v4：取合同正文快照（content）
    current.value = await getContractDetail(row.id)
  } catch {
    // 错误已由拦截器提示
    detailVisible.value = false
  } finally {
    detailLoading.value = false
  }
}

function onPrint() {
  const c = current.value
  if (!c) return
  const bodyHtml = c.content
    ? `<pre style="white-space: pre-wrap; word-break: break-all; font-family: inherit; font-size: 13px; line-height: 1.9; margin-top: 20px;">${esc(c.content)}</pre>`
    : `<p style="margin-top: 20px; font-size: 13px; color: #6b7280;">（该合同暂无正文快照，仅保留要点与哈希存证）</p>`
  printHtml(
    `合同 ${c.no}`,
    `
    <h2>${esc(CONTRACT_TYPE[c.type] || c.type)}</h2>
    <table>
      <tr><th>合同编号</th><td class="mono">${esc(c.no)}</td></tr>
      <tr><th>甲方</th><td>${esc(c.partyA)}</td></tr>
      <tr><th>乙方</th><td>${esc(c.partyB)}</td></tr>
      <tr><th>存证哈希</th><td class="mono">${esc(c.contentHash)}</td></tr>
      <tr><th>签署时间</th><td>${esc(fmtDateTime(c.signedAt))}</td></tr>
    </table>
    ${bodyHtml}
    <div class="footer">电子签存证 · 哈希可在存证平台核验 · 仅供演示</div>
  `,
  )
}

async function load() {
  loading.value = true
  try {
    const data = await getContracts(page.value, pageSize.value)
    list.value = data.list || []
    total.value = data.total || 0
  } finally {
    loading.value = false
  }
}
function onPage(p) {
  page.value = p
  load()
}
onMounted(load)
</script>

<style scoped>
.desc {
  margin: 0 0 16px;
}

.empty-hint {
  max-width: 460px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}

.pager {
  margin-top: 16px;
  justify-content: flex-end;
}

.detail-body {
  min-height: 200px;
}

.meta-desc {
  margin-bottom: 14px;
}

/* 合同正文：pre-wrap 等宽排版 */
.contract-content {
  margin: 0;
  max-height: 52vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-2);
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 18px;
}
</style>
