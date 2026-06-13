import { Router } from 'express'
import { z } from 'zod'
import db from '../db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { badRequest, notFound, locked, conflict } from '../utils/errors.js'
import { yuanToCents, centsToYuan } from '../utils/money.js'
import { genNo, sha256, currentPeriod, currentDate } from '../utils/ids.js'
import { pageParams } from '../utils/pagination.js'
import * as accounts from '../services/accounts.js'
import * as taxEngine from '../services/taxEngine.js'
import { getConfig } from '../services/configStore.js'
import { notifyCompany } from '../services/notify.js'
import { amlChecks } from '../services/risk.js'
import { logAction } from '../services/audit.js'
import { realname, esign, escrow } from '../integrations/index.js'
import { renderContract } from '../services/contractText.js'
import { readableText } from '../utils/textQuality.js'
import { verifyCode } from '../services/sms.js'
import * as secrets from '../services/secrets.js'
import { createDispute } from '../services/disputes.js'
import { submitReview, getTaskReviews, checkOrderLimit, workerCreditProfile } from '../services/credit.js'
import { hireWorker } from '../services/hiring.js'

const router = Router()
router.use(authenticate, requireRole('worker'))

const getProfile = id => db.prepare(`SELECT * FROM worker_profiles WHERE user_id = ?`).get(id)

const isExpired = deadline => deadline < currentDate()

// 按单保险方案与保费（与 hiring.js 录用投保口径一致）：线下作业类目强制高保额方案
function insuranceFor(category) {
  const offline = getConfig('offlineCategories').includes(category)
  const plan = offline ? '高保额方案' : '基础方案'
  const premium = (offline ? getConfig('insurancePremiumHigh') : getConfig('insurancePremiumBase')) * 100
  return {
    plan,
    premium: centsToYuan(premium),
    coverage: offline ? '含意外身故/伤残及雇主责任，适用配送、安装、施工等线下作业' : '含意外身故/伤残，适用纯线上交付任务',
    offline
  }
}

function taskAttachments(taskId, kind) {
  return db.prepare(`
    SELECT u.id, u.original_name AS name, u.mime, u.size, a.kind
    FROM task_attachments a JOIN uploads u ON u.id = a.upload_id
    WHERE a.task_id = ?${kind ? ' AND a.kind = ?' : ''}
  `).all(...(kind ? [taskId, kind] : [taskId]))
    .map(f => ({ ...f, url: `/api/v1/files/${f.id}` }))
}

// —— 档案 ——
router.get('/profile', (req, res) => {
  const p = getProfile(req.user.id)
  const u = db.prepare(`SELECT name, phone FROM users WHERE id = ?`).get(req.user.id)
  const acc = accounts.getAccount('worker', req.user.id)
  const member = db.prepare(`SELECT * FROM escrow_members WHERE owner_type = 'worker' AND owner_id = ?`).get(req.user.id)
  res.json({
    name: u.name,
    phone: u.phone,
    verified: !!p.verified,
    faceVerified: !!p.face_verified,
    subjectType: p.subject_type,
    bankCard: member?.card_masked ?? p.bank_card_masked,
    cardBound: member?.status === 'card_bound',
    frameContractNo: p.frame_contract_no,
    locked: !!p.locked,
    credit: workerCreditProfile(req.user.id),
    account: {
      balance: centsToYuan(acc.balance - acc.frozen),
      frozen: centsToYuan(acc.frozen)
    }
  })
})

router.patch('/profile', (req, res, next) => {
  try {
    const { name } = z.object({ name: readableText('姓名', z.string().min(1).max(30)) }).parse(req.body)
    db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(name, req.user.id)
    logAction(req.user.id, 'update_profile', `name=${name}`)
    res.json({ name })
  } catch (err) {
    next(err)
  }
})

// —— 实名认证 + 签署《分包协议（框架）》 ——
// PIPL：处理身份证/人脸/银行卡前须取得单独同意（consents 留痕至 agreements）；
// 身份证号密文入库（worker_secrets，HMAC 查重防一人多号）；
// 生产开启 faceVerifyRequired 后走三段式：二要素 → 人脸核身 → 回传结果完成签约。
const verifySchema = z.object({
  idCard: z.string().length(18, '身份证号须为18位'),
  realName: readableText('实名姓名', z.string().min(2).max(30)),
  bankCard: z.string().regex(/^\d{15,19}$/, '银行卡号格式不正确'),
  consents: z.array(z.enum(['idcard', 'face', 'bankcard'])).optional().default([])
})

function recordConsents(userId, consents) {
  const stmt = db.prepare(`INSERT INTO agreements (user_id, doc_type, version) VALUES (?, ?, 1)`)
  for (const c of new Set(consents)) stmt.run(userId, `consent_${c}`)
}

function completeWorkerVerify(userId, { idCard, realName, bankCard }) {
  const frameNo = genNo('FBK')
  return esign.sign({
    docType: 'frame_sub',
    parties: ['平台', realName],
    contentHash: sha256({ frameNo, workerId: userId, terms: '按成果计酬/工时自主/工具自备/不接受考勤/不合格不计酬' })
  }).then(signed => {
    db.transaction(() => {
      db.prepare(`
        UPDATE worker_profiles SET verified = 1, real_name = ?, id_card_masked = ?, bank_card_masked = ?,
          frame_contract_no = ?, verified_at = datetime('now','localtime')
        WHERE user_id = ?
      `).run(
        realName,
        idCard.slice(0, 4) + '**********' + idCard.slice(-4),
        bankCard.slice(0, 4) + '****' + bankCard.slice(-4),
        frameNo,
        userId
      )
      secrets.storeIdCard(userId, idCard)
      const content = renderContract('frame_sub', {
        partyB: realName, contractNo: frameNo, date: currentDate(), hash: signed.contentHash
      })
      db.prepare(`
        INSERT INTO contracts (type, no, party_a, party_b, worker_id, content_hash, esign_id, content)
        VALUES ('frame_sub', ?, '平台', ?, ?, ?, ?, ?)
      `).run(frameNo, realName, userId, signed.contentHash, signed.esignId, content)
    })()
    // 实名通过即开立存管子账户（绑卡前置条件）
    return escrow.openAccount({ ownerType: 'worker', ownerId: userId, name: realName })
      .then(acct => {
        db.prepare(`
          INSERT OR IGNORE INTO escrow_members (owner_type, owner_id, member_no, sub_acct_no) VALUES ('worker', ?, ?, ?)
        `).run(userId, acct.memberNo, acct.subAcctNo)
        return frameNo
      })
      .catch(() => frameNo) // 开户失败不阻塞实名（绑卡时补开）
  })
}

router.post('/verify', async (req, res, next) => {
  try {
    const body = verifySchema.parse(req.body)
    const p = getProfile(req.user.id)
    if (p.verified) throw conflict('ALREADY_VERIFIED', '已完成实名认证')
    if (secrets.idCardExists(body.idCard, req.user.id)) {
      throw conflict('IDCARD_EXISTS', '该身份证号已绑定其他账号，如有疑问请联系平台客服')
    }
    recordConsents(req.user.id, body.consents)

    const result = await realname.verify({ idCard: body.idCard, realName: body.realName })
    if (!result.pass) throw badRequest('REALNAME_FAILED', `实名核验未通过：${result.reason}`)

    // 人脸核身（生产开启）：返回 faceRequestId，由小程序拉起人脸 SDK 后回传结果
    if (getConfig('faceVerifyRequired')) {
      const face = await realname.faceStart({ idCard: body.idCard, realName: body.realName })
      db.prepare(`
        INSERT INTO user_settings (user_id, value) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET value = json_patch(user_settings.value, excluded.value), updated_at = datetime('now','localtime')
      `).run(req.user.id, JSON.stringify({
        pendingVerify: { faceRequestId: face.faceRequestId, idCard: body.idCard, realName: body.realName, bankCard: body.bankCard }
      }))
      return res.json({ verified: false, needFace: true, faceRequestId: face.faceRequestId })
    }

    const frameNo = await completeWorkerVerify(req.user.id, body)
    logAction(req.user.id, 'worker_verify', frameNo)
    res.json({ verified: true, frameContractNo: frameNo })
  } catch (err) {
    next(err)
  }
})

// 人脸核身结果回传（三段式第三步）：核验通过后完成签约开户
router.post('/verify/face-result', async (req, res, next) => {
  try {
    const { faceRequestId } = z.object({ faceRequestId: z.string().min(8) }).parse(req.body)
    const p = getProfile(req.user.id)
    if (p.verified) throw conflict('ALREADY_VERIFIED', '已完成实名认证')
    const settings = db.prepare(`SELECT value FROM user_settings WHERE user_id = ?`).get(req.user.id)
    const pending = settings ? JSON.parse(settings.value).pendingVerify : null
    if (!pending || pending.faceRequestId !== faceRequestId) {
      throw badRequest('BAD_FACE_REQUEST', '人脸核身会话无效或已过期，请重新发起实名认证')
    }
    const result = await realname.faceResult({ faceRequestId })
    if (!result.pass) throw badRequest('FACE_FAILED', `人脸核身未通过：${result.reason}`)

    const frameNo = await completeWorkerVerify(req.user.id, pending)
    db.prepare(`UPDATE worker_profiles SET face_verified = 1 WHERE user_id = ?`).run(req.user.id)
    // 清理暂存的待核验信息（含明文卡号），不留存
    const merged = JSON.parse(settings.value)
    delete merged.pendingVerify
    db.prepare(`UPDATE user_settings SET value = ? WHERE user_id = ?`).run(JSON.stringify(merged), req.user.id)
    logAction(req.user.id, 'worker_verify_face', frameNo)
    res.json({ verified: true, frameContractNo: frameNo })
  } catch (err) {
    next(err)
  }
})

// —— 绑提现卡（银行卡四要素核验 + 存管绑卡协议号，出金凭协议号不存卡号明文）——
router.post('/bank-card', async (req, res, next) => {
  try {
    const body = z.object({
      bankCard: z.string().regex(/^\d{15,19}$/, '银行卡号格式不正确'),
      phone: z.string().regex(/^1\d{10}$/, '银行预留手机号格式不正确'),
      smsCode: z.string().optional()
    }).parse(req.body)
    const p = getProfile(req.user.id)
    if (!p.verified) throw badRequest('NOT_VERIFIED', '请先完成实名认证')
    if (getConfig('withdrawSmsRequired')) {
      if (!body.smsCode) throw badRequest('SMS_REQUIRED', '请先获取并填写短信验证码')
      const u = db.prepare(`SELECT phone FROM users WHERE id = ?`).get(req.user.id)
      verifyCode(u.phone, 'bindcard', body.smsCode)
    }

    // 四要素核验（卡号+姓名+身份证+预留手机）：出金安全硬要求
    const idCard = secrets.readIdCard(req.user.id, req.user.id, 'bankcard_verify')
    const check = await realname.bankcardVerify({
      idCard: idCard ?? '', realName: p.real_name, bankCard: body.bankCard, phone: body.phone
    })
    if (!check.pass) throw badRequest('BANKCARD_FAILED', `银行卡核验未通过：${check.reason}`)

    let member = db.prepare(`SELECT * FROM escrow_members WHERE owner_type = 'worker' AND owner_id = ?`).get(req.user.id)
    if (!member) {
      const acct = await escrow.openAccount({ ownerType: 'worker', ownerId: req.user.id, name: p.real_name })
      db.prepare(`INSERT INTO escrow_members (owner_type, owner_id, member_no, sub_acct_no) VALUES ('worker', ?, ?, ?)`)
        .run(req.user.id, acct.memberNo, acct.subAcctNo)
      member = db.prepare(`SELECT * FROM escrow_members WHERE owner_type = 'worker' AND owner_id = ?`).get(req.user.id)
    }
    const bound = await escrow.bindCard({ memberNo: member.member_no, bankCard: body.bankCard, phone: body.phone })
    db.transaction(() => {
      db.prepare(`UPDATE escrow_members SET bind_card_token = ?, card_masked = ?, status = 'card_bound' WHERE id = ?`)
        .run(bound.bindCardToken, bound.cardMasked, member.id)
      db.prepare(`UPDATE worker_profiles SET bank_card_masked = ? WHERE user_id = ?`).run(bound.cardMasked, req.user.id)
    })()
    logAction(req.user.id, 'bank_card_bind', bound.cardMasked)
    res.json({ cardBound: true, bankCard: bound.cardMasked })
  } catch (err) {
    next(err)
  }
})

// —— 个体工商户登记（转入B线）——
router.post('/soletrader', (req, res, next) => {
  try {
    const { licenseNo } = z.object({ licenseNo: z.string().min(8, '请填写有效的统一社会信用代码').max(30) }).parse(req.body)
    const p = getProfile(req.user.id)
    if (!p.verified) throw badRequest('NOT_VERIFIED', '请先完成实名认证')
    if (p.subject_type === 'soletrader') throw conflict('ALREADY_SOLETRADER', '已登记为个体工商户')
    db.transaction(() => {
      db.prepare(`UPDATE worker_profiles SET subject_type = 'soletrader', locked = 0 WHERE user_id = ?`).run(req.user.id)
    })()
    logAction(req.user.id, 'soletrader_register', licenseNo)
    res.json({ subjectType: 'soletrader', locked: false })
  } catch (err) {
    next(err)
  }
})

// —— 基础数据字典（小程序启动拉取并缓存，避免类目/计酬方式/地点/工种写死与后端配置脱节）——
router.get('/meta', (_req, res) => {
  res.json({
    categories: getConfig('categories'),
    payMethods: getConfig('payMethods'),
    cities: getConfig('cities'),
    trades: getConfig('skillCatalog'),
    reviewTags: getConfig('reviewTags'),
    // 微信订阅消息模板ID（运营在小程序后台申请后填入；为空时小程序不弹订阅授权）
    subscribeTmplIds: getConfig('subscribeTmplIds')
  })
})

// —— 任务大厅 ——
const TASK_SORTS = {
  latest: 't.id DESC',
  price_desc: 't.price DESC, t.id DESC',
  price_asc: 't.price ASC, t.id DESC',
  applicants_asc: 'applicants ASC, t.id DESC'
}

router.get('/tasks', (req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const conds = [`t.status = 'recruiting'`]
  const params = []
  if (req.query.category) { conds.push(`t.category = ?`); params.push(req.query.category) }
  if (req.query.trade) { conds.push(`t.trade = ?`); params.push(req.query.trade) }
  if (req.query.city) { conds.push(`t.city = ?`); params.push(req.query.city) }
  if (req.query.keyword) {
    conds.push(`(t.title LIKE ? OR t.description LIKE ? OR t.standard LIKE ?)`)
    const kw = `%${req.query.keyword}%`
    params.push(kw, kw, kw)
  }
  if (req.query.payMethod) { conds.push(`t.pay_method = ?`); params.push(req.query.payMethod) }
  if (req.query.minPrice) { conds.push(`t.price >= ?`); params.push(yuanToCents(Number(req.query.minPrice))) }
  if (req.query.maxPrice) { conds.push(`t.price <= ?`); params.push(yuanToCents(Number(req.query.maxPrice))) }
  // 技能匹配：仅返回工种或类目命中本人「已认证技能」的任务（无已认证技能则忽略该筛选）
  if (req.query.matchSkills === '1' || req.query.matchSkills === 'true') {
    const skills = db.prepare(`SELECT skill FROM worker_skills WHERE worker_id = ? AND status = 'verified'`).all(req.user.id).map(s => s.skill)
    if (skills.length) {
      const ph = skills.map(() => '?').join(',')
      conds.push(`(t.trade IN (${ph}) OR t.category IN (${ph}))`)
      params.push(...skills, ...skills)
    }
  }
  const orderBy = TASK_SORTS[req.query.sort] || TASK_SORTS.latest
  const where = conds.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where}`).get(...params).n
  const list = db.prepare(`
    SELECT t.id, t.title, t.category, t.trade, t.city, t.price, t.pay_method, t.deadline, t.created_at,
           c.company_name,
           (SELECT COUNT(*) FROM applications a WHERE a.task_id = t.id AND a.status != 'withdrawn') AS applicants
    FROM tasks t JOIN companies c ON c.id = t.company_id
    WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)
  res.json({
    total,
    list: list.map(r => ({
      id: r.id, title: r.title, category: r.category, trade: r.trade ?? undefined, city: r.city,
      price: centsToYuan(r.price), payMethod: r.pay_method,
      deadline: r.deadline, expired: isExpired(r.deadline),
      companyName: r.company_name,
      applicants: r.applicants, createdAt: r.created_at
    }))
  })
})

router.get('/tasks/:id', (req, res, next) => {
  try {
    const t = db.prepare(`
      SELECT t.*, c.company_name FROM tasks t JOIN companies c ON c.id = t.company_id WHERE t.id = ?
    `).get(req.params.id)
    if (!t) throw notFound('任务不存在')
    const app = db.prepare(`SELECT status FROM applications WHERE task_id = ? AND worker_id = ?`).get(t.id, req.user.id)
    const est = taxEngine.estimateForWorker(req.user.id, t.sub_price)
    const favorited = !!db.prepare(`SELECT 1 FROM task_favorites WHERE worker_id = ? AND task_id = ?`).get(req.user.id, t.id)
    res.json({
      id: t.id, title: t.title, category: t.category, trade: t.trade ?? undefined, city: t.city,
      price: centsToYuan(t.price), payMethod: t.pay_method,
      deadline: t.deadline, expired: isExpired(t.deadline),
      description: t.description, standard: t.standard,
      status: t.status, companyName: t.company_name,
      applied: !!app && app.status !== 'withdrawn',
      favorited,
      applicants: db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE task_id = ? AND status != 'withdrawn'`).get(t.id).n,
      // 接单即按单投保（接单生效、交付终止），保费已含在平台成本中，零工免费享有
      insurance: insuranceFor(t.category),
      estimate: {
        gross: centsToYuan(est.gross),
        tax: centsToYuan(est.tax),
        vat: centsToYuan(est.vat),
        net: centsToYuan(est.net)
      }
    })
  } catch (err) {
    next(err)
  }
})

router.post('/tasks/:id/apply', (req, res, next) => {
  try {
    const p = getProfile(req.user.id)
    if (!p.verified) throw badRequest('NOT_VERIFIED', '请先完成实名认证并签署分包协议')
    if (p.locked) throw locked('已达市场主体强制登记阈值，自然人接单权限已锁定，请完成个体工商户登记')
    checkOrderLimit(req.user.id)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(req.params.id)
    if (!t) throw notFound('任务不存在')
    if (t.status !== 'recruiting') throw conflict('NOT_RECRUITING', '该任务已停止报名')
    if (isExpired(t.deadline)) throw conflict('EXPIRED', '该任务已过截止日期，停止报名')
    const dup = db.prepare(`SELECT * FROM applications WHERE task_id = ? AND worker_id = ?`).get(t.id, req.user.id)
    if (dup && dup.status !== 'withdrawn') throw conflict('ALREADY_APPLIED', '已报名该任务')
    if (dup) {
      db.prepare(`UPDATE applications SET status = 'applied' WHERE id = ?`).run(dup.id)
    } else {
      db.prepare(`INSERT INTO applications (task_id, worker_id) VALUES (?, ?)`).run(t.id, req.user.id)
    }
    res.status(201).json({ applied: true })
  } catch (err) {
    next(err)
  }
})

// 取消报名
router.post('/tasks/:id/withdraw-apply', (req, res, next) => {
  try {
    const app = db.prepare(`SELECT * FROM applications WHERE task_id = ? AND worker_id = ?`).get(req.params.id, req.user.id)
    if (!app || app.status === 'withdrawn') throw notFound('未报名该任务')
    if (app.status === 'hired') throw conflict('ALREADY_HIRED', '已被录用，不可取消报名')
    db.prepare(`UPDATE applications SET status = 'withdrawn' WHERE id = ?`).run(app.id)
    res.json({ withdrawn: true })
  } catch (err) {
    next(err)
  }
})

// —— 我的收藏（任务大厅收藏/取消，便于零工回看心仪任务）——
router.get('/favorites', (req, res) => {
  const list = db.prepare(`
    SELECT t.id, t.title, t.category, t.trade, t.city, t.price, t.pay_method, t.deadline, t.status, c.company_name, f.created_at AS fav_at
    FROM task_favorites f JOIN tasks t ON t.id = f.task_id JOIN companies c ON c.id = t.company_id
    WHERE f.worker_id = ? ORDER BY f.id DESC LIMIT 100
  `).all(req.user.id)
  res.json({
    total: list.length,
    list: list.map(t => ({
      id: t.id, title: t.title, category: t.category, trade: t.trade ?? undefined, city: t.city,
      price: centsToYuan(t.price), payMethod: t.pay_method, deadline: t.deadline,
      status: t.status, expired: isExpired(t.deadline), recruiting: t.status === 'recruiting',
      companyName: t.company_name, favoritedAt: t.fav_at
    }))
  })
})

router.post('/favorites/:taskId', (req, res, next) => {
  try {
    const t = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(req.params.taskId)
    if (!t) throw notFound('任务不存在')
    db.prepare(`INSERT OR IGNORE INTO task_favorites (worker_id, task_id) VALUES (?, ?)`).run(req.user.id, t.id)
    res.status(201).json({ favorited: true })
  } catch (err) {
    next(err)
  }
})

router.delete('/favorites/:taskId', (req, res) => {
  db.prepare(`DELETE FROM task_favorites WHERE worker_id = ? AND task_id = ?`).run(req.user.id, req.params.taskId)
  res.json({ favorited: false })
})

// —— 派单邀约（企业定向派单，接受后成立承揽关系）——
router.get('/dispatches', (req, res) => {
  const list = db.prepare(`
    SELECT d.id, d.task_id, d.status, d.note, d.created_at, d.responded_at,
           t.title, t.category, t.sub_price, t.pay_method, t.deadline, t.status AS task_status,
           c.company_name
    FROM dispatches d JOIN tasks t ON t.id = d.task_id JOIN companies c ON c.id = d.company_id
    WHERE d.worker_id = ? ORDER BY d.id DESC LIMIT 50
  `).all(req.user.id)
  res.json({
    total: list.length,
    list: list.map(d => {
      const est = taxEngine.estimateForWorker(req.user.id, d.sub_price)
      return {
        id: d.id, taskId: d.task_id, status: d.status, note: d.note,
        title: d.title, category: d.category, payMethod: d.pay_method,
        subPrice: centsToYuan(d.sub_price), deadline: d.deadline,
        taskStatus: d.task_status, companyName: d.company_name,
        expired: isExpired(d.deadline),
        estimate: { gross: centsToYuan(est.gross), tax: centsToYuan(est.tax), vat: centsToYuan(est.vat), net: centsToYuan(est.net) },
        createdAt: d.created_at, respondedAt: d.responded_at
      }
    })
  })
})

// 接受派单 → 与"被企业录用"同一落地（签分包工单 + 投保 + 任务转 working）
router.post('/dispatches/:id/accept', async (req, res, next) => {
  try {
    const p = getProfile(req.user.id)
    if (!p.verified) throw badRequest('NOT_VERIFIED', '请先完成实名认证并签署分包协议')
    if (p.locked) throw locked('已达市场主体强制登记阈值，自然人接单权限已锁定，请完成个体工商户登记')
    checkOrderLimit(req.user.id)
    const d = db.prepare(`SELECT * FROM dispatches WHERE id = ? AND worker_id = ?`).get(req.params.id, req.user.id)
    if (!d) throw notFound('派单邀约不存在')
    if (d.status !== 'invited') throw conflict('BAD_STATUS', '该派单邀约已处理或已失效')
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(d.task_id)
    if (!t) throw notFound('任务不存在')
    if (t.status !== 'recruiting') throw conflict('NOT_RECRUITING', '该任务已停止招募')
    if (isExpired(t.deadline)) throw conflict('EXPIRED', '该任务已过截止日期')
    const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(d.company_id)

    const result = await hireWorker(t, c, req.user.id)
    db.prepare(`UPDATE dispatches SET status = 'accepted', responded_at = datetime('now','localtime') WHERE id = ?`).run(d.id)
    logAction(req.user.id, 'dispatch_accept', `dispatch#${d.id} task#${t.id}`)
    notifyCompany(c.id, 'hired', '派单已被接受', `零工已接受「${t.title}」的派单，分包工单 ${result.workOrderNo} 已电子签，任务进入进行中。`)
    res.json({ accepted: true, ...result })
  } catch (err) {
    next(err)
  }
})

// 拒绝派单（任务保持报名中，企业可改派他人或开放报名）
router.post('/dispatches/:id/reject', (req, res, next) => {
  try {
    const { reason } = z.object({
      reason: readableText('拒绝理由', z.string().max(200).optional().default(''))
    }).parse(req.body)
    const d = db.prepare(`SELECT * FROM dispatches WHERE id = ? AND worker_id = ?`).get(req.params.id, req.user.id)
    if (!d) throw notFound('派单邀约不存在')
    if (d.status !== 'invited') throw conflict('BAD_STATUS', '该派单邀约已处理或已失效')
    db.prepare(`UPDATE dispatches SET status = 'rejected', reject_reason = ?, responded_at = datetime('now','localtime') WHERE id = ?`).run(reason, d.id)
    const t = db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(d.task_id)
    logAction(req.user.id, 'dispatch_reject', `dispatch#${d.id} task#${d.task_id}`)
    notifyCompany(d.company_id, 'cancelled', '派单被拒绝', `零工拒绝了「${t?.title || ''}」的派单${reason ? `：${reason}` : ''}。可改派其他零工或等待报名。`)
    res.json({ rejected: true })
  } catch (err) {
    next(err)
  }
})

// —— 我的接单 ——
router.get('/orders', (req, res) => {
  const list = db.prepare(`
    SELECT t.*, c.company_name FROM tasks t JOIN companies c ON c.id = t.company_id
    WHERE t.worker_id = ? ORDER BY t.id DESC
  `).all(req.user.id)
  res.json({
    total: list.length,
    list: list.map(t => ({
      id: t.id, title: t.title, category: t.category,
      price: centsToYuan(t.price), subPrice: centsToYuan(t.sub_price),
      payMethod: t.pay_method, status: t.status,
      workOrderNo: t.sub_order_no, policyNo: t.policy_no,
      deliverable: t.deliverable, confirmNo: t.confirm_no,
      deadline: t.deadline, companyName: t.company_name,
      attachments: taskAttachments(t.id)
    }))
  })
})

// 交付（可携带附件）
router.post('/orders/:id/deliver', (req, res, next) => {
  try {
    const { note, attachmentIds } = z.object({
      note: readableText('交付说明', z.string().min(1, '请填写交付说明').max(500)),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    }).parse(req.body)
    const t = db.prepare(`SELECT t.*, c.id AS cid, c.company_name FROM tasks t JOIN companies c ON c.id = t.company_id WHERE t.id = ? AND t.worker_id = ?`)
      .get(req.params.id, req.user.id)
    if (!t) throw notFound('工单不存在')
    if (t.status !== 'working') throw conflict('BAD_STATUS', '当前状态不可交付')

    db.transaction(() => {
      db.prepare(`
        UPDATE tasks SET status = 'delivered', deliverable = ?, delivered_at = datetime('now','localtime') WHERE id = ?
      `).run(note, t.id)
      const link = db.prepare(`INSERT INTO task_attachments (task_id, upload_id, kind) VALUES (?, ?, 'deliverable')`)
      for (const uid of attachmentIds) {
        const owned = db.prepare(`SELECT 1 FROM uploads WHERE id = ? AND owner_id = ?`).get(uid, req.user.id)
        if (!owned) throw badRequest('BAD_ATTACHMENT', '附件不存在或不属于当前用户')
        link.run(t.id, uid)
      }
    })()

    notifyCompany(t.cid, 'deliver', '交付物待验收', `「${t.title}」零工已上传交付物，请及时验收。`)
    res.json({ status: 'delivered' })
  } catch (err) {
    next(err)
  }
})

// B线个体户：向平台上传发票（结算前置硬校验的凭证；结构化入进项台账供认证与进项看板）
router.post('/orders/:id/invoice', (req, res, next) => {
  try {
    const body = z.object({
      uploadId: z.string().uuid(),
      invoiceNo: z.string().min(8, '请填写发票号码').max(30).optional(),
      amount: z.number().positive().optional(),
      taxAmount: z.number().min(0).optional(),
      invoiceType: z.enum(['normal', 'special']).optional().default('normal')
    }).parse(req.body)
    const p = getProfile(req.user.id)
    if (p.subject_type !== 'soletrader') throw badRequest('NOT_SOLETRADER', '仅个体工商户（B线）需上传发票')
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND worker_id = ?`).get(req.params.id, req.user.id)
    if (!t) throw notFound('工单不存在')
    if (!['working', 'delivered'].includes(t.status)) throw conflict('BAD_STATUS', '当前状态不可上传发票')
    const owned = db.prepare(`SELECT 1 FROM uploads WHERE id = ? AND owner_id = ?`).get(body.uploadId, req.user.id)
    if (!owned) throw badRequest('BAD_ATTACHMENT', '附件不存在或不属于当前用户')
    db.transaction(() => {
      db.prepare(`INSERT INTO task_attachments (task_id, upload_id, kind) VALUES (?, ?, 'invoice')`).run(t.id, body.uploadId)
      db.prepare(`
        INSERT INTO input_invoices (worker_id, task_id, upload_id, invoice_no, amount, tax_amount, invoice_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, t.id, body.uploadId, body.invoiceNo ?? `待补录-${t.id}`,
        body.amount ? yuanToCents(body.amount) : t.sub_price,
        body.taxAmount ? yuanToCents(body.taxAmount) : 0, body.invoiceType)
    })()
    logAction(req.user.id, 'upload_input_invoice', `task#${t.id} ${body.invoiceNo ?? ''}`)
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// B线个体户：我的进项发票台账（上传状态/认证结果，配合"个体户专区"展示）
router.get('/invoices', (req, res) => {
  const list = db.prepare(`
    SELECT i.*, t.title FROM input_invoices i JOIN tasks t ON t.id = i.task_id
    WHERE i.worker_id = ? ORDER BY i.id DESC LIMIT 100
  `).all(req.user.id)
  const STATUS_LABEL = { uploaded: '待认证', verified: '已认证', rejected: '已退回', deducted: '已抵扣' }
  res.json({
    total: list.length,
    list: list.map(i => ({
      id: i.id, taskId: i.task_id, taskTitle: i.title, invoiceNo: i.invoice_no,
      amount: centsToYuan(i.amount), taxAmount: centsToYuan(i.tax_amount),
      invoiceType: i.invoice_type === 'special' ? '增值税专用发票' : '增值税普通发票',
      status: i.status, statusLabel: STATUS_LABEL[i.status] || i.status,
      verifyNote: i.verify_note, createdAt: i.created_at
    }))
  })
})

// —— 争议：发起（验收争议/超期未验收等，详见《争议处理规则》）——
router.post('/orders/:id/dispute', (req, res, next) => {
  try {
    const body = z.object({
      type: z.enum(['acceptance', 'payment_overdue', 'other']),
      claim: readableText('诉求描述', z.string().min(10, '请描述诉求（不少于10个字）').max(1000)),
      claimAmount: z.number().min(0).optional().default(0),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND worker_id = ?`).get(req.params.id, req.user.id)
    if (!t) throw notFound('工单不存在')
    const r = createDispute({
      task: t, type: body.type, initiatorRole: 'worker', initiatorId: req.user.id,
      claim: body.claim, claimAmount: yuanToCents(body.claimAmount), attachmentIds: body.attachmentIds
    })
    logAction(req.user.id, 'dispute_create', `${r.no} task#${t.id}`)
    res.status(201).json(r)
  } catch (err) {
    next(err)
  }
})

// —— 评价（结算后互盲互评）——
router.post('/orders/:id/review', (req, res, next) => {
  try {
    const body = z.object({
      score: z.number().int().min(1).max(5),
      tags: z.array(z.string()).max(6).optional().default([]),
      comment: readableText('评价内容', z.string().max(300).optional().default(''))
    }).parse(req.body)
    submitReview({
      taskId: Number(req.params.id), reviewerRole: 'worker', reviewerId: req.user.id,
      score: body.score, tags: body.tags, comment: body.comment
    })
    logAction(req.user.id, 'review_submit', `task#${req.params.id} score=${body.score}`)
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.get('/orders/:id/reviews', (req, res, next) => {
  try {
    const t = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND worker_id = ?`).get(req.params.id, req.user.id)
    if (!t) throw notFound('工单不存在')
    res.json(getTaskReviews(Number(req.params.id), 'worker'))
  } catch (err) {
    next(err)
  }
})

// —— 技能认证（证书上传，运营人工审核后展示徽章）——
router.get('/skills', (req, res) => {
  const list = db.prepare(`SELECT * FROM worker_skills WHERE worker_id = ? ORDER BY id DESC`).all(req.user.id)
  res.json({
    catalog: getConfig('skillCatalog'),
    list: list.map(s => ({
      id: s.id, skill: s.skill, level: s.level, status: s.status,
      verifyNote: s.verify_note, createdAt: s.created_at
    }))
  })
})

router.post('/skills', (req, res, next) => {
  try {
    const body = z.object({
      skill: readableText('技能', z.string().min(2).max(30)),
      level: z.enum(['初级', '中级', '高级']).optional().default('初级'),
      certUploadId: z.string().uuid().optional()
    }).parse(req.body)
    const catalog = getConfig('skillCatalog')
    if (!catalog.includes(body.skill)) throw badRequest('BAD_SKILL', `技能仅支持：${catalog.join('/')}`)
    if (body.certUploadId) {
      const owned = db.prepare(`SELECT 1 FROM uploads WHERE id = ? AND owner_id = ?`).get(body.certUploadId, req.user.id)
      if (!owned) throw badRequest('BAD_ATTACHMENT', '证书附件不存在或不属于当前用户')
    }
    const exists = db.prepare(`SELECT 1 FROM worker_skills WHERE worker_id = ? AND skill = ?`).get(req.user.id, body.skill)
    if (exists) throw conflict('SKILL_EXISTS', '该技能已提交认证')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO worker_skills (worker_id, skill, level, cert_upload_id) VALUES (?, ?, ?, ?)
    `).run(req.user.id, body.skill, body.level, body.certUploadId ?? null)
    logAction(req.user.id, 'skill_apply', `${body.skill}/${body.level}`)
    res.status(201).json({ id: lastInsertRowid, status: 'pending' })
  } catch (err) {
    next(err)
  }
})

// —— 收入与税务 ——
router.get('/income', (req, res) => {
  const acc = accounts.getAccount('worker', req.user.id)
  const p = getProfile(req.user.id)
  const year = String(new Date().getFullYear())
  const period = currentPeriod()
  const ys = taxEngine.yearStats(req.user.id, year)
  const sales = taxEngine.monthSales(req.user.id, period)
  const monthlyDeduction = getConfig('monthlyDeduction')
  // 连续接单月份数（含本月）：依16号公告累计预扣，断月后重新起算
  const consecutiveMonths = taxEngine.consecutiveMonths(req.user.id, period)
  const records = db.prepare(`
    SELECT r.*, t.title FROM tax_records r JOIN tasks t ON t.id = r.task_id
    WHERE r.worker_id = ? ORDER BY r.id DESC LIMIT 100
  `).all(req.user.id)
  // 个体户登记引导：自然人本月收入达阈值即提示转 B 线（经营所得，平台不代扣、自行申报、享进项）
  const monthGross = db.prepare(`SELECT COALESCE(SUM(gross), 0) AS g FROM tax_records WHERE worker_id = ? AND period = ?`)
    .get(req.user.id, period).g
  const guideThreshold = getConfig('soletraderGuideMonthGross')
  const soletraderGuide = {
    subjectType: p.subject_type,
    monthGross: centsToYuan(monthGross),
    threshold: guideThreshold,
    // 自然人且本月收入达阈值 → 建议登记个体户
    suggest: p.subject_type === 'person' && centsToYuan(monthGross) >= guideThreshold,
    note: p.subject_type === 'soletrader'
      ? '您已是个体工商户（B线）：平台不代扣个税，结算前需向平台开具发票，经营所得自行申报。'
      : `本月收入达 ¥${guideThreshold} 时建议登记个体工商户转入B线：可享进项抵扣、按经营所得核定/查账征收，长期高收入更省税。`
  }
  res.json({
    account: {
      balance: centsToYuan(acc.balance - acc.frozen),
      frozen: centsToYuan(acc.frozen)
    },
    subjectType: p.subject_type,
    soletraderGuide,
    taxSummary: {
      yearGross: centsToYuan(ys.gross),
      yearTax: centsToYuan(ys.tax),
      months: ys.months,
      consecutiveMonths,
      // 本连续段累计已享减除费用 = 5000 × 连续月份数
      cumulativeDeduction: consecutiveMonths * monthlyDeduction,
      monthSales: centsToYuan(sales),
      vatFree: sales <= getConfig('vatFreeMonthlySales') * 100,
      taxNote: `按本平台收入累计预扣（劳务报酬）：连续接单 ${consecutiveMonths} 个月，已累计扣除减除费用 ¥${consecutiveMonths * monthlyDeduction}（5000元/月）。某月无接单收入将中断连续、下月重新起算。此为预扣口径，年度汇算清缴以个人申报为准。`
    },
    records: records.map(r => ({
      id: r.id, taskTitle: r.title,
      gross: centsToYuan(r.gross), tax: centsToYuan(r.tax),
      vat: centsToYuan(r.vat), net: centsToYuan(r.net),
      period: r.period, taxVoucherNo: r.tax_voucher_no, createdAt: r.created_at
    }))
  })
})

// 提现：创建申请单并冻结金额，由提现 Job 完成银行出金（T+1），失败自动解冻退回。
// 出金凭存管绑卡协议号（member_no）执行；生产开启 withdrawSmsRequired 后强制短信验证码。
router.post('/withdraw', (req, res, next) => {
  try {
    const { amount, smsCode } = z.object({
      amount: z.number().positive('金额须大于0'),
      smsCode: z.string().optional()
    }).parse(req.body)
    if (getConfig('withdrawalPaused')) throw conflict('WITHDRAWAL_PAUSED', '提现通道维护中，请稍后再试')
    const p = getProfile(req.user.id)
    if (!p.verified) throw badRequest('NOT_VERIFIED', '请先完成实名认证')
    if (getConfig('withdrawSmsRequired')) {
      if (!smsCode) throw badRequest('SMS_REQUIRED', '请先获取并填写短信验证码')
      const u = db.prepare(`SELECT phone FROM users WHERE id = ?`).get(req.user.id)
      verifyCode(u.phone, 'withdraw', smsCode)
    }
    const member = db.prepare(`SELECT * FROM escrow_members WHERE owner_type = 'worker' AND owner_id = ?`).get(req.user.id)
    const cents = yuanToCents(amount)
    const acc = accounts.getAccount('worker', req.user.id)
    if (acc.balance - acc.frozen < cents) throw badRequest('INSUFFICIENT_BALANCE', '可提现余额不足')

    const withdrawalId = db.transaction(() => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO withdrawals (worker_id, amount, bank_card, member_no) VALUES (?, ?, ?, ?)
      `).run(req.user.id, cents, member?.card_masked ?? p.bank_card_masked, member?.member_no ?? null)
      accounts.freezeRef('worker', req.user.id, cents, 'withdrawal', lastInsertRowid, `提现申请冻结 WD${lastInsertRowid}`)
      return lastInsertRowid
    })()

    logAction(req.user.id, 'withdraw_apply', `WD${withdrawalId} ¥${amount}`)
    // 反洗钱：大额/高频/夜间提现监测
    const uname = db.prepare(`SELECT name FROM users WHERE id = ?`).get(req.user.id).name
    amlChecks({ workerId: req.user.id, workerName: uname, amountCents: cents, kind: 'withdraw' })
    const after = accounts.getAccount('worker', req.user.id)
    res.status(201).json({
      id: withdrawalId,
      status: 'applied',
      balance: centsToYuan(after.balance - after.frozen)
    })
  } catch (err) {
    next(err)
  }
})

// 提现记录
router.get('/withdrawals', (req, res) => {
  const list = db.prepare(`SELECT * FROM withdrawals WHERE worker_id = ? ORDER BY id DESC LIMIT 50`).all(req.user.id)
  res.json({
    total: list.length,
    list: list.map(w => ({
      id: w.id, amount: centsToYuan(w.amount), bankCard: w.bank_card,
      status: w.status, failReason: w.fail_reason, createdAt: w.created_at, doneAt: w.done_at
    }))
  })
})

// —— 我的合同（分包协议与全部分包工单，含正文）——
router.get('/contracts', (req, res) => {
  const list = db.prepare(`
    SELECT ct.*, t.title FROM contracts ct LEFT JOIN tasks t ON t.id = ct.task_id
    WHERE ct.worker_id = ? ORDER BY ct.id DESC
  `).all(req.user.id)
  res.json({
    total: list.length,
    list: list.map(x => ({
      id: x.id, type: x.type, no: x.no, taskTitle: x.title,
      signedAt: x.signed_at, hasContent: !!x.content
    }))
  })
})

router.get('/contracts/:id', (req, res, next) => {
  try {
    const x = db.prepare(`SELECT ct.*, t.title FROM contracts ct LEFT JOIN tasks t ON t.id = ct.task_id WHERE ct.id = ? AND ct.worker_id = ?`)
      .get(req.params.id, req.user.id)
    if (!x) throw notFound('合同不存在')
    res.json({
      id: x.id, type: x.type, no: x.no, taskTitle: x.title,
      signedAt: x.signed_at, contentHash: x.content_hash, content: x.content
    })
  } catch (err) {
    next(err)
  }
})

// —— 保险理赔（一键报案）——
router.post('/claims', (req, res, next) => {
  try {
    const { taskId, description } = z.object({
      taskId: z.number().int().positive(),
      description: readableText('事故经过', z.string().min(5, '请描述事故经过（不少于5个字）').max(1000))
    }).parse(req.body)
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND worker_id = ?`).get(taskId, req.user.id)
    if (!t) throw notFound('工单不存在')
    if (!t.policy_no) throw badRequest('NO_POLICY', '该任务无关联保单')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO claims (policy_no, task_id, worker_id, description) VALUES (?, ?, ?, ?)
    `).run(t.policy_no, t.id, req.user.id, description)
    logAction(req.user.id, 'claim_report', `claim#${lastInsertRowid} policy=${t.policy_no}`)
    res.status(201).json({ id: lastInsertRowid, status: 'reported', policyNo: t.policy_no })
  } catch (err) {
    next(err)
  }
})

router.get('/claims', (req, res) => {
  const list = db.prepare(`
    SELECT cl.*, t.title FROM claims cl JOIN tasks t ON t.id = cl.task_id
    WHERE cl.worker_id = ? ORDER BY cl.id DESC
  `).all(req.user.id)
  const CLAIM_LABEL = { reported: '已报案', processing: '处理中', closed: '已结案' }
  res.json({
    total: list.length,
    list: list.map(x => ({
      id: x.id, taskTitle: x.title, policyNo: x.policy_no, description: x.description,
      status: x.status, statusLabel: CLAIM_LABEL[x.status] || x.status,
      result: x.result, createdAt: x.created_at, closedAt: x.closed_at
    }))
  })
})

// 我的保单（按单意外险，接单生效、交付终止；附本单是否已报案）
router.get('/policies', (req, res) => {
  const list = db.prepare(`
    SELECT ip.*, t.title, t.status AS task_status,
           (SELECT COUNT(*) FROM claims cl WHERE cl.task_id = ip.task_id AND cl.worker_id = ip.worker_id) AS claim_count
    FROM insurance_policies ip JOIN tasks t ON t.id = ip.task_id
    WHERE ip.worker_id = ? ORDER BY ip.id DESC LIMIT 100
  `).all(req.user.id)
  res.json({
    total: list.length,
    list: list.map(p => ({
      id: p.id, policyNo: p.policy_no, taskId: p.task_id, taskTitle: p.title,
      plan: p.plan, premium: centsToYuan(p.premium), status: p.status,
      taskStatus: p.task_status, hasClaim: p.claim_count > 0,
      active: p.task_status === 'working', createdAt: p.created_at
    }))
  })
})

// 近6个月收入汇总（小程序图表用）
router.get('/income/monthly', (req, res) => {
  const rows = db.prepare(`
    SELECT period, SUM(gross) AS gross, SUM(net) AS net, COUNT(*) AS orders
    FROM tax_records WHERE worker_id = ?
    GROUP BY period ORDER BY period DESC LIMIT 6
  `).all(req.user.id)
  res.json({
    list: rows.reverse().map(r => ({
      period: r.period, gross: centsToYuan(r.gross), net: centsToYuan(r.net), orders: r.orders
    }))
  })
})

router.get('/tax/voucher', (req, res) => {
  const year = String(req.query.year || new Date().getFullYear() - 1)
  const items = db.prepare(`
    SELECT r.period, r.gross, r.tax, r.income_type, r.consecutive_months, t.title FROM tax_records r JOIN tasks t ON t.id = r.task_id
    WHERE r.worker_id = ? AND r.period LIKE ? AND r.method = 'cumulative' ORDER BY r.period
  `).all(req.user.id, `${year}-%`)
  const INCOME_LABEL = { labor_continuous: '劳务报酬(连续性劳务)', labor_other: '劳务报酬', business: '经营所得' }
  res.json({
    year,
    incomeItem: '劳务报酬所得',
    taxMethod: '累计预扣法',
    totalGross: centsToYuan(items.reduce((s, i) => s + i.gross, 0)),
    totalTax: centsToYuan(items.reduce((s, i) => s + i.tax, 0)),
    items: items.map(i => ({
      period: i.period, taskTitle: i.title, gross: centsToYuan(i.gross), tax: centsToYuan(i.tax),
      incomeType: INCOME_LABEL[i.income_type] || '劳务报酬', consecutiveMonths: i.consecutive_months
    }))
  })
})

export default router
