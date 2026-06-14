// 任务卡片：任务大厅 / 我的收藏复用。展示标题、地点·类目·工种标签、报酬、企业、报名数或状态。
// 点击触发 tap 事件（携带任务 id）；底部 slot 供调用页插入额外操作（如取消收藏）。
// 深色：addGlobalClass 放开样式隔离，由所在页根节点 .theme-root 的 .t-dark 命中（规则在 app.wxss），
// 组件自身不持有主题状态，避免在 H5 运行时「重建实例→attached→setData」的重渲染循环。
Component({
  options: { addGlobalClass: true },
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
