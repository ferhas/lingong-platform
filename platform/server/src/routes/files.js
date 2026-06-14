// 文件上传与下载：UUID 主键防遍历，mime 白名单 + 大小限制，下载按归属鉴权
import { Router } from 'express'
import multer from 'multer'
import db from '../db.js'
import config from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { getMembership } from '../middleware/rbac.js'
import { badRequest, notFound, forbidden } from '../utils/errors.js'
import * as storage from '../services/storage.js'

const router = Router()
router.use(authenticate)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploadMaxBytes }
})

// 内容嗅探：把白名单 MIME 映射到预期文件头类别；二进制类型上传时强制校验 magic number。
const MIME_KIND = {
  'image/jpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/msword': 'ole', 'application/vnd.ms-excel': 'ole',
  'text/plain': 'text'
}
function detectKind(b) {
  if (!b || b.length < 4) return null
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf' // %PDF
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip' // PK：zip/docx/xlsx
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole' // doc/xls(OLE)
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp' // RIFF....WEBP
  return null
}
// 仅图片与 PDF 允许浏览器内联预览，其余强制下载隔离
const INLINE_OK = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'])

router.post('/', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) throw badRequest('NO_FILE', '未收到文件（字段名应为 file）')
    if (!config.uploadMimeWhitelist.includes(req.file.mimetype)) {
      throw badRequest('MIME_FORBIDDEN', `不支持的文件类型：${req.file.mimetype}`)
    }
    // magic number 校验：二进制类型必须命中对应文件头，杜绝伪造 MIME（声明图片/PDF 实则脚本/可执行文件）
    const expectedKind = MIME_KIND[req.file.mimetype]
    if (expectedKind && expectedKind !== 'text' && detectKind(req.file.buffer) !== expectedKind) {
      throw badRequest('MIME_MISMATCH', '文件内容与声明的类型不符，疑似伪造文件类型')
    }
    const saved = storage.save(req.file.buffer, req.file.originalname)
    db.prepare(`
      INSERT INTO uploads (id, owner_id, original_name, mime, size, path, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(saved.id, req.user.id, req.file.originalname, req.file.mimetype, req.file.size, saved.storedPath, saved.sha256)
    res.status(201).json({
      id: saved.id,
      name: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      url: `/api/v1/files/${saved.id}`
    })
  } catch (err) {
    next(err)
  }
})

/** 归属鉴权：上传者本人 / 运营 / 文件所关联任务的承接零工或发布企业成员 / 同一争议的当事方 */
function canAccess(file, user) {
  if (file.owner_id === user.id || user.role === 'admin') return true
  const tasks = db.prepare(`
    SELECT t.worker_id, t.company_id FROM task_attachments a JOIN tasks t ON t.id = a.task_id
    WHERE a.upload_id = ?
  `).all(file.id)
  if (user.role === 'worker' && tasks.some(t => t.worker_id === user.id)) return true
  if (user.role === 'company') {
    const m = getMembership(user.id)
    if (m && tasks.some(t => t.company_id === m.company_id)) return true
  }
  // 争议举证附件仅存于 dispute_events.attachment_ids（从不写入 task_attachments）：
  // 放行同一争议的当事方下载对方提交的证据，与 me.js 争议时间线 URL 可见性一致（修复"看得到链接却 403"）。
  return canAccessViaDispute(file.id, user)
}

/** 该文件是否为某争议的举证附件，且 user 是该争议当事方（任务承接零工 / 发布企业成员） */
function canAccessViaDispute(fileId, user) {
  if (user.role !== 'worker' && user.role !== 'company') return false
  const rows = db.prepare(`
    SELECT t.worker_id, t.company_id FROM dispute_events de
    JOIN disputes d ON d.id = de.dispute_id JOIN tasks t ON t.id = d.task_id
    WHERE de.attachment_ids LIKE ?
  `).all(`%"${fileId}"%`)
  if (!rows.length) return false
  if (user.role === 'worker') return rows.some(r => r.worker_id === user.id)
  const m = getMembership(user.id)
  return !!m && rows.some(r => r.company_id === m.company_id)
}

router.get('/:id', (req, res, next) => {
  try {
    const row = db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(req.params.id)
    if (!row) throw notFound('文件不存在')
    if (!canAccess(row, req.user)) throw forbidden('无权访问该文件')
    res.setHeader('Content-Type', row.mime)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // 仅图片与 PDF 允许内联预览，其余强制 attachment 下载隔离（纵深防御，配合 nosniff + 强制 Content-Type）
    const disposition = INLINE_OK.has(row.mime) ? 'inline' : 'attachment'
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`)
    res.sendFile(storage.resolvePath(row.path))
  } catch (err) {
    next(err)
  }
})

export default router
