// 零工端「微信开发者工具」自动化截图：
//   1) 用固定 mock code 调 /auth/wechat 拿体验账号会话（与小程序「模拟登录」同一入口）
//   2) 自己以 shell 方式拉起 `cli.bat auto`（automator 0.12.1 在 Node22 下直接 spawn .bat 会因
//      CVE-2024-27980 加固而失败，故改为自管 cli + automator.connect()）
//   3) 注入会话到 Storage + 把 apiBase 改指本机 127.0.0.1（模拟器跑在本机），逐页 reLaunch 截图
//
// 前置（一次性，在开发者工具里）：设置→安全设置→服务端口 开启；且工具已扫码登录。
// 用法：cd platform && NO_PROXY='*' node scripts/wx-shots.mjs
import automator from 'miniprogram-automator'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const CLI = process.env.WX_CLI || 'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat'
const PROJECT = process.env.WX_PROJECT || 'D:/code/零工/lingong-platform/platform/miniprogram-worker'
const OUT = 'D:/code/零工/lingong-platform/platform/.review-shots'
const PORT = Number(process.env.WX_AUTO_PORT || 9420)
const WS = `ws://127.0.0.1:${PORT}`
const HOST_API = process.env.API_BASE || 'http://127.0.0.1:3000/api/v1'
const SIM_API = process.env.SIM_API || 'http://127.0.0.1:3000/api/v1'
const MOCK_CODE = 'demo-worker-2month-001'

fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function login() {
  const res = await fetch(HOST_API + '/auth/wechat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: MOCK_CODE })
  })
  if (!res.ok) throw new Error(`登录失败 ${res.status}：${await res.text()}（server 起了吗？记得 NO_PROXY='*'）`)
  return res.json()
}
async function firstTaskId(token) {
  try {
    const r = await fetch(HOST_API + '/worker/tasks', { headers: { authorization: `Bearer ${token}` } })
    const d = await r.json()
    return (Array.isArray(d) ? d : d.list)?.[0]?.id ?? null
  } catch { return null }
}

function pages(taskId) {
  const list = [
    ['index', '/pages/index/index'], ['orders', '/pages/orders/orders'], ['mine', '/pages/mine/mine'],
    ['income', '/pages/income/income'], ['notices', '/pages/notices/notices'], ['favorites', '/pages/favorites/favorites'],
    ['skills', '/pages/skills/skills'], ['contracts', '/pages/contracts/contracts'], ['disputes', '/pages/disputes/disputes'],
    ['insurance', '/pages/insurance/insurance'], ['tickets', '/pages/tickets/tickets'], ['help', '/pages/help/help'],
    ['verify', '/pages/verify/verify'], ['bindcard', '/pages/bindcard/bindcard'],
    ['soletrader', '/pages/soletrader/soletrader'], ['password', '/pages/password/password']
  ]
  if (taskId) list.push(['detail', `/pages/detail/detail?id=${taskId}`])
  return list
}

// 自管拉起 cli auto（shell:true 才能在 Win/Node22 跑 .bat），返回子进程句柄
function startCli() {
  const cmd = `"${CLI}" auto --project "${PROJECT}" --auto-port ${PORT} --trust-project`
  const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', d => process.stdout.write(`  [cli] ${d}`))
  child.stderr.on('data', d => process.stderr.write(`  [cli!] ${d}`))
  return child
}

const session = await login()
console.log(`✓ 体验账号会话：${session.user.name} ${session.user.phone}`)
const taskId = await firstTaskId(session.token)

console.log('· 拉起开发者工具 automation（cli auto）…')
const cli = startCli()
const cleanup = () => { try { spawn('taskkill', ['/pid', String(cli.pid), '/T', '/F'], { shell: true }) } catch {} }
process.on('exit', cleanup)

// 轮询直到 automation ws 可连（最多 ~70s）
let mp = null
for (let i = 0; i < 70 && !mp; i++) {
  await sleep(1000)
  try { mp = await automator.connect({ wsEndpoint: WS }) } catch {}
}
if (!mp) {
  console.error(`\n✗ 70s 内未能连上 ${WS}。请确认：开发者工具已登录、设置→安全设置→服务端口已开启、零工端项目已打开。`)
  cleanup(); process.exit(1)
}
console.log('✓ 已连接 automation。注入会话并改写 apiBase…')

await mp.evaluate(base => { getApp().globalData.apiBase = base }, SIM_API)
await mp.reLaunch('/pages/login/login'); await sleep(1500)
try { await mp.screenshot({ path: `${OUT}/worker_login.png` }); console.log('  ✓ worker_login.png') } catch (e) { console.log('  !! login', e.message) }

await mp.callWxMethod('setStorageSync', 'token', session.token)
if (session.refreshToken) await mp.callWxMethod('setStorageSync', 'refreshToken', session.refreshToken)
await mp.callWxMethod('setStorageSync', 'user', session.user)

let ok = 0
for (const [name, url] of pages(taskId)) {
  try {
    await mp.reLaunch(url)
    await sleep(2200)
    await mp.screenshot({ path: `${OUT}/worker_${name}.png` })
    console.log(`  ✓ worker_${name}.png`); ok++
  } catch (e) {
    console.log(`  !! ${name} 失败：${e.message}`)
  }
}

await mp.disconnect()
cleanup()
console.log(`\n✓ 完成：${ok + 1} 张 → ${OUT}（worker_*.png）`)
process.exit(0)
