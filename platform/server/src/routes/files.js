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

router.post('/', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) throw badRequest('NO_FILE', '未收到文件（字段名应为 file）')
    if (!config.uploadMimeWhitelist.includes(req.file.mimetype)) {
      throw badRequest('MIME_FORBIDDEN', `不支持的文件类型：${req.file.mimetype}`)
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

/** 归属鉴权：上传者本人 / 运营 / 文件所关联任务的承接零工或发布企业成员 */
function canAccess(file, user) {
  if (file.owner_id === user.id || user.role === 'admin') return true
  const tasks = db.prepare(`
    SELECT t.worker_id, t.company_id FROM task_attachments a JOIN tasks t ON t.id = a.task_id
    WHERE a.upload_id = ?
  `).all(file.id)
  if (!tasks.length) return false
  if (user.role === 'worker') return tasks.some(t => t.worker_id === user.id)
  if (user.role === 'company') {
    const m = getMembership(user.id)
    return !!m && tasks.some(t => t.company_id === m.company_id)
  }
  return false
}

router.get('/:id', (req, res, next) => {
  try {
    const row = db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(req.params.id)
    if (!row) throw notFound('文件不存在')
    if (!canAccess(row, req.user)) throw forbidden('无权访问该文件')
    res.setHeader('Content-Type', row.mime)
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`)
    res.sendFile(storage.resolvePath(row.path))
  } catch (err) {
    next(err)
  }
})

export default router
