<template>
  <div class="page-card">
    <PageHeader title="任务管理" subtitle="报名中可录用或取消，待验收任务支持行内验收/驳回">
      <template #actions>
        <el-input
          v-model="keyword"
          placeholder="搜索任务标题"
          clearable
          style="width: 240px"
          :prefix-icon="Search"
          @keyup.enter="onSearch"
          @clear="onSearch"
        />
        <el-button type="primary" @click="onSearch">搜索</el-button>
      </template>
    </PageHeader>

    <el-tabs v-model="activeStatus" @tab-change="onTabChange">
      <el-tab-pane label="全部" name="all" />
      <el-tab-pane label="报名中" name="recruiting" />
      <el-tab-pane label="进行中" name="working" />
      <el-tab-pane label="待验收" name="delivered" />
      <el-tab-pane label="已结算" name="settled" />
      <el-tab-pane label="已取消" name="cancelled" />
    </el-tabs>

    <el-table v-loading="loading" :data="list" stripe>
      <el-table-column prop="id" label="ID" width="64" />
      <el-table-column prop="title" label="任务标题" min-width="180" show-overflow-tooltip />
      <el-table-column prop="category" label="类目" width="80" />
      <el-table-column prop="payMethod" label="计酬方式" width="90" />
      <el-table-column label="预算金额" width="120" align="right">
        <template #default="{ row }">
          <span class="money">¥{{ fmtMoney(row.price) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <StatusTag :status="row.status" />
        </template>
      </el-table-column>
      <el-table-column prop="workerName" label="承接零工" width="100">
        <template #default="{ row }">{{ row.workerName || '—' }}</template>
      </el-table-column>
      <el-table-column prop="deadline" label="截止日期" width="110" />
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'recruiting'">
            <el-button type="primary" link @click="openDetail(row.id)">报名（{{ row.applicants ?? 0 }}）</el-button>
            <el-button v-if="auth.canManageTasks" type="primary" link @click="openDispatch(row)">派单</el-button>
            <el-button v-if="auth.canManageTasks" type="danger" link @click="onCancel(row)">取消任务</el-button>
          </template>
          <template v-else-if="row.status === 'delivered'">
            <el-button v-if="auth.canManageTasks" type="success" link :loading="acceptingId === row.id" @click="onAccept(row.id)">验收</el-button>
            <el-button v-if="auth.canManageTasks" type="danger" link @click="openReject(row.id)">驳回</el-button>
            <el-button type="primary" link @click="openDetail(row.id)">详情</el-button>
          </template>
          <template v-else-if="row.status === 'working'">
            <el-button v-if="auth.canManageTasks" type="warning" link @click="openDispute(row)">发起争议</el-button>
            <el-button type="primary" link @click="openDetail(row.id)">详情</el-button>
          </template>
          <template v-else-if="row.status === 'settled'">
            <el-button v-if="auth.canManageTasks" type="success" link @click="openReview(row)">评价</el-button>
            <el-button v-if="auth.canManageTasks" type="warning" link @click="openDispute(row)">发起争议</el-button>
            <el-button type="primary" link @click="openDetail(row.id)">详情</el-button>
          </template>
          <template v-else>
            <el-button type="primary" link @click="openDetail(row.id)">详情</el-button>
          </template>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty v-if="filtered" description="没有符合当前筛选条件的任务，换个状态或关键词试试" />
        <el-empty v-else description="还没有任务">
          <el-button type="primary" @click="router.push('/publish')">去发布第一个任务</el-button>
        </el-empty>
      </template>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="fetchList"
        @size-change="onSizeChange"
      />
    </div>

    <!-- 任务详情抽屉 -->
    <el-drawer v-model="drawerVisible" :title="detail?.title || '任务详情'" size="560px" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border class="detail-desc">
            <el-descriptions-item label="任务状态" :span="2">
              <StatusTag :status="detail.status" />
            </el-descriptions-item>
            <el-descriptions-item label="类目">{{ detail.category }}</el-descriptions-item>
            <el-descriptions-item label="计酬方式">{{ detail.payMethod }}</el-descriptions-item>
            <el-descriptions-item label="预算金额">
              <span class="money">¥{{ fmtMoney(detail.price) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="截止日期">{{ detail.deadline }}</el-descriptions-item>
            <el-descriptions-item label="任务工单号" :span="2">{{ detail.taskOrderNo || '—' }}</el-descriptions-item>
            <el-descriptions-item label="分包工单号" :span="2">{{ detail.subOrderNo || '—' }}</el-descriptions-item>
            <el-descriptions-item label="保单号" :span="2">{{ detail.policyNo || '—' }}</el-descriptions-item>
            <el-descriptions-item label="承接零工" :span="2">{{ detail.workerName || '—' }}</el-descriptions-item>
            <el-descriptions-item v-if="detail.confirmNo" label="结算确认单号" :span="2">{{ detail.confirmNo }}</el-descriptions-item>
            <el-descriptions-item label="任务描述" :span="2">
              <div class="pre-wrap">{{ detail.description }}</div>
            </el-descriptions-item>
            <el-descriptions-item label="交付标准" :span="2">
              <div class="pre-wrap">{{ detail.standard || '—' }}</div>
            </el-descriptions-item>
            <el-descriptions-item label="发布时间" :span="2">{{ fmtDateTime(detail.createdAt) }}</el-descriptions-item>
          </el-descriptions>

          <!-- 派单记录 -->
          <template v-if="detail.dispatches?.length">
            <div class="section-title">派单记录（{{ detail.dispatches.length }}）</div>
            <el-table :data="detail.dispatches" size="small" border>
              <el-table-column prop="workerName" label="零工" min-width="90" />
              <el-table-column label="状态" width="90" align="center">
                <template #default="{ row }">
                  <el-tag :type="DISPATCH_TAG[row.status]" size="small" effect="light">{{ DISPATCH_STATUS[row.status] }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="note" label="留言" min-width="120" show-overflow-tooltip>
                <template #default="{ row }">{{ row.note || '—' }}</template>
              </el-table-column>
              <el-table-column label="派单时间" min-width="140">
                <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
              </el-table-column>
            </el-table>
          </template>

          <div v-if="detail.status === 'recruiting' && auth.canManageTasks" class="action-bar">
            <el-button type="primary" plain @click="openDispatch(detail)">向零工派单</el-button>
          </div>

          <!-- 报名列表 -->
          <div class="section-title">报名列表（{{ detail.applications?.length || 0 }}）</div>
          <el-table v-if="detail.applications?.length" :data="detail.applications" size="small" border>
            <el-table-column prop="workerName" label="姓名" min-width="90" />
            <el-table-column label="实名认证" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.verified ? 'success' : 'info'" size="small" effect="light">
                  {{ row.verified ? '已实名' : '未实名' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="主体类型" width="100" align="center">
              <template #default="{ row }">{{ SUBJECT_TYPE[row.subjectType] || row.subjectType || '—' }}</template>
            </el-table-column>
            <el-table-column label="信用" width="110" align="center">
              <template #default="{ row }">
                <el-tooltip v-if="row.credit" placement="top">
                  <template #content>
                    <div>信用分：{{ row.credit.creditScore }}（{{ row.credit.grade }} 级）</div>
                    <div>累计结算：{{ row.credit.settledCount }} 单</div>
                    <div>企业评分：{{ row.credit.avgScore ?? '暂无' }}</div>
                    <div v-if="row.credit.verifiedSkills?.length">
                      认证技能：{{ row.credit.verifiedSkills.map(s => s.skill).join('、') }}
                    </div>
                  </template>
                  <el-tag :type="creditTag(row.credit.grade)" size="small" effect="light" class="credit-tag">
                    {{ row.credit.grade }} · {{ row.credit.creditScore }}
                  </el-tag>
                </el-tooltip>
                <span v-else>—</span>
              </template>
            </el-table-column>
            <el-table-column label="报名时间" min-width="140">
              <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column v-if="detail.status === 'recruiting' && auth.canManageTasks" label="操作" width="80" align="center">
              <template #default="{ row }">
                <el-button type="primary" link size="small" :loading="hiringId === row.workerId" @click="onHire(row)">
                  录用
                </el-button>
              </template>
            </el-table-column>
            <el-table-column v-else label="结果" width="80" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'hired'" type="success" size="small">已录用</el-tag>
                <el-tag v-else-if="row.status === 'rejected'" type="info" size="small">未录用</el-tag>
                <span v-else>—</span>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无零工报名" :image-size="72" />

          <!-- 交付物与验收 -->
          <template v-if="detail.status === 'delivered' || (detail.status === 'settled' && (detail.deliverableData || detail.deliverable))">
            <div class="section-title">交付物</div>
            <!-- 结构化交付：按工种模板逐项展示 -->
            <el-alert
              v-if="detail.deliverableData"
              :type="detail.status === 'settled' ? 'success' : 'info'"
              :closable="false"
              class="deliverable-box"
            >
              <el-descriptions :column="1" size="small" border class="deliver-fields">
                <el-descriptions-item v-for="fd in detail.deliverableData.fields" :key="fd.key" :label="fd.label">
                  {{ fd.value }}
                </el-descriptions-item>
              </el-descriptions>
              <div v-for="g in structuredUploadGroups" :key="g.label" class="deliver-group">
                <div class="deliver-group-label">{{ g.label }}（{{ g.files.length }}）</div>
                <div class="attach-list">
                  <div v-for="f in g.files" :key="f.id" class="attach-item">
                    <el-icon class="attach-icon"><Document /></el-icon>
                    <div class="attach-meta">
                      <div class="attach-name">{{ f.name }}</div>
                      <div class="attach-size">{{ fmtSize(f.size) }}</div>
                    </div>
                    <el-button type="primary" link size="small" :loading="downloadingId === f.id" @click="onDownload(f)">下载</el-button>
                  </div>
                </div>
              </div>
              <div class="deliver-time">{{ detail.status === 'settled' ? '结算时间：' + fmtDateTime(detail.settledAt) : '交付时间：' + fmtDateTime(detail.deliveredAt) }}</div>
            </el-alert>
            <!-- 旧版自由说明 -->
            <el-alert
              v-else
              :type="detail.status === 'settled' ? 'success' : 'info'"
              :closable="false"
              class="deliverable-box"
            >
              <div class="pre-wrap">{{ detail.deliverable || '（零工未填写交付说明）' }}</div>
              <div class="deliver-time">{{ detail.status === 'settled' ? '结算时间：' + fmtDateTime(detail.settledAt) : '交付时间：' + fmtDateTime(detail.deliveredAt) }}</div>
            </el-alert>
            <!-- B线发票流硬校验前置提示 -->
            <el-alert
              v-if="invoiceMissing"
              type="error"
              show-icon
              :closable="false"
              class="invoice-alert"
              title="该零工为个体工商户，尚未上传进项发票，验收将被阻断"
            />
          </template>

          <!-- 交付附件（鉴权下载）：结构化分组外的附件（如进项发票、旧版附件） -->
          <template v-if="extraAttachments.length">
            <div class="section-title">{{ detail.deliverableData ? '其他附件' : '交付附件' }}（{{ extraAttachments.length }}）</div>
            <div class="attach-list">
              <div v-for="f in extraAttachments" :key="f.id" class="attach-item">
                <el-icon class="attach-icon"><Document /></el-icon>
                <div class="attach-meta">
                  <div class="attach-name">{{ f.name }}</div>
                  <div class="attach-size">{{ fmtSize(f.size) }}<template v-if="f.kind === 'invoice'"> · 进项发票</template></div>
                </div>
                <el-button type="primary" link size="small" :loading="downloadingId === f.id" @click="onDownload(f)">
                  下载
                </el-button>
              </div>
            </div>
          </template>

          <div v-if="detail.status === 'delivered' && auth.canManageTasks" class="action-bar">
            <el-button type="primary" :loading="acceptingId === detail.id" @click="onAccept(detail.id)">验收通过</el-button>
            <el-button type="danger" plain @click="openReject(detail.id)">驳回</el-button>
          </div>

          <!-- 证据链：派单/抢单/单据管理/单据验收 全环节操作留痕 + 四流凭证 + 防篡改结论 -->
          <el-collapse v-model="evidencePanel" class="evidence-collapse" @change="loadEvidence">
            <el-collapse-item name="ev">
              <template #title>
                <el-icon class="ev-title-icon"><Document /></el-icon>
                <span class="ev-title">证据链（操作留痕 · 四流凭证 · 防篡改）</span>
              </template>
              <div v-loading="evidenceLoading">
                <template v-if="evidence">
                  <el-alert type="info" :closable="false" class="ev-intro" show-icon>
                    本工单从派单、抢单、签约到交付验收的全流程操作均已留痕，并固化合同/业务/资金/票据四流凭证，
                    支持防篡改校验，可用于争议举证与税务核查。
                  </el-alert>
                  <div class="ev-flags">
                    <el-tag :type="evidence.completeness.contract ? 'success' : 'info'" size="small" effect="plain">合同流 {{ evidence.completeness.contract ? '✓' : '—' }}</el-tag>
                    <el-tag :type="evidence.completeness.business ? 'success' : 'info'" size="small" effect="plain">业务流 {{ evidence.completeness.business ? '✓' : '—' }}</el-tag>
                    <el-tag :type="evidence.completeness.fund ? 'success' : 'info'" size="small" effect="plain">资金流 {{ evidence.completeness.fund ? '✓' : '—' }}</el-tag>
                    <el-tag :type="evidence.completeness.invoice ? 'success' : 'info'" size="small" effect="plain">票据流 {{ evidence.completeness.invoice ? '✓' : '—' }}</el-tag>
                    <el-tooltip :content="evidence.chain?.ok ? '审计记录以哈希链固化，未检测到任何篡改' : '检测到审计记录被改动，请联系平台核查'" placement="top">
                      <el-tag :type="evidence.chain?.ok ? 'success' : 'danger'" size="small" effect="dark">{{ evidence.chain?.ok ? '🛡 审计链完好' : '⚠ 审计链异常' }}</el-tag>
                    </el-tooltip>
                    <el-button class="ev-print-btn" size="small" :icon="Printer" @click="printEvidence">打印 / 导出</el-button>
                  </div>

                  <div class="section-title">操作留痕时间轴（{{ evidence.timeline.length }}）</div>
                  <el-timeline v-if="evidence.timeline.length" class="ev-timeline">
                    <el-timeline-item
                      v-for="e in evidence.timeline"
                      :key="e.id"
                      :timestamp="fmtDateTime(e.at)"
                      placement="top"
                      :type="STAGE_TYPE[e.stage] || 'primary'"
                    >
                      <div class="ev-node">
                        <el-tag size="small" :type="STAGE_TYPE[e.stage] || 'primary'" effect="light">{{ e.stage }}</el-tag>
                        <span class="ev-label">{{ e.label }}</span>
                      </div>
                      <div class="ev-meta">
                        <span>操作人：{{ e.actor.name }}<template v-if="e.actor.role">（{{ ROLE_CN[e.actor.role] || e.actor.role }}）</template></span>
                        <el-tooltip v-if="e.ip" content="操作发起方 IP（为保护隐私已脱敏）" placement="top">
                          <span class="ev-ip">IP {{ e.ip }}</span>
                        </el-tooltip>
                        <a v-if="e.geo" class="ev-geo" :href="geoMapUrl(e.geo)" target="_blank" rel="noopener" title="点击在高德地图查看操作现场">📍 现场 {{ fmtGeo(e.geo) }}</a>
                      </div>
                    </el-timeline-item>
                  </el-timeline>
                  <el-empty v-else description="暂无操作留痕" :image-size="56" />

                  <div class="section-title">合同流凭证（电子签 + 内容哈希）</div>
                  <el-descriptions :column="1" size="small" border>
                    <el-descriptions-item v-for="c in evidence.contract" :key="c.no" :label="c.label">
                      <span class="ev-no">{{ c.no }}</span>
                      <el-tooltip v-if="c.contentHash" :content="c.contentHash" placement="top">
                        <span class="ev-hash">· 内容哈希 {{ shortHash(c.contentHash) }}</span>
                      </el-tooltip>
                    </el-descriptions-item>
                  </el-descriptions>

                  <template v-if="evidence.business.attachments.length">
                    <div class="section-title">交付物存证（SHA256，防篡改）</div>
                    <el-descriptions :column="1" size="small" border>
                      <el-descriptions-item v-for="(a, i) in evidence.business.attachments" :key="i" :label="a.name">
                        <el-tooltip :content="'sha256:' + a.sha256" placement="top">
                          <span class="ev-hash">{{ shortHash(a.sha256) }}</span>
                        </el-tooltip>
                      </el-descriptions-item>
                    </el-descriptions>
                  </template>

                  <template v-if="evidence.settlement || evidence.invoice.no">
                    <div class="section-title">资金 / 票据凭证</div>
                    <el-descriptions :column="1" size="small" border>
                      <el-descriptions-item v-if="evidence.settlement" label="业务交易确认单">{{ evidence.settlement.confirmNo }}</el-descriptions-item>
                      <el-descriptions-item v-if="evidence.invoice.no" label="发票号">{{ evidence.invoice.no }}</el-descriptions-item>
                      <el-descriptions-item v-if="evidence.invoice.taxVoucher" label="完税凭证">{{ evidence.invoice.taxVoucher }}</el-descriptions-item>
                      <el-descriptions-item v-if="evidence.insurance" label="按单保单">{{ evidence.insurance.policyNo }}</el-descriptions-item>
                      <el-descriptions-item label="证据包指纹">{{ shortHash(evidence.evidenceHash) }}</el-descriptions-item>
                    </el-descriptions>
                  </template>
                </template>
                <el-empty v-else-if="!evidenceLoading" description="暂无证据链数据" :image-size="60" />
              </div>
            </el-collapse-item>
          </el-collapse>
        </template>
      </div>
    </el-drawer>

    <!-- 驳回理由 -->
    <el-dialog v-model="rejectVisible" title="驳回交付" width="460px" destroy-on-close>
      <el-form @submit.prevent>
        <el-form-item label="驳回理由" required>
          <el-input
            v-model="rejectReason"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="请填写驳回理由，任务将退回进行中状态，零工可重新交付"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="rejecting" @click="onReject">确认驳回</el-button>
      </template>
    </el-dialog>

    <!-- 录用结果 -->
    <el-dialog v-model="hireResultVisible" title="录用成功" width="480px">
      <el-result icon="success" title="已生成分包工单并完成按单投保">
        <template #sub-title>
          <div class="result-rows">
            <div class="result-row"><span>分包工单号</span><b>{{ hireResult.workOrderNo }}</b></div>
            <div class="result-row"><span>保单号</span><b>{{ hireResult.policyNo }}</b></div>
          </div>
        </template>
      </el-result>
      <template #footer>
        <el-button type="primary" @click="hireResultVisible = false">我知道了</el-button>
      </template>
    </el-dialog>

    <!-- 结算单 -->
    <el-dialog v-model="settleVisible" title="验收通过 · 结算单" width="520px">
      <el-result
        icon="success"
        title="任务已验收，平台已完成结算"
        sub-title="发票已自动开具，可在发票中心查看；零工报酬已同步结算到账"
      />
      <el-descriptions :column="1" border>
        <el-descriptions-item label="结算确认单号">{{ settleResult.confirmNo }}</el-descriptions-item>
        <el-descriptions-item label="发票号">{{ settleResult.invoice?.no }}</el-descriptions-item>
        <el-descriptions-item label="发票金额（含税）">
          <span class="money">¥{{ fmtMoney(settleResult.invoice?.amount) }}</span>（税率 {{ settleResult.invoice?.taxRate }}）
        </el-descriptions-item>
        <el-descriptions-item label="零工实发">
          <span class="money">¥{{ fmtMoney(settleResult.settlement?.workerNet) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="代扣个税">
          <span class="money">¥{{ fmtMoney(settleResult.settlement?.tax) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="增值税">
          <span class="money">¥{{ fmtMoney(settleResult.settlement?.vat) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="平台服务费">
          <span class="money">¥{{ fmtMoney(settleResult.settlement?.platformFee) }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="settleVisible = false">关闭</el-button>
        <el-button type="primary" @click="goInvoices">查看发票</el-button>
      </template>
    </el-dialog>

    <!-- 发起争议 -->
    <el-dialog v-model="disputeVisible" :title="`发起争议 · ${disputeTask?.title || ''}`" width="520px" destroy-on-close>
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        class="dispute-alert"
        title="争议提交后先进入协商期，协商不成由平台仲裁裁决；协商期内可随时撤回"
      />
      <el-form ref="disputeFormRef" :model="disputeForm" :rules="disputeRules" label-width="90px">
        <el-form-item label="争议类型" prop="type">
          <el-radio-group v-model="disputeForm.type">
            <el-radio-button v-for="t in disputeTypeOptions" :key="t" :value="t">
              {{ DISPUTE_TYPE[t] }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="诉求描述" prop="claim">
          <el-input
            v-model="disputeForm.claim"
            type="textarea"
            :rows="4"
            maxlength="1000"
            show-word-limit
            placeholder="请描述事实经过与具体诉求（不少于 10 个字），并尽量提供可核实的细节"
          />
        </el-form-item>
        <el-form-item label="主张金额">
          <el-input-number
            v-model="disputeForm.claimAmount"
            :min="0"
            :precision="2"
            :controls="false"
            style="width: 200px"
            placeholder="主张退还 / 赔付金额（元，可选）"
          />
          <span class="form-tip">元，可选</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="disputeVisible = false">取消</el-button>
        <el-button type="warning" :loading="disputeSubmitting" @click="onSubmitDispute">提交争议</el-button>
      </template>
    </el-dialog>

    <!-- 评价 / 查看评价 -->
    <el-dialog v-model="reviewVisible" :title="`任务评价 · ${reviewTaskRow?.title || ''}`" width="540px" destroy-on-close>
      <div v-loading="reviewLoading">
        <!-- 我的评价（已评则只读展示） -->
        <template v-if="myReview">
          <div class="review-section-title">我的评价</div>
          <div class="review-block">
            <el-rate :model-value="myReview.score" disabled />
            <div v-if="myReview.tags?.length" class="review-tags">
              <el-tag v-for="t in myReview.tags" :key="t" size="small" effect="plain">{{ t }}</el-tag>
            </div>
            <div v-if="myReview.comment" class="review-comment">{{ myReview.comment }}</div>
            <div class="review-time">{{ fmtDateTime(myReview.createdAt) }}</div>
          </div>
        </template>
        <template v-else>
          <div class="review-section-title">提交评价（互盲：双方都评完后才可见对方评价）</div>
          <el-form label-width="70px">
            <el-form-item label="评分">
              <el-rate v-model="reviewForm.score" />
            </el-form-item>
            <el-form-item label="标签">
              <el-checkbox-group v-model="reviewForm.tags">
                <el-checkbox v-for="t in REVIEW_TAGS" :key="t" :value="t">{{ t }}</el-checkbox>
              </el-checkbox-group>
            </el-form-item>
            <el-form-item label="评语">
              <el-input
                v-model="reviewForm.comment"
                type="textarea"
                :rows="3"
                maxlength="300"
                show-word-limit
                placeholder="评价将影响零工信用分，请客观填写（可选）"
              />
            </el-form-item>
          </el-form>
        </template>

        <!-- 对方评价 -->
        <div class="review-section-title">零工对我的评价</div>
        <template v-if="workerReview">
          <div class="review-block">
            <el-rate :model-value="workerReview.score" disabled />
            <div v-if="workerReview.tags?.length" class="review-tags">
              <el-tag v-for="t in workerReview.tags" :key="t" size="small" effect="plain">{{ t }}</el-tag>
            </div>
            <div v-if="workerReview.comment" class="review-comment">{{ workerReview.comment }}</div>
            <div class="review-time">{{ fmtDateTime(workerReview.createdAt) }}</div>
          </div>
        </template>
        <el-alert
          v-else
          type="info"
          :closable="false"
          :title="reviewData?.visible ? '零工暂未评价' : '互盲评价：双方都完成评价或评价期截止后，才可查看对方评价'"
        />
      </div>
      <template #footer>
        <el-button @click="reviewVisible = false">关闭</el-button>
        <el-button v-if="!myReview" type="primary" :loading="reviewSubmitting" @click="onSubmitReview">
          提交评价
        </el-button>
      </template>
    </el-dialog>

    <!-- 派单（定向派单） -->
    <el-dialog v-model="dispatchVisible" :title="`派单 · ${dispatchTaskRow?.title || ''}`" width="560px" destroy-on-close>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="dispatch-alert"
        title="派单是向指定零工定向发起邀约，零工接受后平台与其电子签《分包工单》并按单投保，任务进入进行中。候选范围为曾与贵司合作或经贵司邀请注册的已实名零工。"
      />
      <el-input
        v-model="candidateKeyword"
        placeholder="按姓名搜索候选零工"
        clearable
        :prefix-icon="Search"
        class="dispatch-search"
        @keyup.enter="loadCandidates"
        @clear="loadCandidates"
      />
      <el-table
        v-loading="candidateLoading"
        :data="candidates"
        size="small"
        border
        highlight-current-row
        max-height="280"
        @current-change="row => (dispatchWorker = row)"
      >
        <el-table-column width="40">
          <template #default="{ row }">
            <el-radio :model-value="dispatchWorker?.workerId" :value="row.workerId" @change="dispatchWorker = row"><span /></el-radio>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="姓名" min-width="90" />
        <el-table-column label="主体" width="100" align="center">
          <template #default="{ row }">{{ SUBJECT_TYPE[row.subjectType] || '自然人' }}</template>
        </el-table-column>
        <el-table-column label="信用分" width="80" align="center">
          <template #default="{ row }">{{ row.creditScore ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="历史合作" width="90" align="center">
          <template #default="{ row }">{{ row.hiredCount }} 单</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!candidateLoading && !candidates.length" description="暂无可派单的零工，可先通过邀请码邀请零工注册" :image-size="64" />
      <el-input
        v-model="dispatchNote"
        type="textarea"
        :rows="2"
        maxlength="200"
        show-word-limit
        placeholder="给零工的派单留言（可选）"
        class="dispatch-note"
      />
      <template #footer>
        <el-button @click="dispatchVisible = false">取消</el-button>
        <el-button type="primary" :loading="dispatching" :disabled="!dispatchWorker" @click="onDispatch">确认派单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Printer } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import {
  getTasks,
  getTaskDetail,
  hireWorker,
  acceptTask,
  rejectTask,
  cancelTask,
  createDispute,
  reviewTask,
  getTaskReviews,
  getDispatchCandidates,
  dispatchTask,
  getTaskEvidence
} from '../api/company'
import { downloadFile } from '../utils/download'
import { useProfileStore } from '../stores/profile'
import { useAuthStore } from '../stores/auth'
import { fmtMoney, fmtDateTime, SUBJECT_TYPE, DISPUTE_TYPE, REVIEW_TAGS } from '../utils/format'

const router = useRouter()
const auth = useAuthStore()
const profileStore = useProfileStore()

const activeStatus = ref('all')
const keyword = ref('')
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)

const drawerVisible = ref(false)
const detailLoading = ref(false)
const detail = ref(null)

// 证据链（懒加载：展开折叠区时才拉取）
const evidence = ref(null)
const evidenceLoading = ref(false)
const evidencePanel = ref([])
const STAGE_TYPE = { 派单: 'warning', 抢单: 'primary', 单据管理: 'info', 单据验收: 'success', 其他: 'info' }
const ROLE_CN = { company: '企业', worker: '零工', admin: '平台' }
const shortHash = h => (h ? String(h).replace('sha256:', '').slice(0, 12) + '…' : '—')
// 经纬度人话化：保留精度但加空格便于阅读（业务用户视角）
function fmtGeo(g) {
  if (!g) return ''
  const [lat, lng] = String(g).split(',')
  return lat && lng ? `${lat.trim()}, ${lng.trim()}` : g
}
// 点击在高德地图查看操作现场（geo 为 gcj02 "lat,lng"；高德 marker 需 "lng,lat"）
function geoMapUrl(g) {
  if (!g) return ''
  const [lat, lng] = String(g).split(',').map(s => s.trim())
  return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent('操作现场')}&coordinate=gaode`
}
const STATUS_CN = { recruiting: '报名中', working: '进行中', delivered: '待验收', settled: '已结算', cancelled: '已取消' }
async function loadEvidence(panels) {
  if (!panels.includes('ev') || evidence.value || evidenceLoading.value || !detail.value?.id) return
  evidenceLoading.value = true
  try {
    evidence.value = await getTaskEvidence(detail.value.id)
  } catch {
    evidence.value = null
  } finally {
    evidenceLoading.value = false
  }
}

// 打印 / 导出证据链：新窗口生成可打印的证据链报告（操作时间轴 + 四流凭证 + 完整性结论），
// 覆盖任意状态工单（争议中/进行中亦可），用于争议举证与税务核查。
function printEvidence() {
  const ev = evidence.value
  if (!ev) return
  const win = window.open('', '_blank', 'width=900,height=960')
  if (!win) {
    ElMessage.warning('请允许浏览器弹出窗口后重试')
    return
  }
  const esc = v => String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const flag = (label, ok) => `<span class="flag ${ok ? 'on' : 'off'}">${label} ${ok ? '✓' : '—'}</span>`
  const rows = ev.timeline.map(e => `
    <tr>
      <td class="nowrap">${esc(fmtDateTime(e.at))}</td>
      <td><span class="stage">${esc(e.stage)}</span></td>
      <td>${esc(e.label)}</td>
      <td>${esc(e.actor.name)}${e.actor.role ? `（${esc(ROLE_CN[e.actor.role] || e.actor.role)}）` : ''}</td>
      <td class="mono">${esc(e.ip || '—')}</td>
      <td>${e.geo ? '📍 ' + esc(fmtGeo(e.geo)) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="6">暂无操作留痕</td></tr>'
  const contracts = (ev.contract || []).map(c => `<li><b>${esc(c.label)}</b>：<span class="mono">${esc(c.no)}</span>${c.contentHash ? ` · 内容哈希 <span class="mono">${esc(c.contentHash)}</span>` : ''}</li>`).join('') || '<li>—</li>'
  const attaches = (ev.business.attachments || []).map(a => `<li>${esc(a.name)} · SHA256 <span class="mono">${esc(a.sha256)}</span></li>`).join('') || '<li>—</li>'
  win.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>工单证据链·${esc(ev.task.title)}</title>
<style>
  body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;margin:36px;}
  h1{font-size:21px;text-align:center;margin-bottom:2px;}
  .sub{text-align:center;color:#6b7280;font-size:12px;margin-bottom:20px;}
  .flags{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:18px;}
  .flag{font-size:12px;padding:3px 10px;border-radius:14px;border:1px solid #d1d5db;}
  .flag.on{background:#ecfdf5;border-color:#a7f3d0;color:#047857;}
  .flag.off{background:#f3f4f6;color:#9ca3af;}
  .meta{display:flex;flex-wrap:wrap;gap:6px 28px;font-size:13px;margin-bottom:18px;}
  h2{font-size:14px;margin:22px 0 8px;border-left:3px solid #6366f1;padding-left:8px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th,td{border:1px solid #e5e7eb;padding:7px 9px;text-align:left;vertical-align:top;}
  th{background:#f9fafb;}
  .stage{background:#eef2ff;color:#4338ca;border-radius:4px;padding:1px 6px;font-size:11px;}
  .mono{font-family:Consolas,'Courier New',monospace;word-break:break-all;}
  ul{margin:0;padding-left:18px;} li{line-height:1.9;}
  .nowrap{white-space:nowrap;}
  .foot{margin-top:26px;display:flex;justify-content:space-between;color:#6b7280;font-size:11px;}
  .fp{margin-top:14px;padding:10px 12px;border:1px dashed #9ca3af;border-radius:8px;font-size:11px;}
  @media print{body{margin:14px;}}
</style></head><body>
  <h1>灵工云 · 工单证据链</h1>
  <div class="sub">操作留痕时间轴 · 四流凭证 · 防篡改哈希固化 — 可用于争议举证与税务核查</div>
  <div class="flags">${flag('合同流', ev.completeness.contract)}${flag('业务流', ev.completeness.business)}${flag('资金流', ev.completeness.fund)}${flag('票据流', ev.completeness.invoice)}<span class="flag ${ev.chain?.ok ? 'on' : 'off'}">${ev.chain?.ok ? '🛡 审计链完好' : '⚠ 审计链异常'}</span></div>
  <div class="meta">
    <span><b>工单：</b>${esc(ev.task.title)}（#${esc(ev.task.id)}）</span>
    <span><b>状态：</b>${esc(STATUS_CN[ev.task.status] || ev.task.status)}</span>
    <span><b>发单企业：</b>${esc(ev.company?.companyName)}</span>
    <span><b>承接零工：</b>${esc(ev.worker?.name)}</span>
    <span><b>承揽价：</b>¥${esc(Number(ev.task.price).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</span>
  </div>
  <h2>① 操作留痕时间轴</h2>
  <table><thead><tr><th>时间</th><th>环节</th><th>操作</th><th>操作人</th><th>IP</th><th>现场定位</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>② 合同流凭证（电子签 + 内容哈希）</h2><ul>${contracts}</ul>
  <h2>③ 交付物存证（SHA256）</h2><ul>${attaches}</ul>
  <h2>④ 资金 / 票据凭证</h2>
  <ul>
    <li>业务交易确认单：<span class="mono">${esc(ev.settlement?.confirmNo)}</span></li>
    <li>发票号：<span class="mono">${esc(ev.invoice?.no)}</span></li>
    <li>完税凭证：<span class="mono">${esc(ev.invoice?.taxVoucher)}</span></li>
    <li>按单保单：<span class="mono">${esc(ev.insurance?.policyNo)}</span></li>
  </ul>
  <div class="fp"><b>证据包指纹（SHA-256）：</b><span class="mono">${esc(ev.evidenceHash)}</span></div>
  <div class="foot"><span>导出时间：${esc(fmtDateTime(new Date().toISOString()))}</span><span>灵工云企业端 · 承揽后分包合规留痕</span></div>
  ${'<'}script>window.onload=function(){window.print()}${'<'}/script>
</body></html>`)
  win.document.close()
}

const hiringId = ref(null)
const hireResultVisible = ref(false)
const hireResult = ref({})

const acceptingId = ref(null)
const settleVisible = ref(false)
const settleResult = ref({})

const rejectVisible = ref(false)
const rejectTaskId = ref(null)
const rejectReason = ref('')
const rejecting = ref(false)

const downloadingId = ref(null)

// —— 争议 ——
const disputeVisible = ref(false)
const disputeFormRef = ref()
const disputeTask = ref(null)
const disputeSubmitting = ref(false)
const disputeForm = reactive({ type: '', claim: '', claimAmount: undefined })

const disputeRules = {
  type: [{ required: true, message: '请选择争议类型', trigger: 'change' }],
  claim: [
    { required: true, message: '请描述诉求', trigger: 'blur' },
    { min: 10, max: 1000, message: '诉求描述不少于 10 个字', trigger: 'blur' }
  ]
}

// 企业可发起的争议类型按任务状态过滤（进行中→零工失联；已结算→结算后质量争议）
const disputeTypeOptions = computed(() => {
  const status = disputeTask.value?.status
  if (status === 'working') return ['worker_missing', 'other']
  if (status === 'settled') return ['quality_after', 'other']
  return ['other']
})

// —— 评价 ——
const reviewVisible = ref(false)
const reviewLoading = ref(false)
const reviewTaskRow = ref(null)
const reviewData = ref(null)
const reviewSubmitting = ref(false)
const reviewForm = reactive({ score: 5, tags: [], comment: '' })

const myReview = computed(() => reviewData.value?.reviews?.find(r => r.reviewerRole === 'company') || null)
const workerReview = computed(() => reviewData.value?.reviews?.find(r => r.reviewerRole === 'worker') || null)

// 信用等级标签色（与零工信用分等级对应）
const CREDIT_TAG = { 优选: 'success', 良好: 'primary', 一般: 'warning', 受限: 'danger' }
const creditTag = grade => CREDIT_TAG[grade] || 'info'

// —— 派单 ——
const DISPATCH_STATUS = { invited: '待接受', accepted: '已接受', rejected: '已拒绝', cancelled: '已取消' }
const DISPATCH_TAG = { invited: 'warning', accepted: 'success', rejected: 'info', cancelled: 'info' }
const dispatchVisible = ref(false)
const dispatchTaskRow = ref(null)
const candidates = ref([])
const candidateKeyword = ref('')
const candidateLoading = ref(false)
const dispatchWorker = ref(null)
const dispatchNote = ref('')
const dispatching = ref(false)

async function loadCandidates() {
  candidateLoading.value = true
  try {
    const data = await getDispatchCandidates(candidateKeyword.value.trim())
    candidates.value = data.list
  } finally {
    candidateLoading.value = false
  }
}

function openDispatch(row) {
  dispatchTaskRow.value = row
  dispatchWorker.value = null
  dispatchNote.value = ''
  candidateKeyword.value = ''
  candidates.value = []
  dispatchVisible.value = true
  loadCandidates()
}

async function onDispatch() {
  if (!dispatchWorker.value) {
    ElMessage.warning('请选择要派单的零工')
    return
  }
  dispatching.value = true
  try {
    await dispatchTask(dispatchTaskRow.value.id, dispatchWorker.value.workerId, dispatchNote.value.trim())
    ElMessage.success(`已向「${dispatchWorker.value.name}」派单，等待其接受`)
    dispatchVisible.value = false
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示（非候选 / 已派单 / 状态不允许等）
  } finally {
    dispatching.value = false
  }
}

// 空状态区分：有筛选条件时不展示"去发布"引导
const filtered = computed(() => activeStatus.value !== 'all' || !!keyword.value.trim())

// B线提示：待验收 + 录用者为个体工商户 + 附件中无进项发票 → 验收将被四流校验阻断
const invoiceMissing = computed(() => {
  const d = detail.value
  if (!d || d.status !== 'delivered') return false
  const hired = d.applications?.find(a => a.status === 'hired')
  if (hired?.subjectType !== 'soletrader') return false
  return !(d.attachments || []).some(f => f.kind === 'invoice')
})

// 结构化交付：按上传项分组，关联快照里的 uploadIds 与已鉴权附件元数据，便于企业逐项核对下载
const structuredUploadGroups = computed(() => {
  const d = detail.value
  if (!d?.deliverableData?.uploads?.length) return []
  const byId = new Map((d.attachments || []).map(f => [f.id, f]))
  return d.deliverableData.uploads.map(u => ({
    label: u.label,
    files: (u.uploadIds || []).map(id => byId.get(id)).filter(Boolean)
  }))
})

// 已被结构化分组展示的附件 id（用于把「交付附件」通用区收敛为剩余项，如进项发票，避免重复列出）
const structuredAttachIds = computed(() => {
  const ids = new Set()
  for (const g of structuredUploadGroups.value) for (const f of g.files) ids.add(f.id)
  return ids
})
const extraAttachments = computed(() => (detail.value?.attachments || []).filter(f => !structuredAttachIds.value.has(f.id)))

function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function fetchList() {
  loading.value = true
  try {
    const status = activeStatus.value === 'all' ? undefined : activeStatus.value
    const data = await getTasks({ status, keyword: keyword.value.trim(), page: page.value, pageSize: pageSize.value })
    list.value = data.list
    total.value = data.total
  } finally {
    loading.value = false
  }
}

function onSearch() {
  page.value = 1
  fetchList()
}

function onTabChange() {
  page.value = 1
  fetchList()
}

function onSizeChange() {
  page.value = 1
  fetchList()
}

async function openDetail(id) {
  drawerVisible.value = true
  detailLoading.value = true
  detail.value = null
  evidence.value = null
  evidencePanel.value = []
  try {
    detail.value = await getTaskDetail(id)
  } finally {
    detailLoading.value = false
  }
}

async function refreshDetail() {
  if (drawerVisible.value && detail.value?.id) {
    detail.value = await getTaskDetail(detail.value.id)
  }
  fetchList()
}

async function onHire(row) {
  try {
    await ElMessageBox.confirm(
      `录用「${row.workerName}」后，平台将与其签署分包工单并完成按单投保，其他报名者将被婉拒。是否继续？`,
      '录用确认',
      { confirmButtonText: '继续录用', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  hiringId.value = row.workerId
  try {
    hireResult.value = await hireWorker(detail.value.id, row.workerId)
    hireResultVisible.value = true
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  } finally {
    hiringId.value = null
  }
}

async function onAccept(taskId) {
  try {
    await ElMessageBox.confirm(
      '验收通过后，平台将自动完成资金划扣、零工结算，并向贵司开具数电发票，此操作不可撤销。是否继续？',
      '验收确认',
      { confirmButtonText: '继续验收', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  acceptingId.value = taskId
  try {
    settleResult.value = await acceptTask(taskId)
    settleVisible.value = true
    await refreshDetail()
  } catch (err) {
    const code = err?.response?.data?.error?.code
    if (code === 'SETTLE_PENDING') {
      // 银行通道异常：结算单已受理，由系统自动重试，无需重复操作
      ElMessageBox.alert(
        '银行通道繁忙，结算已受理，系统将自动完成，请稍后刷新查看',
        '结算已受理',
        { confirmButtonText: '我知道了', type: 'info' }
      ).catch(() => {})
      refreshDetail().catch(() => {})
    } else if (code === 'SETTLING') {
      ElMessage.info('该任务结算正在处理中，请勿重复操作，稍后刷新查看即可')
    } else {
      // acceptTask 以 silent 发起，其余错误（四流校验等）在此提示
      ElMessage.error(err?.response?.data?.error?.message || '验收失败，请稍后重试')
    }
  } finally {
    acceptingId.value = null
  }
}

function openReject(taskId) {
  rejectTaskId.value = taskId
  rejectReason.value = ''
  rejectVisible.value = true
}

async function onReject() {
  if (!rejectReason.value.trim()) {
    ElMessage.warning('请填写驳回理由')
    return
  }
  rejecting.value = true
  try {
    await rejectTask(rejectTaskId.value, rejectReason.value.trim())
    ElMessage.success('已驳回，任务退回进行中状态')
    rejectVisible.value = false
    rejectReason.value = ''
    await refreshDetail()
  } catch {
    // 错误已由拦截器提示
  } finally {
    rejecting.value = false
  }
}

async function onCancel(row) {
  try {
    await ElMessageBox.confirm(
      `取消任务「${row.title}」后，将解冻预算 ¥${fmtMoney(row.price)} 回到可用余额，并通知已报名的零工。是否继续？`,
      '取消任务',
      { confirmButtonText: '继续取消', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const res = await cancelTask(row.id)
    ElMessage.success(`任务已取消，已解冻预算 ¥${fmtMoney(res.unfrozen)}`)
    profileStore.fetch().catch(() => {})
    fetchList()
  } catch {
    // 错误已由拦截器提示
  }
}

async function onDownload(f) {
  downloadingId.value = f.id
  try {
    await downloadFile(f.url, f.name)
  } catch {
    // 错误已由拦截器提示
  } finally {
    downloadingId.value = null
  }
}

function goInvoices() {
  settleVisible.value = false
  drawerVisible.value = false
  router.push('/invoices')
}

// —— 发起争议 ——
function openDispute(row) {
  disputeTask.value = row
  disputeForm.type = ''
  disputeForm.claim = ''
  disputeForm.claimAmount = undefined
  disputeVisible.value = true
}

async function onSubmitDispute() {
  try {
    await disputeFormRef.value.validate()
  } catch {
    return
  }
  disputeSubmitting.value = true
  try {
    const res = await createDispute(disputeTask.value.id, {
      type: disputeForm.type,
      claim: disputeForm.claim.trim(),
      claimAmount: disputeForm.claimAmount || undefined
    })
    disputeVisible.value = false
    ElMessageBox.confirm(
      `争议单 ${res.no || ''} 已提交，先进入协商期，对方与平台已收到通知。可前往争议中心跟进举证与裁决进展。`,
      '争议已提交',
      { confirmButtonText: '去争议中心', cancelButtonText: '留在本页', type: 'success' }
    )
      .then(() => router.push('/disputes'))
      .catch(() => {})
  } catch {
    // 错误已由拦截器提示（已有争议 / 状态不允许等）
  } finally {
    disputeSubmitting.value = false
  }
}

// —— 评价 ——
async function openReview(row) {
  reviewTaskRow.value = row
  reviewData.value = null
  reviewForm.score = 5
  reviewForm.tags = []
  reviewForm.comment = ''
  reviewVisible.value = true
  reviewLoading.value = true
  try {
    reviewData.value = await getTaskReviews(row.id)
  } finally {
    reviewLoading.value = false
  }
}

async function onSubmitReview() {
  if (!reviewForm.score) {
    ElMessage.warning('请先选择评分')
    return
  }
  reviewSubmitting.value = true
  try {
    await reviewTask(reviewTaskRow.value.id, {
      score: reviewForm.score,
      tags: reviewForm.tags,
      comment: reviewForm.comment.trim()
    })
    ElMessage.success('评价已提交，对方完成评价后双方互见')
    reviewData.value = await getTaskReviews(reviewTaskRow.value.id)
  } catch {
    // 错误已由拦截器提示
  } finally {
    reviewSubmitting.value = false
  }
}

onMounted(fetchList)
</script>

<style scoped>
.detail-desc {
  margin-bottom: 8px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin: 20px 0 10px;
}

.pre-wrap {
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.7;
}

.deliverable-box {
  border-radius: 8px;
}

.invoice-alert {
  margin-top: 10px;
  border-radius: 8px;
}

.deliver-time {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}

.deliver-fields {
  margin-bottom: 4px;
}
.deliver-group {
  margin-top: 10px;
}
.deliver-group-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 6px;
}

.action-bar {
  margin-top: 16px;
  display: flex;
  gap: 10px;
}

.attach-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attach-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-hover);
}

.attach-icon {
  color: var(--brand);
  font-size: 18px;
  flex-shrink: 0;
}

.attach-meta {
  flex: 1;
  min-width: 0;
}

.attach-name {
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-size {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

.result-rows {
  text-align: left;
  display: inline-block;
}

.result-row {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  margin: 6px 0;
  font-size: 14px;
  color: var(--text-2);
}

.result-row b {
  color: var(--text-1);
}

.credit-tag {
  cursor: help;
}

.dispute-alert {
  margin-bottom: 16px;
  border-radius: 8px;
}

.dispatch-alert {
  margin-bottom: 14px;
  border-radius: 8px;
}

.dispatch-search {
  margin-bottom: 12px;
}

.dispatch-note {
  margin-top: 12px;
}

.form-tip {
  margin-left: 10px;
  color: var(--text-3);
  font-size: 12px;
}

.review-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 10px;
}

.review-section-title + .review-section-title,
.review-block + .review-section-title,
.el-form + .review-section-title {
  margin-top: 20px;
}

.review-block {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-hover);
  padding: 12px 14px;
  margin-bottom: 4px;
}

.review-tags {
  margin-top: 8px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.review-comment {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
  white-space: pre-wrap;
}

.review-time {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}

/* —— 证据链 —— */
.evidence-collapse {
  margin-top: 18px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.ev-title-icon {
  margin-right: 6px;
  color: var(--el-color-primary);
}
.ev-title {
  font-weight: 600;
}
.ev-intro {
  margin: 4px 0 12px;
  line-height: 1.6;
}
.ev-flags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
}
.ev-print-btn {
  margin-left: auto;
}
.ev-ip {
  font-family: var(--el-font-family-monospace, monospace);
  cursor: help;
}
.ev-geo {
  color: var(--success, #67c23a);
  text-decoration: none;
}
.ev-geo:hover {
  text-decoration: underline;
}
.ev-timeline {
  padding-left: 4px;
  margin-top: 6px;
}
.ev-node {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ev-label {
  font-weight: 500;
}
.ev-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.ev-no {
  font-family: var(--el-font-family-monospace, monospace);
}
.ev-hash {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 12px;
  color: var(--text-3);
}
</style>
