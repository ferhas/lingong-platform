// UI 文案回归测试：防止运营端菜单/页面回退到不够直观或不统一的命名
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const adminSrc = path.resolve(here, '../../web-admin/src')

function read(rel) {
  return fs.readFileSync(path.join(adminSrc, rel), 'utf8')
}

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log(`  ✓ ${name}`)
}

const menus = read('layout/menus.js')
ok('菜单使用“企业入驻审核”', menus.includes("label: '企业入驻审核'"))
ok('菜单使用“凭证归档”', menus.includes("label: '凭证归档'"))
ok('菜单使用“外部服务状态”', menus.includes("label: '外部服务状态'"))
ok('菜单区分资金流水与结算/提现单据', menus.includes("label: '资金流水'") && menus.includes("label: '结算/提现单据'"))
ok('菜单使用“业务参数配置”', menus.includes("label: '业务参数配置'"))
ok('菜单使用“协议/合同模板”', menus.includes("label: '协议/合同模板'"))

const companies = read('views/CompaniesView.vue')
ok('企业审核页标题更直观', companies.includes('<h2 class="page-title">企业入驻审核</h2>'))
ok('企业审核页统一“统一社会信用代码”', companies.includes('label="统一社会信用代码"'))
ok('企业审核页展示“总承揽合同号”', companies.includes('label="总承揽合同号"'))
ok('企业审核页使用“历史发薪名单（防止员工转零工）”', companies.includes('历史发薪名单（防止员工转零工）'))

ok('外部服务页标题更准确', read('views/IntegrationsView.vue').includes('<h2 class="page-title">外部服务状态</h2>'))
ok('凭证归档页标题更白话', read('views/ArchivesView.vue').includes('<h2 class="page-title">凭证归档</h2>'))
ok('资金流水页标题更简洁', read('views/FlowsView.vue').includes('<h2 class="page-title">资金流水</h2>'))
ok('资金单据页标题区分结算提现', read('views/FundsOrdersView.vue').includes('<h2 class="page-title">结算/提现单据</h2>'))
ok('业务参数页标题更准确', read('views/ConfigsView.vue').includes('<h2 class="page-title">业务参数配置</h2>'))
ok('协议页标题更准确', read('views/LegalView.vue').includes('<h2 class="page-title">协议/合同模板</h2>'))

console.log(`\n✅ 文案回归测试 ${passed} 项通过`)
