// 法律文书内容回归测试：守护“生产级”底线——关键条款不被回退、占位符不写错、
//   纯文本协议（tos/privacy）不混入占位符。纯数据校验，不起服务、不连库。
import assert from 'node:assert/strict'
import { LEGAL_SEEDS } from '../src/services/legalSeeds.js'

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log(`  ✓ ${name}`)
}

const byType = Object.fromEntries(LEGAL_SEEDS.map(([type, title, content]) => [type, { title, content }]))
const has = (type, s) => byType[type] && byType[type].content.includes(s)

// 提取正文中的 {{token}} 占位符
function tokens(content) {
  const set = new Set()
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  let m
  while ((m = re.exec(content))) set.add(m[1])
  return [...set]
}

// 占位符白名单（必须与 web-admin LegalView.vue 的 DOC_META 及各签署点传入变量一致）
const ALLOWED = {
  master: ['partyA', 'licenseNo', 'contractNo', 'date', 'hash'],
  frame_sub: ['partyB', 'contractNo', 'date', 'hash'],
  work_order: ['partyA', 'contractNo', 'date', 'taskTitle', 'category', 'payMethod', 'price', 'deadline', 'standard', 'hash'],
  sub_order: ['partyB', 'contractNo', 'date', 'taskTitle', 'payMethod', 'subPrice', 'policyNo', 'hash']
}

// —— 1. 六份文书齐备 ——
for (const t of ['tos', 'privacy', 'master', 'frame_sub', 'work_order', 'sub_order']) {
  ok(`文书 ${t} 存在且有标题正文`, byType[t] && byType[t].title.length > 0 && byType[t].content.length > 0)
}

// —— 2. 生产级字数下限（防回退到单薄旧种子）——
ok('tos 正文充实（≥1200 字）', byType.tos.content.length >= 1200)
ok('privacy 正文充实（≥1200 字）', byType.privacy.content.length >= 1200)
ok('master 正文充实（≥1200 字）', byType.master.content.length >= 1200)
ok('frame_sub 正文充实（≥1200 字）', byType.frame_sub.content.length >= 1200)
ok('work_order 正文充实（≥300 字）', byType.work_order.content.length >= 300)
ok('sub_order 正文充实（≥300 字）', byType.sub_order.content.length >= 300)

// —— 3. 关键条款锚点（含 integration.test.mjs 依赖的子串）——
ok('tos 含承揽后分包模式声明', has('tos', '承揽后分包'))
ok('tos 含不构成劳动关系', has('tos', '不构成劳动关系'))
ok('tos 含争议解决', has('tos', '争议') && has('tos', '管辖'))
ok('tos 含个人信息/隐私指引', has('tos', '隐私政策'))

ok('privacy 含个人信息保护法依据', has('privacy', '个人信息保护法'))
ok('privacy 含敏感个人信息单独告知', has('privacy', '敏感个人信息'))
ok('privacy 含存储期限', has('privacy', '存储期限') || has('privacy', '十年'))
ok('privacy 含用户权利（注销/撤回）', has('privacy', '注销') && has('privacy', '撤回'))
ok('privacy 含共享对象（存管银行/税务）', has('privacy', '存管银行') && has('privacy', '税务机关'))

ok('master 渲染甲方与合同编号', has('master', '{{partyA}}') && has('master', '{{contractNo}}'))
ok('master 含统一社会信用代码占位', has('master', '{{licenseNo}}'))
ok('master 含全额开票条款', has('master', '全额开具') && has('master', '增值税发票'))
ok('master 含银行存管', has('master', '存管'))
ok('master 含合规禁止（虚开/员工转零工）', has('master', '虚开') && has('master', '员工转零工'))
ok('master 含争议解决与电子签名', has('master', '争议') && has('master', '电子签名'))
ok('master 含存证哈希', has('master', '{{hash}}'))

ok('frame_sub 渲染乙方姓名', has('frame_sub', '{{partyB}}'))
ok('frame_sub 含独立承揽/不构成劳动关系', has('frame_sub', '独立承揽') && has('frame_sub', '不构成劳动关系'))
ok('frame_sub 含按成果计酬+不接受考勤', has('frame_sub', '按成果') && has('frame_sub', '不接受') && has('frame_sub', '考勤'))
ok('frame_sub 含代扣代缴与个体户分支', has('frame_sub', '代扣代缴') && has('frame_sub', '个体工商户'))
ok('frame_sub 含按单保险', has('frame_sub', '保险') && has('frame_sub', '接单'))
ok('frame_sub 含存证哈希', has('frame_sub', '{{hash}}'))

ok('work_order 含任务名称/承揽价占位', has('work_order', '{{taskTitle}}') && has('work_order', '{{price}}'))
ok('work_order 标明框架合同附件', has('work_order', '附件') && has('work_order', '同等法律效力'))
ok('work_order 含验收规则', has('work_order', '验收'))
ok('work_order 含存证哈希', has('work_order', '{{hash}}'))

ok('sub_order 含“成果不合格不计酬”', has('sub_order', '成果不合格不计酬'))
ok('sub_order 含分包报酬/保单占位', has('sub_order', '{{subPrice}}') && has('sub_order', '{{policyNo}}'))
ok('sub_order 标明分包协议附件', has('sub_order', '附件'))
ok('sub_order 含存证哈希', has('sub_order', '{{hash}}'))

// —— 4. 纯文本协议（原样展示）不得混入占位符，否则用户会看到 {{xxx}} 字面 ——
ok('tos 无占位符（前端原样展示）', tokens(byType.tos.content).length === 0)
ok('privacy 无占位符（前端原样展示）', tokens(byType.privacy.content).length === 0)

// —— 5. 合同占位符必须 ⊆ 白名单（拼写错会被渲染为空字符串、静默上线）——
for (const [type, allow] of Object.entries(ALLOWED)) {
  const used = tokens(byType[type].content)
  const unknown = used.filter(k => !allow.includes(k))
  ok(`${type} 占位符均在白名单内（无拼写错）`, unknown.length === 0)
}

console.log(`\n✅ 法律文书内容测试 ${passed} 项通过`)
