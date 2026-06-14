const api = require('../../utils/api.js')

// 按工种结构化交付页：进页拉取该工单的交付模板，动态渲染「要填字段 + 要传材料」。
Page({
  data: {
    orderId: 0,
    title: '',
    category: '',
    trade: '',
    standard: '',
    loading: true,
    submitting: false,
    fields: [],   // [{key,label,type,required,max,min,unit,options,placeholder,value,date,time,optionIndex}]
    uploads: []   // [{key,label,accept,required,min,max,hint,files:[{id,name}]}]
  },

  onLoad(q) {
    this.setData({ orderId: q.id, title: decodeURIComponent(q.title || '') })
    this.loadSpec()
  },

  async loadSpec() {
    this.setData({ loading: true })
    try {
      const d = await api.get(`/worker/orders/${this.data.orderId}/deliver-spec`)
      const fields = (d.spec.fields || []).map(f => ({
        key: f.key, label: f.label, type: f.type, required: !!f.required,
        max: f.max, min: f.min, unit: f.unit || '', options: f.options || [],
        placeholder: f.placeholder || '', value: '', date: '', time: '', optionIndex: 0
      }))
      const uploads = (d.spec.uploads || []).map(u => ({
        key: u.key, label: u.label, accept: u.accept, required: !!u.required,
        min: u.min || 0, max: u.max || 9, hint: u.hint || '', files: []
      }))
      this.setData({ category: d.category, trade: d.trade || '', standard: d.standard || '', fields, uploads })
    } catch (e) {
    } finally {
      this.setData({ loading: false })
    }
  },

  onFieldInput(e) {
    this.setData({ [`fields[${e.currentTarget.dataset.index}].value`]: e.detail.value })
  },

  onSelectChange(e) {
    const i = e.currentTarget.dataset.index
    const idx = Number(e.detail.value)
    this.setData({ [`fields[${i}].optionIndex`]: idx, [`fields[${i}].value`]: this.data.fields[i].options[idx] })
  },

  onFieldDate(e) {
    const i = e.currentTarget.dataset.index
    this.setData({ [`fields[${i}].value`]: e.detail.value })
  },

  onDateChange(e) {
    const i = e.currentTarget.dataset.index
    this.setDateTime(i, e.detail.value, this.data.fields[i].time)
  },

  onTimeChange(e) {
    const i = e.currentTarget.dataset.index
    this.setDateTime(i, this.data.fields[i].date, e.detail.value)
  },

  setDateTime(i, date, time) {
    this.setData({
      [`fields[${i}].date`]: date,
      [`fields[${i}].time`]: time,
      [`fields[${i}].value`]: date && time ? `${date} ${time}` : ''
    })
  },

  onChooseUpload(e) {
    const i = e.currentTarget.dataset.index
    const u = this.data.uploads[i]
    const remaining = u.max - u.files.length
    if (remaining <= 0) return wx.showToast({ title: `最多上传 ${u.max} 个`, icon: 'none' })
    if (u.accept === 'image') {
      wx.chooseImage({
        count: Math.min(remaining, 9),
        success: r => this.uploadAll(i, r.tempFilePaths.map(p => ({ path: p, name: (p.split('/').pop() || 'image.jpg') })))
      })
    } else if (u.accept === 'video') {
      wx.chooseMedia({
        count: Math.min(remaining, 9), mediaType: ['video'],
        success: r => this.uploadAll(i, r.tempFiles.map(f => ({ path: f.tempFilePath, name: 'video.mp4' })))
      })
    } else {
      wx.chooseMessageFile({
        count: remaining,
        success: r => this.uploadAll(i, r.tempFiles.map(f => ({ path: f.path, name: f.name })))
      })
    }
  },

  async uploadAll(i, items) {
    if (!items.length) return
    wx.showLoading({ title: '上传中…' })
    try {
      const files = this.data.uploads[i].files.slice()
      for (const it of items) {
        const up = await api.upload(it.path, it.name)
        files.push({ id: up.id, name: it.name })
      }
      this.setData({ [`uploads[${i}].files`]: files })
    } catch (err) {
    } finally {
      wx.hideLoading()
    }
  },

  onRemoveFile(e) {
    const i = e.currentTarget.dataset.index
    const j = Number(e.currentTarget.dataset.fileIndex)
    const files = this.data.uploads[i].files.slice()
    files.splice(j, 1)
    this.setData({ [`uploads[${i}].files`]: files })
  },

  async onSubmit() {
    const { fields, uploads } = this.data
    for (const f of fields) {
      if (f.required && (f.value === '' || f.value === null || f.value === undefined)) {
        return wx.showToast({ title: `请填写「${f.label}」`, icon: 'none' })
      }
    }
    for (const u of uploads) {
      const min = u.required ? Math.max(1, u.min) : u.min
      if (u.files.length < min) return wx.showToast({ title: `请上传「${u.label}」`, icon: 'none' })
    }
    const payload = { fields: {}, uploads: {} }
    for (const f of fields) {
      if (f.value !== '' && f.value !== null && f.value !== undefined) {
        payload.fields[f.key] = f.type === 'number' ? Number(f.value) : f.value
      }
    }
    for (const u of uploads) {
      if (u.files.length) payload.uploads[u.key] = u.files.map(f => f.id)
    }
    this.setData({ submitting: true })
    try {
      await api.post(`/worker/orders/${this.data.orderId}/deliver`, payload)
      wx.showToast({ title: '已提交，等待企业验收', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
    } finally {
      this.setData({ submitting: false })
    }
  }
})
