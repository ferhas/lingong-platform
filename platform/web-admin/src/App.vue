<template>
  <router-view />
  <!-- 运营端是内部桌面工作台（大量多列表格），窄屏（手机/小平板竖屏）显示提示，避免错位不可用体验 -->
  <div class="desktop-only-tip">
    <div class="dot-card">
      <div class="dot-title">请使用桌面端访问</div>
      <div class="dot-desc">
        运营后台为内部桌面工作台，含大量表格与多列数据，建议在屏幕宽度 ≥1024px 的电脑浏览器中使用以获得完整体验。
      </div>
    </div>
  </div>
</template>

<style>
.desktop-only-tip {
  display: none;
}
@media (max-width: 760px) {
  .desktop-only-tip {
    display: flex;
    position: fixed;
    inset: 0;
    z-index: 99999;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #f3f4f6;
  }
  .dot-card {
    max-width: 360px;
    text-align: center;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    padding: 28px 24px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  }
  .dot-title {
    font-size: 18px;
    font-weight: 600;
    color: #1f2937;
    margin-bottom: 10px;
  }
  .dot-desc {
    font-size: 13px;
    line-height: 1.8;
    color: #6b7280;
  }
}
</style>
