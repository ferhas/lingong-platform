// 一次性迁移：@media(prefers-color-scheme:dark) → .t-dark 类驱动；各页 wxml 包 .theme-root。
// 运行：node _theme-migrate.mjs   运行后删除本文件。
import fs from 'node:fs'
import path from 'node:path'

const MARK = '@media (prefers-color-scheme: dark)'
// wxss 不转换：app.wxss（手工三态）、登录/协议页（保留 media 跟随系统）
const SKIP_WXSS = new Set(['app.wxss', 'pages/login/login.wxss', 'pages/legal/legal.wxss'])
// wxml 不包裹：登录/协议页
const SKIP_WXML = new Set(['pages/login/login.wxml', 'pages/legal/legal.wxml'])

function walk(dir, ext, acc) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, ext, acc)
    else if (name.endsWith(ext)) acc.push(p)
  }
  return acc
}

const rel = p => path.relative('.', p).split(path.sep).join('/')

// 提取并转换 wxss 中所有 dark 媒体块
function convertWxss(src, relpath) {
  let out = ''
  let i = 0
  let blocks = 0
  let warnedPage = false
  while (true) {
    const at = src.indexOf(MARK, i)
    if (at === -1) { out += src.slice(i); break }
    out += src.slice(i, at)
    // 找到 MARK 后第一个 { 与其匹配 }
    let bo = src.indexOf('{', at)
    let depth = 0, j = bo
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') { depth--; if (depth === 0) break }
    }
    const body = src.slice(bo + 1, j)
    out += transformBody(body, relpath, () => { warnedPage = true })
    blocks++
    i = j + 1
  }
  return { out, blocks, warnedPage }
}

// 媒体块体 → 每条规则选择器加 .t-dark 前缀
function transformBody(body, relpath, onPage) {
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  for (const chunk of noComments.split('}')) {
    if (!chunk.includes('{')) continue
    const bi = chunk.indexOf('{')
    const selPart = chunk.slice(0, bi)
    const decl = chunk.slice(bi + 1).trim()
    const selectors = selPart.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      if (s.startsWith('.t-dark')) return s
      if (s === 'page' || s.startsWith('page ') || s.startsWith('page.') || s.startsWith('page,') || s.startsWith('page:')) {
        onPage()
        return s
      }
      return '.t-dark ' + s
    }).join(',\n')
    const declLines = decl.split('\n').map(l => '  ' + l.trim()).join('\n')
    rules.push(`${selectors} {\n${declLines}\n}`)
  }
  return rules.join('\n\n')
}

// wxml：page-meta 改 {{pageStyle}} + 包 .theme-root
function convertWxml(src) {
  if (src.includes('theme-root')) return null // 已处理
  const metaLine = '<page-meta page-style="--fs: {{fsScale}};"></page-meta>'
  if (!src.includes(metaLine)) return { warn: true }
  let out = src.replace(metaLine, '<page-meta page-style="{{pageStyle}}"></page-meta>\n<view class="theme-root {{themeClass}}">')
  out = out.replace(/\s*$/, '') + '\n</view>\n'
  return { out }
}

let report = []

// —— wxss ——
for (const p of walk('.', '.wxss', [])) {
  const r = rel(p)
  if (SKIP_WXSS.has(r)) { report.push(`skip  wxss  ${r}`); continue }
  const src = fs.readFileSync(p, 'utf8')
  if (!src.includes(MARK)) continue
  const { out, blocks, warnedPage } = convertWxss(src, r)
  fs.writeFileSync(p, out)
  report.push(`wxss  ${r}  (${blocks} block${blocks > 1 ? 's' : ''})${warnedPage ? '  ⚠ page-selector kept' : ''}`)
}

// —— wxml （仅 pages/）——
for (const p of walk('pages', '.wxml', [])) {
  const r = rel(p)
  if (SKIP_WXML.has(r)) { report.push(`skip  wxml  ${r}`); continue }
  const src = fs.readFileSync(p, 'utf8')
  const res = convertWxml(src)
  if (res === null) { report.push(`done  wxml  ${r}  (already)`); continue }
  if (res.warn) { report.push(`WARN  wxml  ${r}  (no page-meta line!)`); continue }
  fs.writeFileSync(p, res.out)
  report.push(`wxml  ${r}`)
}

console.log(report.join('\n'))
console.log('\nTOTAL:', report.filter(l => l.startsWith('wxss') || l.startsWith('wxml')).length, 'files changed')
