// 任务卡片：任务大厅 / 我的收藏复用。展示标题、地点·类目·工种标签、报酬、企业、报名数或状态。
// 点击触发 tap 事件（携带任务 id）；底部 slot 供调用页插入额外操作（如取消收藏）。
Component({
  properties: {
    task: { type: Object, value: null }
  },
  methods: {
    onTap() {
      const t = this.data.task
      if (t && t.id) this.triggerEvent('tap', { id: t.id })
    }
  }
})
