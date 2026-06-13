/**
 * 打印一段 HTML：新开窗口写入并调用 print（避免污染当前页面，深浅主题均输出白底黑字）。
 * @param {string} title 文档标题
 * @param {string} bodyHtml 打印区域 HTML
 */
export function printHtml(title, bodyHtml) {
  const win = window.open('', '_blank', 'width=820,height=600')
  if (!win) return
  win.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2937; padding: 32px; }
  h2 { text-align: center; margin: 0 0 24px; font-size: 20px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #d1d5db; padding: 10px 12px; font-size: 13px; text-align: left; }
  th { background: #f3f4f6; width: 160px; font-weight: 600; }
  .mono { font-family: Consolas, 'Courier New', monospace; font-size: 12px; word-break: break-all; }
  .money { font-variant-numeric: tabular-nums; }
  .footer { margin-top: 24px; font-size: 12px; color: #6b7280; text-align: right; }
  @media print {
    body { padding: 0; }
  }
</style>
</head>
<body>${bodyHtml}</body>
</html>`)
  win.document.close()
  win.focus()
  // 等待渲染后打印
  setTimeout(() => {
    win.print()
  }, 200)
}

/** 简单转义，防止内容打断 HTML */
export function esc(s) {
  return String(s ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
