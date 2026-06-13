// 外部接口端：对接公安实名、存管银行、数电票、电子签、税务局、保险公司、短信。
// 生产环境替换为真实服务商 SDK/HTTP 调用；此处为同构适配器（接口签名与生产一致），
// 调用结果与时延记录至内存健康表 + integration_calls 出站日志，供 /admin/integrations 与排障使用。
import crypto from 'node:crypto'
import { genNo } from '../utils/ids.js'
import db from '../db.js'

const health = new Map()
const qCallLog = db.prepare(`
  INSERT INTO integration_calls (provider, action, biz_ref, status, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)
`)

function track(key, action, fn) {
  return async (...args) => {
    const start = performance.now()
    const bizRef = args[0]?.idemKey || args[0]?.bizRef || null
    const isProbe = args[0]?.purpose === 'probe' || args[0]?.probe === true
    try {
      const result = await fn(...args)
      const latency = Math.max(1, Math.round(performance.now() - start))
      health.set(key, { status: 'up', latencyMs: latency, at: new Date().toISOString() })
      if (!isProbe) qCallLog.run(key, action, bizRef, 'ok', latency, null)
      return result
    } catch (err) {
      const latency = Math.round(performance.now() - start)
      health.set(key, { status: 'down', latencyMs: latency, at: new Date().toISOString(), error: err.message })
      if (!isProbe) qCallLog.run(key, action, bizRef, 'fail', latency, String(err.message).slice(0, 200))
      throw err
    }
  }
}

// 测试故障注入：integration 测试可模拟银行通道异常（仅 test 环境生效）
export const _testHooks = { failNext: {} }
function maybeInjectFailure(key) {
  if (process.env.NODE_ENV === 'test' && _testHooks.failNext[key] > 0) {
    _testHooks.failNext[key]--
    throw new Error(`模拟${key}通道异常`)
  }
}

// 公安实名核验（身份证二要素 + 活体人脸 + 银行卡四要素）
export const realname = {
  key: 'realname',
  name: '公安实名核验',
  provider: '公安部一所·CTID',
  verify: track('realname', 'verify', async ({ idCard, realName }) => {
    if (!/^\d{17}[\dXx]$/.test(idCard)) return { pass: false, reason: '身份证号格式不正确' }
    if (!realName || realName.length < 2) return { pass: false, reason: '姓名不合法' }
    return { pass: true, requestId: crypto.randomUUID() }
  }),
  // 人脸核身：发起返回 faceRequestId（生产为活体检测 BizToken），校验结果接口确认通过
  faceStart: track('realname', 'faceStart', async ({ idCard, realName }) => {
    return { faceRequestId: 'FACE' + crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase(), idCard, realName }
  }),
  faceResult: track('realname', 'faceResult', async ({ faceRequestId }) => {
    if (!faceRequestId || !faceRequestId.startsWith('FACE')) return { pass: false, reason: '人脸核身凭证无效' }
    return { pass: true, faceRequestId }
  }),
  // 银行卡四要素（卡号+姓名+身份证+预留手机），绑提现卡硬要求
  bankcardVerify: track('realname', 'bankcardVerify', async ({ idCard, realName, bankCard, phone }) => {
    maybeInjectFailure('realname')
    if (!/^\d{15,19}$/.test(bankCard)) return { pass: false, reason: '银行卡号格式不正确' }
    if (!/^1\d{10}$/.test(phone)) return { pass: false, reason: '银行预留手机号格式不正确' }
    if (!/^\d{17}[\dXx]$/.test(idCard) || !realName) return { pass: false, reason: '身份信息不完整' }
    return { pass: true, requestId: crypto.randomUUID() }
  })
}

// 银行存管（虚拟账户分账）：平台只发指令，不触碰在途资金。
// idemKey 幂等：重复指令直接返回首次回执（银行侧消重语义）。
export const escrow = {
  key: 'escrow',
  name: '银行存管分账',
  provider: '平安见证宝',
  // 会员开户（实名/审核通过后调用，建立 本地账户 ↔ 银行子账户 映射）
  openAccount: track('escrow', 'openAccount', async ({ ownerType, ownerId, name }) => {
    maybeInjectFailure('escrow')
    return {
      memberNo: `M${ownerType === 'company' ? 'C' : 'W'}${String(ownerId).padStart(8, '0')}`,
      subAcctNo: 'SUB' + genNo('').slice(0, 14),
      name
    }
  }),
  // 绑提现卡（生产为小额打款/短验鉴权异步确认；mock 同步返回协议号）
  bindCard: track('escrow', 'bindCard', async ({ memberNo, bankCard, phone }) => {
    maybeInjectFailure('escrow')
    if (!/^\d{15,19}$/.test(bankCard)) throw new Error('银行卡号格式不正确')
    return {
      bindCardToken: 'BC' + crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase(),
      cardMasked: bankCard.slice(0, 4) + '****' + bankCard.slice(-4),
      memberNo, phone
    }
  }),
  // 充值收银台：生成企业专属入金账户信息（生产为见证宝专属充值账号/收银台链接）
  cashier: track('escrow', 'cashier', async ({ companyId, orderNo, amountCents }) => {
    return {
      payAccount: `7115 0000 ${String(companyId).padStart(4, '0')} ${orderNo.slice(-4)}`,
      payBank: '平安银行股份有限公司（见证宝存管专户）',
      payee: '灵工云平台客户备付金',
      orderNo, amountCents
    }
  }),
  transfer: track('escrow', 'transfer', async ({ from, to, amountCents, purpose, idemKey }) => {
    maybeInjectFailure('escrow')
    if (amountCents <= 0) throw new Error('金额非法')
    if (idemKey) {
      const dup = db.prepare(`SELECT txn_no FROM escrow_txns WHERE idem_key = ?`).get(idemKey)
      if (dup) return { txnNo: dup.txn_no, from, to, amountCents, purpose, duplicated: true }
    }
    const txnNo = genNo('BK')
    // 银行侧回执落库（探活请求除外），作为 T+1 对账的银行流水来源
    if (purpose !== 'probe') {
      db.prepare(`INSERT INTO escrow_txns (txn_no, from_acct, to_acct, amount, purpose, idem_key) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(txnNo, from, to, amountCents, purpose, idemKey ?? null)
    }
    return { txnNo, from, to, amountCents, purpose, at: new Date().toISOString() }
  })
}

// 数电票开票
export const einvoice = {
  key: 'einvoice',
  name: '数电票开票',
  provider: '乐企直连',
  issue: track('einvoice', 'issue', async ({ title, taxNo, amountCents, item }) => {
    maybeInjectFailure('einvoice')
    return { invoiceNo: genNo('SD'), title, taxNo, amountCents, item, issuedAt: new Date().toISOString() }
  }),
  // 红字发票（红冲）：生产为红字确认单 API
  redFlush: track('einvoice', 'redFlush', async ({ invoiceNo, reason }) => {
    maybeInjectFailure('einvoice')
    return { redInvoiceNo: genNo('HC'), originalNo: invoiceNo, reason, issuedAt: new Date().toISOString() }
  })
}

// 电子签（CA + 时间戳 + 司法存证）
export const esign = {
  key: 'esign',
  name: '电子签存证',
  provider: 'e签宝',
  sign: track('esign', 'sign', async ({ docType, parties, contentHash }) => {
    return { esignId: 'ES' + crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase(), docType, parties, contentHash, signedAt: new Date().toISOString() }
  }),
  // 静默签授权（一次性有感意愿认证，此后框架协议/工单全部 API 静默落章）
  authorize: track('esign', 'authorize', async ({ subjectType, subjectName }) => {
    return { authId: 'AU' + crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase(), subjectType, subjectName, authorizedAt: new Date().toISOString() }
  })
}

// 税务局（申报缴款 / 涉税信息报送）
export const taxbureau = {
  key: 'taxbureau',
  name: '税务申报报送',
  provider: '省电子税务局API',
  declare: track('taxbureau', 'declare', async ({ period, taxCents, vatCents }) => {
    return { receiptNo: genNo('TX'), period, taxCents, vatCents }
  }),
  report: track('taxbureau', 'report', async ({ period, workers }) => {
    return { fileNo: genNo('RP'), period, workers }
  })
}

// 保险（按单投保）
export const insurance = {
  key: 'insurance',
  name: '按单投保',
  provider: '合作保险公司',
  insure: track('insurance', 'insure', async ({ taskId, workerId, plan, premiumCents }) => {
    return { policyNo: genNo('INS'), taskId, workerId, plan, premiumCents }
  })
}

// 短信（验证码 + 交易类通知白名单场景；生产对接阿里云/腾讯云双通道）
export const sms = {
  key: 'sms',
  name: '短信通道',
  provider: '阿里云短信（主）/腾讯云（备）',
  send: track('sms', 'send', async ({ phone, content }) => {
    maybeInjectFailure('sms')
    if (!/^1\d{10}$/.test(phone)) throw new Error('手机号格式不正确')
    return { msgId: genNo('SM'), phone, content, sentAt: new Date().toISOString() }
  })
}

// 微信订阅消息（小程序一次性订阅推送；生产对接 api.weixin.qq.com 的 message/subscribe/send，需 access_token）
// 与短信同为"尽力而为"通道，失败仅落日志、不阻塞业务。
export const wxsubscribe = {
  key: 'wxsubscribe',
  name: '微信订阅消息',
  provider: '微信小程序订阅消息',
  send: track('wxsubscribe', 'send', async ({ openid, templateId, data, page }) => {
    if (!openid) throw new Error('缺少用户 openid')
    if (!templateId) throw new Error('缺少订阅消息模板ID')
    return { msgId: genNo('WX'), openid, templateId, page: page ?? 'pages/notices/notices', data, sentAt: new Date().toISOString() }
  })
}

const ALL = [realname, escrow, einvoice, esign, taxbureau, insurance, sms]

export async function healthCheck() {
  // 主动探活：调用各适配器的轻量请求（probe 标记不计入出站日志与业务流水）
  await Promise.allSettled([
    realname.verify({ idCard: '110101199001011237', realName: '探活', probe: true }),
    escrow.transfer({ from: 'probe', to: 'probe', amountCents: 1, purpose: 'probe' }),
    einvoice.issue({ title: '探活', taxNo: '-', amountCents: 1, item: 'probe', probe: true }),
    esign.sign({ docType: 'probe', parties: [], contentHash: '-', probe: true }),
    taxbureau.declare({ period: 'probe', taxCents: 0, vatCents: 0, probe: true }),
    insurance.insure({ taskId: 0, workerId: 0, plan: 'probe', premiumCents: 1, probe: true }),
    sms.send({ phone: '13800000000', content: 'probe', probe: true })
  ])
  return ALL.map(svc => ({
    key: svc.key,
    name: svc.name,
    provider: svc.provider,
    status: health.get(svc.key)?.status ?? 'unknown',
    latencyMs: health.get(svc.key)?.latencyMs ?? null,
    checkedAt: health.get(svc.key)?.at ?? null
  }))
}
