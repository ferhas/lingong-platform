// 验证修复：仅截 admin/company 工作台
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const API = 'http://127.0.0.1:3000/api/v1'
const OUT = 'D:/code/零工/lingong-platform/platform/.review-shots'
const PORT = 9224
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(url, body) {
  const res = await fetch(API + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}
async function getMe(token) { return (await fetch(API + '/auth/me', { headers: { authorization: `Bearer ${token}` } })).json() }
const adminLogin = await api('/auth/login', { phone: '13800000001', password: 'Admin@123456' })
const adminMe = await getMe(adminLogin.token)
const companyLogin = await api('/auth/login', { phone: '13700000001', password: 'Company@123' })
const companyMe = await getMe(companyLogin.token)
const adminStore = { gigwork_admin_token: adminLogin.token, gigwork_admin_refresh: adminLogin.refreshToken || '', gigwork_admin_user: JSON.stringify({ ...adminLogin.user, ...adminMe }) }
const companyStore = { token: companyLogin.token, refreshToken: companyLogin.refreshToken || '', user: JSON.stringify({ ...companyLogin.user, ...companyMe }) }
const TARGETS = [
  { name: 'admin_configs', origin: 'http://localhost:5174', storage: adminStore, path: 'configs' },
  { name: 'company_publish', origin: 'http://localhost:5173', storage: companyStore, path: 'publish' },
  { name: 'company_tickets', origin: 'http://localhost:5173', storage: companyStore, path: 'tickets' }
]
const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-proxy-server',`--remote-debugging-port=${PORT}`,`--user-data-dir=${process.env.TEMP}/edge-v-${Date.now()}`,'--hide-scrollbars','--force-color-profile=srgb','--window-size=1440,900','about:blank'], { stdio: 'ignore' })
async function getTarget() { for (let i=0;i<40;i++){ try { const l=await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p=l.find(t=>t.type==='page'); if(p) return p } catch{} await sleep(300) } throw new Error('no cdp') }
const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let id=0; const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))})
await send('Page.enable'); await send('Runtime.enable')
const setVP=(w,h)=>send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false})
const MEASURE=`(()=>{const sel=['.content','.main-content','.el-main','main','#app'];let h=0;for(const s of sel){document.querySelectorAll(s).forEach(e=>{if(e.scrollHeight>h)h=e.scrollHeight})}return Math.max(h,document.documentElement.scrollHeight)})()`
for (const t of TARGETS) {
  await setVP(1440,1000); await send('Page.navigate',{url:t.origin+'/login'}); await sleep(1400)
  const setters = Object.entries(t.storage).map(([k,v])=>`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(';')
  await send('Runtime.evaluate',{expression:setters})
  await send('Page.navigate',{url:t.origin+'/'+t.path}); await sleep(3000)
  const r = await send('Runtime.evaluate',{expression:MEASURE,returnByValue:true})
  let H=Math.min(Math.max(Math.ceil(r.result?.result?.value||900)+24,600),8000)
  await setVP(1440,H); await sleep(600)
  const shot = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height:H,scale:1}})
  fs.writeFileSync(`${OUT}/${t.name}_v.png`, Buffer.from(shot.result.data,'base64'))
  console.log('✓', t.name, `1440x${H}`)
}
ws.close(); edge.kill()
