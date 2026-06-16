<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">凭证归档</h2>
        <p class="page-sub">已结算任务的合同、业务、资金、发票凭证，全量哈希固化、区块链存证</p>
      </div>
      <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
    </div>

    <div v-loading="loading" class="archive-list">
      <el-empty
        v-if="!loading && list.length === 0"
        description="暂无已结算任务的归档记录"
        :image-size="100"
        class="panel"
      />

      <div v-for="item in list" :key="item.taskId" class="panel archive-card">
        <div class="archive-head">
          <div class="archive-title">
            <span class="task-name">{{ item.title }}</span>
            <el-tag size="small" type="success" effect="plain">已结算</el-tag>
          </div>
          <div class="archive-amount money">{{ fmtMoney(item.amount) }}</div>
        </div>
        <div class="archive-meta">
          <span>发单企业：{{ item.companyName }}</span>
          <span>接单零工：{{ item.workerName }}</span>
          <span>结算时间：{{ fmtTime(item.settledAt) }}</span>
          <span>任务编号：#{{ item.taskId }}</span>
        </div>

        <el-row :gutter="14" class="flow-grid">
          <el-col :xs="24" :sm="12" :md="6">
            <div class="flow-col flow-contract">
              <div class="flow-name">合同流</div>
              <div class="flow-body">
                <div v-for="no in item.flows.contract" :key="no" class="mono flow-line" :title="no">{{ no }}</div>
                <div v-if="!item.flows.contract?.length" class="flow-none">无</div>
              </div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="6">
            <div class="flow-col flow-business">
              <div class="flow-name">业务流</div>
              <div class="flow-body">
                <div class="flow-line" :title="item.flows.business?.deliverable">
                  交付物：{{ item.flows.business?.deliverable || '—' }}
                </div>
                <div class="mono flow-line" :title="item.flows.business?.confirmNo">
                  确认单：{{ item.flows.business?.confirmNo || '—' }}
                </div>
              </div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="6">
            <div class="flow-col flow-fund">
              <div class="flow-name">资金流</div>
              <div class="flow-body">
                <div class="flow-line">关联流水 {{ item.flows.fund?.length || 0 }} 笔</div>
                <div v-if="item.flows.fund?.length" class="mono flow-line">
                  ID：{{ item.flows.fund.join('、') }}
                </div>
              </div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="6">
            <div class="flow-col flow-invoice">
              <div class="flow-name">发票流</div>
              <div class="flow-body">
                <div class="mono flow-line" :title="item.flows.invoice?.no">
                  发票号：{{ item.flows.invoice?.no || '—' }}
                </div>
                <div class="mono flow-line" :title="item.flows.invoice?.taxVoucher">
                  完税凭证：{{ item.flows.invoice?.taxVoucher || '—' }}
                </div>
              </div>
            </div>
          </el-col>
        </el-row>

        <div class="archive-foot">
          <div class="hash-box">
            <span class="hash-label">证据哈希</span>
            <span class="mono hash-value" :title="item.evidenceHash">{{ item.evidenceHash }}</span>
          </div>
          <div class="foot-actions">
            <el-tag effect="dark" type="primary" size="small">区块链存证·保存10年</el-tag>
            <el-button size="small" :icon="Tickets" @click="openEvidence(item)">证据链时间轴</el-button>
            <el-button type="primary" plain size="small" :icon="Printer" @click="printVoucher(item)">
              打印凭证包
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="total > 0" class="pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[5, 10, 20]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="load"
        @size-change="onSizeChange"
      />
    </div>

    <!-- 单笔工单证据链时间轴（操作留痕 + 终端证据 + 防篡改）-->
    <el-drawer v-model="evidenceDrawer" :title="`证据链时间轴 · ${evidence?.task?.title || ''}`" size="600px" destroy-on-close>
      <div v-loading="evidenceLoading">
        <template v-if="evidence">
          <div class="ev-flags">
            <el-tag :type="evidence.completeness.contract ? 'success' : 'info'" size="small" effect="plain">合同流 {{ evidence.completeness.contract ? '✓' : '—' }}</el-tag>
            <el-tag :type="evidence.completeness.business ? 'success' : 'info'" size="small" effect="plain">业务流 {{ evidence.completeness.business ? '✓' : '—' }}</el-tag>
            <el-tag :type="evidence.completeness.fund ? 'success' : 'info'" size="small" effect="plain">资金流 {{ evidence.completeness.fund ? '✓' : '—' }}</el-tag>
            <el-tag :type="evidence.completeness.invoice ? 'success' : 'info'" size="small" effect="plain">票据流 {{ evidence.completeness.invoice ? '✓' : '—' }}</el-tag>
            <el-tag :type="evidence.chain?.ok ? 'success' : 'danger'" size="small" effect="dark">{{ evidence.chain?.ok ? '审计链完好' : '审计链异常' }}</el-tag>
          </div>

          <el-timeline v-if="evidence.timeline.length" class="ev-timeline">
            <el-timeline-item
              v-for="e in evidence.timeline"
              :key="e.id"
              :timestamp="fmtTime(e.at)"
              placement="top"
              :type="STAGE_TYPE[e.stage] || 'primary'"
            >
              <div class="ev-node">
                <el-tag size="small" :type="STAGE_TYPE[e.stage] || 'primary'" effect="light">{{ e.stage }}</el-tag>
                <span class="ev-label">{{ e.label }}</span>
              </div>
              <div class="ev-meta">
                <span>操作人：{{ e.actor.name }}<template v-if="e.actor.role">（{{ ROLE_CN[e.actor.role] || e.actor.role }}）</template></span>
                <span v-if="e.ip" class="mono">IP {{ e.ip }}</span>
                <a v-if="e.geo" class="ev-geo" :href="geoMapUrl(e.geo)" target="_blank" rel="noopener" title="点击在高德地图查看操作现场">📍 现场 {{ fmtGeo(e.geo) }}</a>
              </div>
              <div v-if="e.userAgent" class="ev-ua" :title="e.userAgent">设备：{{ e.userAgent }}</div>
              <div class="ev-hashline mono" :title="e.hash">存证 {{ shortHash(e.hash) }}</div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="该工单暂无操作留痕" :image-size="80" />
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Printer, Tickets } from '@element-plus/icons-vue'
import { getArchives, getTaskEvidence } from '../api/admin'
import { fmtMoney, fmtTime } from '../utils/format'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)

// 证据链时间轴抽屉
const evidenceDrawer = ref(false)
const evidence = ref(null)
const evidenceLoading = ref(false)
const STAGE_TYPE = { 派单: 'warning', 抢单: 'primary', 单据管理: 'info', 单据验收: 'success', 其他: 'info' }
const ROLE_CN = { company: '企业', worker: '零工', admin: '平台' }
const shortHash = h => (h ? String(h).replace('sha256:', '').slice(0, 12) + '…' : '—')
const fmtGeo = g => { if (!g) return ''; const [a, b] = String(g).split(','); return a && b ? `${a.trim()}, ${b.trim()}` : g }
const geoMapUrl = g => { if (!g) return ''; const [lat, lng] = String(g).split(',').map(s => s.trim()); return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent('操作现场')}&coordinate=gaode` }

async function openEvidence(item) {
  evidenceDrawer.value = true
  evidence.value = null
  evidenceLoading.value = true
  try {
    evidence.value = await getTaskEvidence(item.taskId)
  } catch {
    evidence.value = null
  } finally {
    evidenceLoading.value = false
  }
}

async function load() {
  loading.value = true
  try {
    const data = await getArchives({ page: page.value, pageSize: pageSize.value })
    list.value = data.list
    total.value = data.total
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

function onSizeChange() {
  page.value = 1
  load()
}

function esc(v) {
  return String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 打印凭证包:新窗口写入四流编号 + 证据哈希的凭证 HTML 并调起打印 */
function printVoucher(item) {
  const win = window.open('', '_blank', 'width=860,height=900')
  if (!win) {
    ElMessage.warning('请允许浏览器弹出窗口后重试')
    return
  }
  const contracts = (item.flows.contract || []).map(no => `<li class="mono">${esc(no)}</li>`).join('') || '<li>—</li>'
  const fundIds = item.flows.fund?.length ? item.flows.fund.join('、') : '—'
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>四流合一凭证包·任务#${esc(item.taskId)}</title>
<style>
  body { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #111827; margin: 40px; }
  h1 { font-size: 22px; text-align: center; margin-bottom: 4px; }
  .sub { text-align: center; color: #6b7280; font-size: 13px; margin-bottom: 28px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 32px; font-size: 13px; margin-bottom: 24px; }
  .meta b { font-weight: 600; }
  .amount { font-size: 18px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #d1d5db; padding: 10px 12px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; width: 110px; }
  ul { margin: 0; padding-left: 18px; }
  li { line-height: 1.9; }
  .mono { font-family: Consolas, 'Courier New', monospace; }
  .hash { margin-top: 24px; padding: 14px; border: 1px dashed #9ca3af; border-radius: 8px;
          font-size: 12px; word-break: break-all; }
  .hash b { display: block; margin-bottom: 6px; font-size: 13px; }
  .foot { margin-top: 28px; display: flex; justify-content: space-between; color: #6b7280; font-size: 12px; }
  @media print { body { margin: 16px; } }
</style>
</head>
<body>
  <h1>灵活用工平台·四流合一结算凭证包</h1>
  <div class="sub">区块链存证 · 全量哈希固化 · 保存10年</div>
  <div class="meta">
    <span><b>任务编号:</b>#${esc(item.taskId)}</span>
    <span><b>任务名称:</b>${esc(item.title)}</span>
    <span><b>发单企业:</b>${esc(item.companyName)}</span>
    <span><b>接单零工:</b>${esc(item.workerName)}</span>
    <span><b>结算时间:</b>${esc(fmtTime(item.settledAt))}</span>
    <span class="amount"><b>结算金额:</b>${esc(fmtMoney(item.amount))}</span>
  </div>
  <table>
    <tr><th>① 合同流</th><td><ul>${contracts}</ul></td></tr>
    <tr><th>② 业务流</th><td>交付物:${esc(item.flows.business?.deliverable)}<br>
      验收确认单:<span class="mono">${esc(item.flows.business?.confirmNo)}</span></td></tr>
    <tr><th>③ 资金流</th><td>关联资金流水 ${item.flows.fund?.length || 0} 笔(流水ID:<span class="mono">${esc(fundIds)}</span>)</td></tr>
    <tr><th>④ 发票流</th><td>发票号:<span class="mono">${esc(item.flows.invoice?.no)}</span><br>
      完税凭证:<span class="mono">${esc(item.flows.invoice?.taxVoucher)}</span></td></tr>
  </table>
  <div class="hash"><b>证据链哈希(SHA-256)</b><span class="mono">${esc(item.evidenceHash)}</span></div>
  <div class="foot">
    <span>打印时间:${esc(fmtTime(new Date().toISOString()))}</span>
    <span>灵活用工平台运营端 · 仅供合规审查使用</span>
  </div>
  ${'<'}script>window.onload = function () { window.print() }${'<'}/script>
</body>
</html>`
  win.document.write(html)
  win.document.close()
}

onMounted(load)
</script>

<style scoped>
.archive-list {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.archive-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.archive-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.task-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
}

.archive-amount {
  font-size: 20px;
  font-weight: 800;
  color: var(--accent);
}

.archive-meta {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-3);
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.flow-grid {
  margin-top: 16px;
}

.flow-col {
  border-radius: 10px;
  padding: 14px;
  height: 100%;
  border: 1px solid var(--border);
  border-top-width: 3px;
  background: var(--bg-hover);
}

.flow-contract {
  border-top-color: var(--accent);
}

.flow-business {
  border-top-color: var(--success);
}

.flow-fund {
  border-top-color: var(--warning);
}

.flow-invoice {
  border-top-color: var(--danger);
}

.flow-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 8px;
}

.flow-body {
  font-size: 12px;
  color: var(--text-2);
}

.flow-line {
  line-height: 1.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-none {
  color: var(--text-3);
}

.archive-foot {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.foot-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.hash-box {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.hash-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-3);
}

.hash-value {
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-hover);
  border-radius: 6px;
  padding: 4px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 992px) {
  .flow-col {
    margin-bottom: 12px;
  }
}

/* —— 证据链时间轴抽屉 —— */
.ev-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.ev-timeline {
  padding-left: 4px;
}
.ev-node {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ev-label {
  font-weight: 600;
  color: var(--text-1);
}
.ev-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.ev-geo {
  color: var(--success, #67c23a);
  text-decoration: none;
}
.ev-geo:hover {
  text-decoration: underline;
}
.ev-ua {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.ev-hashline {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
}
</style>
