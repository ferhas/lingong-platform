// 登录态页面截图：通过 CDP 驱动无头 Edge,注入 localStorage token 后访问内部页面
// 用法: node scripts/screenshot.mjs <configJsonFile>
// config: { "origin": "http://localhost:5173", "storage": {"token":"..."}, "pages": [{"path":"/dashboard","out":"x.png"}] }
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
// 截图输出限定在脚本运行目录下，防止 config.pages[].out 写入任意路径（运维脚本纵深防御）
const OUT_ROOT = process.cwd()
function safeOut(out) {
  const full = path.resolve(OUT_ROOT, String(out))
  if (full !== OUT_ROOT && !full.startsWith(OUT_ROOT + path.sep)) {
    throw new Error(`非法输出路径（越出工作目录）：${out}`)
  }
  return full
}
const PORT = 9223
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-proxy-server',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/edge-cdp-${Date.now()}`,
  '--disable-features=ForcedColors', '--force-color-profile=srgb',
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(300)
  }
  throw new Error('无法连接 Edge CDP')
}

const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}) {
  const id = ++msgId
  return new Promise(res => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')

async function navigate(url, settle = 2500) {
  await send('Page.navigate', { url })
  await sleep(settle)
}

// 先到 origin 写入 localStorage
await navigate(config.origin + '/login', 1500)
const setters = Object.entries(config.storage)
  .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`)
  .join(';')
await send('Runtime.evaluate', { expression: setters })

for (const page of config.pages) {
  await navigate(config.origin + page.path)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(safeOut(page.out), Buffer.from(shot.result.data, 'base64'))
  console.log('✓', page.path, '->', page.out)
}

ws.close()
edge.kill()
