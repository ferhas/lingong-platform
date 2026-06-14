// 为运营端各视图的圆形「刷新」图标按钮补 aria-label（无障碍）。幂等。
import fs from 'node:fs'
const dir = 'D:/code/零工/lingong-platform/platform/web-admin/src/views'
let changed = 0
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.vue'))) {
  const p = `${dir}/${f}`
  let s = fs.readFileSync(p, 'utf8')
  const before = s
  // 先处理带 size="small" 的变体，再处理普通变体；已含 aria-label 的不会匹配
  s = s.replaceAll(':icon="Refresh" circle size="small" @click', ':icon="Refresh" circle size="small" aria-label="刷新" @click')
  s = s.replaceAll(':icon="Refresh" circle @click', ':icon="Refresh" circle aria-label="刷新" @click')
  if (s !== before) { fs.writeFileSync(p, s); changed++; console.log('✓', f) }
}
console.log('changed files:', changed)
