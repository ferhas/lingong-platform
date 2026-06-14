# 灵活用工平台 API 契约 v1

Base URL: `http://127.0.0.1:3000/api/v1`

## 约定

- 认证:`Authorization: Bearer <token>`(JWT,登录获取)
- 金额:接口层一律为**元**(number,最多2位小数);服务端内部以分存储
- 成功:HTTP 2xx,返回 JSON 数据体
- 失败:HTTP 4xx/5xx,返回 `{ "error": { "code": "STRING_CODE", "message": "人话描述" } }`
- 分页:`?page=1&pageSize=20`,返回 `{ "list": [...], "total": n }`
- 角色:`worker`(零工) / `company`(企业) / `admin`(运营)。接口按角色隔离,越权返回 403

## 任务状态机

`recruiting`(报名中) → `working`(进行中,已录用) → `delivered`(已交付待验收) → `settled`(已验收结算) ;
`delivered` 可被驳回回到 `working`。

---

## 1. 认证 /auth

### POST /auth/register
```json
// 零工
{ "role": "worker", "phone": "13900000001", "password": "Test@1234", "name": "李师傅" }
// 企业(多两个字段)
{ "role": "company", "phone": "13900000002", "password": "Test@1234", "name": "王经理",
  "companyName": "杭州某电商科技有限公司", "licenseNo": "91330106MA2XXXXX0K", "industry": "软件信息服务" }
```
返回 `{ "token", "user": { "id", "role", "phone", "name" } }`。企业注册后处于待审核(`pending`),审核通过前不能发单。

### POST /auth/login
`{ "phone", "password" }` → `{ "token", "user" }`

### GET /auth/me
→ `{ "id", "role", "phone", "name" }`

---

## 2. 零工端 /worker(角色 worker)

### GET /worker/profile
```json
{ "name", "phone", "verified": true, "subjectType": "person|soletrader", "bankCard": "6217***",
  "frameContractNo": "FBK...", "locked": false, "account": { "balance": 1680.00 } }
```

### POST /worker/verify  实名认证(身份证OCR+活体+银行卡三要素,生成《分包协议(框架)》电子签)
`{ "idCard": "330106199001011234", "realName": "李某", "bankCard": "6217000000006217" }`
→ `{ "verified": true, "frameContractNo": "FBK..." }`

### GET /worker/meta  基础数据字典(启动拉取并缓存,与运营配置实时一致)
→ `{ "categories": [...], "payMethods": [...], "cities": [...], "trades": [...], "reviewTags": [...], "subscribeTmplIds": [...] }`

### GET /worker/tasks?category=&trade=&city=&keyword=&payMethod=&minPrice=&sort=&matchSkills=&page=&pageSize=  任务大厅(仅 recruiting)
列表项:`{ "id", "title", "category", "trade", "city", "price", "payMethod", "deadline", "companyName", "applicants": 3, "createdAt" }`
`matchSkills=1` 仅返回工种/类目命中本人已认证技能的任务(无已认证技能则忽略该筛选)。

### GET /worker/tasks/:id  任务详情
含 `description`、`standard`、`city`、`trade`、`favorited`、`estimate`: { gross, tax, vat, net } 收入预估、`insurance`: { plan, premium, coverage, offline } 接单保障(线下作业自动高保额)。

### POST /worker/tasks/:id/apply  报名(需已实名;账号被锁定返回 423)

### GET /worker/favorites / POST /worker/favorites/:taskId / DELETE /worker/favorites/:taskId  任务收藏
列表项:`{ "id", "title", "category", "trade", "city", "price", "payMethod", "deadline", "status", "recruiting", "expired", "companyName", "favoritedAt" }`

### GET /worker/dispatches  派单邀约(企业定向派单)
列表项:`{ "id", "taskId", "status": "invited|accepted|rejected|cancelled", "note", "title", "category", "payMethod", "subPrice", "deadline", "taskStatus", "companyName", "expired", "estimate": { gross, tax, vat, net }, "createdAt" }`

### POST /worker/dispatches/:id/accept  接受派单 → 与"被录用"同一落地(签分包工单+投保+任务转 working)
需已实名、未锁定;任务须仍 recruiting 且未过期。→ `{ "accepted": true, "workOrderNo": "FB...", "policyNo": "INS..." }`

### POST /worker/dispatches/:id/reject  `{ "reason": "档期已满" }` 拒绝派单(任务保持 recruiting,企业可改派)
→ `{ "rejected": true }`

### GET /worker/orders  我的接单
列表项:`{ "id", "title", "price", "subPrice", "payMethod", "status", "workOrderNo", "policyNo", "deliverable", "confirmNo", "deadline" }`

### POST /worker/orders/:id/deliver  上传交付物
`{ "note": "成片链接+工程文件" }`(仅 working 状态可调)

### GET /worker/income  收入与税务
```json
{ "account": { "balance": 1680.00 }, "subjectType": "person",
  "soletraderGuide": { "subjectType", "monthGross", "threshold": 100000, "suggest": false, "note": "..." },
  "taxSummary": { "yearGross": 28640, "yearTax": 3580.46, "months": 5, "monthSales": 6420, "vatFree": true },
  "records": [ { "id", "taskTitle", "gross", "tax", "vat", "net", "period": "2026-06", "createdAt" } ] }
```

### GET /worker/policies  我的保单(按单意外险)
列表项:`{ "id", "policyNo", "taskId", "taskTitle", "plan", "premium", "status", "taskStatus", "hasClaim", "active", "createdAt" }`

### GET /worker/invoices  B线进项发票台账(个体户)
列表项:`{ "id", "taskId", "taskTitle", "invoiceNo", "amount", "taxAmount", "invoiceType", "status", "statusLabel", "verifyNote", "createdAt" }`

### POST /worker/withdraw  `{ "amount": 1000 }` 提现到绑定银行卡(余额不足 400)

### GET /worker/tax/voucher?year=2025  年度扣缴凭证 → `{ "year", "totalGross", "totalTax", "items": [...] }`

### POST /worker/soletrader  个体工商户登记(转入B线:经营所得、平台不代扣、解除接单锁定)
`{ "licenseNo": "92330106MA2K1234X1" }` → `{ "subjectType": "soletrader", "locked": false }`

---

## 3. 企业端 /company(角色 company)

### GET /company/profile
```json
{ "companyName", "licenseNo", "industry", "status": "pending|approved|rejected", "reviewNote",
  "masterContractNo": "ZCL...", "account": { "balance": 50000, "frozen": 4500, "available": 45500 } }
```

### POST /company/recharge  `{ "amount": 50000 }`(模拟银行存管虚拟户入金回调)

### GET /company/flows?page=&pageSize=  资金流水
列表项:`{ "id", "type": "recharge|freeze|unfreeze|settle_out|...", "amount", "balanceAfter", "remark", "createdAt" }`

### GET /company/meta  发布元数据(实时读配置)→ `{ "categories": [...], "payMethods": [...], "cities": [...], "trades": [...] }`

### POST /company/tasks  发布任务(需 approved;校验计酬方式/类目/地点/违禁词;冻结预算;生成《任务工单》)
```json
{ "title", "category": "设计|技术|...|配送|安装|施工|其他", "trade": "UI设计(选填)", "city": "远程|北京|...",
  "payMethod": "按成果|按件|按单", "price": 1500, "deadline": "2026-06-30", "description", "standard" }
```
`city` 默认 `远程`;非字典值 → 400 `BAD_CITY`;`trade` 非该类目可选工种(`categoryTrades[category]`,见 services/taxonomy.js)→ 400 `BAD_TRADE`。线下作业类目(配送/安装/施工)录用时自动投保高保额方案。
违禁词(打卡/月薪/固定工资/底薪/考勤)或非法计酬方式 → 400 且产生风控预警。可用余额不足 → 400。
→ `{ "id", "workOrderNo", "frozen": 1500 }`

### GET /company/tasks?status=&page=&pageSize=  我的任务
### GET /company/tasks/:id  详情(含 `applications`: [{ "id", "workerId", "workerName", "verified", "createdAt" }])

### POST /company/tasks/:id/hire  `{ "workerId": 3 }` 录用 → 生成分包工单(电子签)+按单投保
→ `{ "workOrderNo": "FB...", "policyNo": "INS..." }`(零工须先报名;否则 400 `NO_APPLICATION`)

### GET /company/dispatch/candidates?keyword=  派单候选零工
候选 = 曾与本企业合作 ∪ 经本企业邀请码注册,且已实名未锁定。
列表项:`{ "workerId", "name", "verified", "locked", "subjectType", "creditScore", "hiredCount" }`

### POST /company/tasks/:id/dispatch  `{ "workerId": 3, "note": "老搭档帮个忙" }` 定向派单(仅 recruiting)
向指定零工发起派单邀约(零工接受后才成立承揽关系)。非候选零工 → 400 `NOT_CANDIDATE`;重复派单 → 409 `ALREADY_DISPATCHED`。
→ `{ "dispatched": true }`

### POST /company/tasks/:id/accept  验收通过(四流硬校验:无工单不可结算、无交付物不可验收)
→ `{ "confirmNo": "QR...", "invoice": { "no", "amount", "taxRate": "6%" }, "settlement": { "workerNet", "tax", "vat", "platformFee" } }`

### POST /company/tasks/:id/reject  `{ "reason" }` 驳回交付 → 任务回到 working

### GET /company/invoices  发票列表:`{ "id", "no", "taskTitle", "amount", "taxRate", "item", "confirmNo", "issuedAt" }`

### GET /company/contracts  合同列表:`{ "id", "type": "master|work_order|sub_order", "no", "taskTitle", "signedAt" }`

---

## 4. 运营端 /admin(角色 admin)

### GET /admin/dashboard
```json
{ "todayAmount": 0, "pendingCompanies": 1, "openAlerts": 2, "monthTax": 1234.56,
  "totals": { "companies": 5, "workers": 12, "tasks": 30, "settledAmount": 88888 } }
```

### GET /admin/companies?status=pending|approved|rejected|all
列表项:`{ "id", "companyName", "licenseNo", "industry", "riskLevel": "低|中|高", "riskNote", "status", "createdAt" }`
(行业命中负面清单——建筑劳务/医美/直播打赏/贸易走账——自动标高风险)

### POST /admin/companies/:id/review  `{ "pass": true, "note": "..." }`
通过即代表平台与其签署《总承揽框架合同》(电子签),返回 `{ "masterContractNo" }`(拒绝时无)

### GET /admin/workers?page=&pageSize=  零工列表:`{ "id", "name", "phone", "verified", "subjectType", "locked", "yearGross" }`

### GET /admin/risk/alerts?status=open|resolved|all
列表项:`{ "id", "level": "高|中|低", "type", "detail", "status": "open|resolved", "createdAt" }`

### POST /admin/risk/alerts/:id/resolve  `{ "note" }`

### GET /admin/tax/overview
```json
{ "period": "2026-06", "withheldTax": 0, "vat": 0, "declared": false, "quarterReported": false,
  "health": { "vatBurdenRate": "x%", "grossMarginRate": "x%", "soletraderRatio": "x%" } }
```

### POST /admin/tax/declare  `{ "period": "2026-06" }` 批量申报缴款(走税务局适配器)
### POST /admin/tax/quarter-report  `{ "period": "2026Q2" }` 季度涉税信息报送 → `{ "fileNo", "workers": n }`

### GET /admin/archives?page=&pageSize=  四流证据链(已结算任务)
列表项:`{ "taskId", "title", "companyName", "workerName", "amount", "flows": { "contract": ["ZCL..","FB..","FBK.."], "business": { "deliverable", "confirmNo" }, "fund": ["流水ID"], "invoice": { "no", "taxVoucher": "TAX.." } }, "evidenceHash": "sha256:...", "settledAt" }`

### GET /admin/integrations  外部服务健康状态
`[ { "key": "realname", "name": "公安实名核验", "provider", "status": "up", "latencyMs": 35 }, ... ]`
(共6项:realname / escrow 银行存管 / einvoice 数电票 / esign 电子签 / taxbureau 税务申报 / insurance 保险)

### GET /admin/flows?page=&pageSize=  资金流水(含平台税款户/收益户)

### GET /admin/reconciliation  自动对账(银行存管回执 vs 平台账务)
```json
{ "balanced": true, "bank": { "txns": 12, "total": 130000 }, "platform": { "flows": 12, "total": 130000 },
  "diff": 0, "recentTxns": [ { "txnNo": "BK...", "from", "to", "amount", "purpose", "createdAt" } ] }
```

---

# v2 增量(生产化补全)

## 通用

### POST /auth/change-password(全角色)
`{ "oldPassword", "newPassword" }`,新密码须 ≥10位且含字母+数字。原密码错 400。

### GET /auth/me(增强)
- admin 额外返回 `"permissions": ["company:review", ...]`(`"*"` 为全部)与 `"roleName": "超级管理员"`
- company 额外返回 `"memberRole": "owner|operator|finance"`

### GET /me/notifications?page=&pageSize=  站内通知
→ `{ "total", "unread", "list": [{ "id", "type", "title", "body", "read": 0|1, "created_at" }] }`
type 取值(共16类,见 services/notify.js 调用方):review/hired/deliver/rejected/settle/risk/guide/cancelled/member/dispatch/dispute/recharge/invoice/skill/ticket/export

### POST /me/notifications/read  `{ "ids": [1,2] }` 或 `{ "ids": "all" }`

### GET /me/settings → `{ "theme": "light|dark|auto", "notifyEnabled": true }`(可能为空对象)
### PATCH /me/settings  同结构部分更新

### POST /files  multipart 上传(字段名 `file`,≤10MB,常见图片/PDF/Office/zip/txt)
→ `{ "id": "<uuid>", "name", "size", "mime", "url": "/api/v1/files/<uuid>" }`
### GET /files/:id  鉴权下载(Bearer header;前端预览可用 axios blob 或 fetch 带头)

## 零工端新增

- `PATCH /worker/profile` `{ "name" }`
- `POST /worker/tasks/:id/withdraw-apply` 取消报名(已录用 409)
- `POST /worker/orders/:id/deliver` 增加可选 `"attachmentIds": ["<uuid>"]`(先调 /files 上传)
- `POST /worker/orders/:id/invoice` `{ "uploadId": "<uuid>" }` B线个体户上传进项发票(结算前置硬校验)
- GET /worker/orders 列表项增加 `"attachments": [{id,name,mime,size,kind,url}]`
- 任务列表/详情增加 `"expired": bool`;过期任务报名返回 409

## 企业端新增

- `PATCH /company/profile` `{ "contactPhone", "contactEmail" }`(仅 owner)
- `GET /company/profile` 增加 `"memberRole"`、`"contactPhone"`、`"contactEmail"`
- 成员管理(仅 owner 可写):
  - `GET /company/members` → `{ list: [{userId,name,phone,memberRole,status,createdAt}] }`
  - `POST /company/members` `{ "phone","name","memberRole":"operator|finance" }` → `{ userId, "tempPassword" }`(展示给 owner 转交成员)
  - `DELETE /company/members/:userId`(停用成员)
- `POST /company/tasks/:id/cancel`(仅 recruiting)→ `{ "status":"cancelled", "unfrozen": 3000 }`
- `GET /company/tasks` 支持 `keyword=` 搜索
- `GET /company/tasks/:id` 增加 `"attachments"` 数组(含 kind: deliverable|invoice)
- `GET /company/stats/trend?days=30` → `{ "trend":[{day,tasks,amount}], "statusDist":[{status,count}] }`
- `GET /company/invoices` 列表项增加 `"buyer": {title, taxNo}`
- `GET /company/contracts` 列表项增加 `partyA/partyB/contentHash/esignId`
- **角色门禁**:发布/录用/验收/驳回/取消 = owner|operator;充值 = owner|finance;资料编辑与成员管理 = owner。无权 403,前端按 memberRole 隐藏按钮。

## 运营端新增(每个端点要求对应权限点,403 即无权)

权限点:dashboard:read / company:read / company:review / worker:read / worker:manage / risk:read / risk:resolve / tax:read / tax:declare / flow:read / archive:read / integration:read / config:read / config:write / user:read / user:manage / audit:read

- `GET /admin/stats/trend?days=30` → `{ "trend":[{day,tasks,amount}], "taxTrend":[{day,tax,vat}], "statusDist":[{status,count}] }`
- 运营用户与角色:
  - `GET /admin/roles` → `{ list:[{id,name,permissions}] }`
  - `GET /admin/users`(分页)→ `{ list:[{id,name,phone,status,roleId,roleName,createdAt}] }`
  - `POST /admin/users` `{ phone,name,roleId }` → `{ userId, tempPassword }`
  - `PATCH /admin/users/:id/role` `{ roleId }`
  - `POST /admin/users/:id/disable | enable`;`POST /admin/users/:id/reset-password` → `{ tempPassword }`
- 零工管理:`POST /admin/workers/:id/lock` `{ "lock": true|false }`;`GET /admin/workers/export`(CSV)
- 配置:`GET /admin/configs` → `{ list:[{key,value,group,label,updatedAt}] }`(group: tax/risk/task/insurance)
  `PATCH /admin/configs/:key` `{ "value": ... }`(类型须与原值一致,实时生效)
- 审计:`GET /admin/audit-logs?page=&pageSize=&action=&userId=` → `{ total, list:[{id,userId,userName,userRole,action,detail,createdAt}] }`
- 导出(CSV,直接 `window.open` 不行——需带token,用 axios blob 下载):`GET /admin/flows/export`、`GET /admin/workers/export`、`GET /admin/tax/export?period=YYYY-MM`

## 行为变化

- 密码策略全局收紧:≥10位、含字母+数字(注册/改密/重置)
- 登录连续失败5次锁定15分钟(423);账号被停用登录/调用返回 423/403
- 任务状态机新增 `cancelled`;报名状态新增 `withdrawn`

---

# v3 增量(资金稳定性 + 运营完整性 + C端体验)

## 认证升级(三端都需适配)
- 登录/注册/微信登录响应新增 `"refreshToken"`(64位hex,7天);accessToken 有效期缩至 2h
- `POST /auth/refresh` `{ refreshToken }` → 新 `{token, refreshToken, user}`(旧 refreshToken 即刻吊销=轮换)。**前端拦截器:遇 401 且非登录接口 → 用 refreshToken 调 refresh → 重放原请求;refresh 也 401 则登出**
- `POST /auth/logout`(带 Bearer)吊销该用户全部 refreshToken
- `POST /auth/wechat` `{ code }` 已绑定直接登录;`{ code, phone, name }` 首登注册并绑定;未绑定仅 code → 404 NEED_BIND

## 提现改为申请单(T+1)
- `POST /worker/withdraw` → **201** `{ id, status:"applied", balance(可用) }`,金额冻结,由 Job 出金;失败自动解冻并通知
- `GET /worker/withdrawals` → `{ list:[{id,amount,bankCard,status:applied|processing|done|failed,failReason,createdAt,doneAt}] }`
- `GET /worker/profile`、`/worker/income` 的 `account` 变为 `{ balance(可用=总额-冻结), frozen }`
- 运营端:`GET /admin/withdrawals?status=`(flow:read)、`GET /admin/settlements?status=`(结算单监控:legsDone/attempts/lastError)

## 结算语义
- accept 在银行通道异常时返回 **502 SETTLE_PENDING**(已受理,自动重试),前端按"处理中"提示;结算中重复 accept → 409 SETTLING

## 对账
- `GET /admin/reconciliation` 新增 `"daily"`(近30天 [{day,status:balanced|mismatch,diff,bankTotal,bankTxns,platformTotal,platformFlows,checkedAt}])与 `"mismatchDays"`

## 运营详情与证明包
- `GET /admin/companies/:id/detail` → { company, account, taskStats[], members[], recentFlows[], alerts[] }
- `GET /admin/workers/:id/detail` → { worker, account, orderStats[], recentIncome[], contracts[], alerts[] }
- 风控预警列表项新增 `"refType": "company"|"worker"|null` 与 `"refId"`(前端据此跳详情)
- `GET /admin/companies/:id/evidence-pack`(archive:read)→ B端业务真实性证明包 JSON

## 企业端
- `GET /company/meta` → `{ categories, payMethods }`(发布表单动态读取,勿写死)
- `PATCH /company/members/:userId` `{ memberRole: "operator"|"finance" }`(owner;owner 行不可改)
- `POST /company/members/:userId/transfer-owner`(owner;转移企业所有权,自身降为 operator,目标须为在职成员)→ `{ ok, newOwnerId }`

## 零工端
- `GET /worker/tasks` 新增 `sort=latest|price_desc|price_asc|applicants_asc`、`minPrice=`、`maxPrice=`
- `GET /worker/income/monthly` → `{ list:[{period,gross,net,orders}] }`(近6个月,升序)

---

# v4 增量(协议/合同/角色/方案剩余模块)

## 注册协议(三端注册都必须适配)
- `POST /auth/register` 与微信首登注册 **必须带 `"agree": true`**,否则 400;同意的协议类型与版本自动留痕
- `GET /auth/legal/tos`、`GET /auth/legal/privacy`(**免登录**)→ `{ type, title, version, content }` 注册页"查看协议"用

## 全节点合同正文
- 合同签署时按模板渲染正文快照存档。`GET /company/contracts` 列表项加 `hasContent`;新增 `GET /company/contracts/:id` → 含 `content`(纯文本,前端 pre-wrap 展示+打印)
- 零工端新增:`GET /worker/contracts`(本人全部合同:frame_sub/sub_order)、`GET /worker/contracts/:id`(含 content)

## 运营端新增(权限点注明)
- `GET /admin/permissions`(user:read)→ 17 个权限点 `{key,label}` 供角色编辑勾选
- 角色管理(user:manage):`POST /admin/roles {name,permissions[]}`、`PATCH /admin/roles/:id`、`DELETE /admin/roles/:id`。预置6角色(超级管理员/审核专员/风控专员/财务税务/只读审计/客服)不可删/超管不可改;使用中角色删除返回 409
- 文书管理:`GET /admin/legal`(config:read)→ 6 份文书(tos/privacy/master/frame_sub/work_order/sub_order,含 content/version);`PATCH /admin/legal/:type {content}`(config:write)版本自增
- 抽查回访(方案P2):`POST /admin/callbacks/sample`(risk:resolve,按配置比例从近30天已结算任务抽取)→`{sampled,candidates}`;`GET /admin/callbacks?status=pending|confirmed|abnormal`;`POST /admin/callbacks/:id/resolve {confirmed:bool, note}`(异常自动产生"回访异常"高风险预警)
- 理赔管理:`GET /admin/claims`(risk:read);`POST /admin/claims/:id/process {status:"processing"|"closed", result}`(risk:resolve)
- 防员转零:`GET /admin/companies/:id/payroll`(risk:read);`POST /admin/companies/:id/payroll {names:[]}`(risk:resolve,上传历史发薪名单;录用命中名单自动高风险预警)
- IP关联:`GET /admin/risk/ip-graph`(risk:read)→ 近30天同IP≥3账号列表
- 发票管理:`GET /admin/invoices`(tax:read,分页);`POST /admin/invoices/:id/void {reason}`(tax:declare,红冲;企业发票列表项已加 `status: issued|voided`)
- 进项优化看板:`GET /admin/tax/input-overview`(tax:read)→ {soletraderCount, personCount, soletraderGrossRatio, currentInputDeduction, potentialInputDeduction, monthly[], suggestion}
- 平台初始报送:`POST /admin/tax/platform-report`(tax:declare,一次性)→ {fileNo};重复 409

## 企业端新增
- 发布前测算:`GET /company/estimate?price=&category=` → `{price, subPrice(零工税前所得), platformFee, estimatedVat, insurance, safe, note}`(发布页实时展示,降低理解成本)
- `GET /company/invoices` 列表项加 `status`(voided 显示"已红冲")

## 零工端新增
- `POST /worker/claims {taskId, description}`(一键报案,任务须有保单)→ 201;`GET /worker/claims`

---

# v5 增量(商用化:资金闭环/争议/工单/触达/安全/财务/增长/运维)

## 约定补充
- **step-up 二次验证**:管理员启用 2FA 后,标注 `[step-up]` 的接口须在请求头携带 `X-TOTP-Code: <6位动态码>`,否则 403
- 回调入口 `/api/v1/webhooks/:provider` 验签头 `X-Webhook-Signature` = HMAC-SHA256(原始报文, WEBHOOK_SECRET) hex
- 业务指标:`GET /metrics`(Prometheus 文本格式;配置 METRICS_TOKEN 后须携带 token)

## 认证 /auth
- `POST /auth/sms-code` `{ scene: register|login|withdraw|bindcard|changepw, phone? }`:register/login 免登录须带 phone;其余须登录(自动用本人手机号)。非生产环境返回 `devCode` 便于联调。频控:同号同场景 60s/次、单号 10 条/天、验证 5 次错废码
- `POST /auth/register`(worker)新增可选 `smsCode`(提供即校验)、`inviteCode`(企业邀请码,注册即绑定来源企业;无效码 400 BAD_INVITE_CODE)
- `POST /auth/login`:管理员已启用 2FA 时返回 `{ needTotp: true, tmpToken }`(5分钟有效)→ `POST /auth/totp { tmpToken, code }` → 正常会话

## 通用 /me
- 协议版本同意:`GET /me/agreements/status` → `{ docs:[{type,title,currentVersion,agreedVersion,needReAgree}], needReAgree }`;`POST /me/agreements/re-agree`(协议升版后前端强制弹窗重新同意)
- 争议(当事双方):`GET /me/disputes`;`GET /me/disputes/:id`(含 timeline[{actorRole,action,content,attachments,createdAt}]);`POST /me/disputes/:id/events {content, attachmentIds?}`(举证);`POST /me/disputes/:id/withdraw`(发起方撤回);`POST /me/disputes/:id/escalate`(不服裁决声明线下升级,资金按裁决先行执行)
- 客服工单:`POST /me/tickets {category,title,content,refType?,refId?,attachmentIds?}` → `{id,no,priority}`(withdraw/settlement 类自动 urgent、complaint 自动 high 并联动风控预警);`GET /me/tickets`;`GET /me/tickets/:id`(messages 对话流);`POST /me/tickets/:id/messages`;`POST /me/tickets/:id/close`;`POST /me/tickets/:id/rate {satisfaction:1-5}`
- 帮助中心:`GET /me/help?keyword=`;`GET /me/help/:id`

## 零工端 /worker
- 实名三段式:`POST /worker/verify` 新增 `consents:['idcard','face','bankcard']`(PIPL 单独同意留痕);开启 faceVerifyRequired 时返回 `{needFace:true, faceRequestId}` → `POST /worker/verify/face-result {faceRequestId}` 完成。身份证号密文入库(AES-256-GCM+HMAC 查重),同证二绑 409 IDCARD_EXISTS;实名即开立存管子账户
- 绑提现卡:`POST /worker/bank-card {bankCard, phone, smsCode?}`(四要素核验+存管绑卡协议号,出金凭协议号不存卡号明文)→ `{cardBound, bankCard(掩码)}`
- 提现:`POST /worker/withdraw` 新增 `smsCode?`(配置 withdrawSmsRequired=1 时强制,缺码 400 SMS_REQUIRED);全局暂停时 409 WITHDRAWAL_PAUSED;提现单关联 member_no
- 争议:`POST /worker/orders/:id/dispute {type: acceptance|payment_overdue|other, claim, claimAmount?, attachmentIds?}`
- 评价:`POST /worker/orders/:id/review {score,tags,comment}`;`GET /worker/orders/:id/reviews` → `{visible, reviews}`(互盲:双方评完或窗口期满才互见)
- 技能认证:`GET /worker/skills` → `{catalog, list}`;`POST /worker/skills {skill, level, certUploadId?}`
- B线发票:`POST /worker/orders/:id/invoice` 增 `invoiceNo/amount/taxAmount/invoiceType`(结构化入进项台账)
- `GET /worker/profile` 新增 `faceVerified、cardBound、credit:{creditScore,grade,settledCount,reviewCount,avgScore,verifiedSkills}`
- 任务大厅新增 `payMethod=` 筛选;keyword 同时搜索描述与交付标准;信用分低于阈值限同时在接 1 单(409 CREDIT_LIMITED)

## 企业端 /company
- 充值单收银台(真实资金闭环):`POST /company/recharge-orders {amount}` → `{orderNo, payAccount, payBank, payee, expireMinutes}`(企业对公转账→银行入金回调确认后自动入账);`GET /company/recharge-orders`;`POST /company/recharge-orders/:no/mock-pay`(仅非生产联调)。旧 `POST /company/recharge` 保留为演示通道
- 电子签授权:`POST /company/esign-auth`(owner,一次性静默签授权);`GET /company/profile` 新增 `esignAuthorized`
- 月结单:`GET /company/statement?period=YYYY-MM` → `{summary:{rechargeTotal,consumedTotal,settledTasks,invoicedTotal,endBalance,endFrozen}, settlements[], invoices[]}`
- 批量发单:`POST /company/tasks/batch {items:[≤50]}` → `{total,success,failed,results:[{row,ok,id?,error?}]}`(逐行复用风控/电子签/冻结链)
- 争议:`POST /company/tasks/:id/dispute {type: worker_missing|quality_after|other, ...}`
- 评价:`POST /company/tasks/:id/review`;`GET /company/tasks/:id/reviews`;任务详情 applications 项新增 `credit` 画像
- 邀请码:`GET /company/invite-code` → `{inviteCode, invitedWorkers}`
- 发票列表项新增 `redInvoiceNo、voidReason`

## 运营端 /admin(新权限点 11 个,共 28 个)
- 争议仲裁(dispute:read / dispute:rule):`GET /admin/disputes?status=&type=`;`GET /admin/disputes/:id`;`POST /admin/disputes/:id/accept`;`POST /admin/disputes/:id/rule {rulingType: full_pay|partial_pay|no_pay|redeliver, rulingAmount?, rulingNote}` [step-up];`POST /admin/disputes/:id/execute` [step-up](partial_pay 按裁决金额结算+剩余解冻;no_pay 全额解冻任务取消;redeliver 退回 working)
- 工单(ticket:read / ticket:manage):`GET /admin/tickets`;`GET /admin/tickets/:id`;`POST .../assign {assigneeId}`;`POST .../reply {content}`;`POST .../resolve {note}`;SLA 超时自动升级(urgent 2h / normal 24h,可配)
- 财务报表(finance:read):`GET /admin/finance/daily?day=`;`GET /admin/finance/monthly?period=`(经营月报+税款备付金勾稽+科目余额);`GET /admin/finance/settlement-detail?period=&format=csv`;`GET /admin/finance/company-statement?companyId=&period=`
- 导出审批(export:approve):`POST /admin/exports {scope,reason}`;`GET /admin/exports`;`POST /admin/exports/:id/approve {pass,note}` [step-up](不可自审);`GET /admin/exports/:id/download`(仅申请人,48h 有效,CSV 含水印列)。常规 `GET /admin/workers/export` 已改为脱敏手机号
- PII 专项(user:read_pii):`GET /admin/workers/:id/pii`(完整手机号+解密身份证号,强制审计);零工列表手机号默认脱敏
- 回调与出站监控(integration:read):`GET /admin/webhook-events?status=`;`POST /admin/webhook-events/:id/replay`;`GET /admin/integration-calls?provider=&status=`
- 消息中心(message:manage):`GET/PATCH /admin/message-templates(/:code)`;`GET /admin/message-logs`(含触达率)
- 帮助中心(help:manage):`GET/POST /admin/help-articles`;`PATCH /admin/help-articles/:id`
- 技能审核(skill:review):`GET /admin/skills?status=`;`POST /admin/skills/:id/review {pass,note}`
- 进项台账(tax:read/tax:declare):`GET /admin/input-invoices?status=`;`POST /admin/input-invoices/:id/verify {status: verified|rejected|deducted, note}`
- 对账差异(flow:read/flow:write):`GET /admin/recon-diffs?status=`;`POST /admin/recon-diffs/:id/resolve {note}`(T+1 对账升级为逐笔核销,差异明细自动生成)
- 结算治理(flow:write):`POST /admin/settlements/:id/retry` [step-up](failed 单人工重推);`POST /admin/fund-switches {settlementPaused?, withdrawalPaused?}` [step-up](全局应急开关,config:write)
- 2FA:`POST /admin/2fa/setup` → `{secret, otpauthUrl}`;`POST /admin/2fa/enable {code}`;`POST /admin/2fa/disable {code}`
- 发票:红冲现返回 `redInvoiceNo`(红字发票留痕);`POST /admin/invoices/:id/reissue` [step-up](红冲后关联重开)
- 税务辅助:`GET /admin/tax/declare-file?period=`(扣缴端导入 CSV);`POST /admin/tax/declarations/:id/receipt {receiptNo}`(回执回填)
- 防员转零豁免:`POST /admin/companies/:id/payroll/exempt {name, exempt, note}`(存量人员合规迁移评估通过后放行)
- 开放 API 凭据(config:read/config:write):`GET /admin/api-credentials`;`POST /admin/api-credentials {companyId, scopes?}` [step-up](appSecret 仅返回一次);`POST /admin/api-credentials/:id/disable`(降权/应急吊销,无 step-up);`POST /admin/api-credentials/:id/enable` [step-up](误停用后恢复)
- 系统健康(dashboard:read):`GET /admin/system-health` → 应急开关/Job 运行表/回调积压/结算计数/负余额/最近对账/集成健康

## 开放 API /api/open/v1(企业系统直连)
- 鉴权头:`X-App-Key` / `X-Timestamp`(毫秒,±5分钟) / `X-Signature` = HMAC-SHA256(key=SHA256(appSecret) hex, `${timestamp}.${原始请求体字节}`) hex（按**原始报文字节**签名,避免 JSON 键序/空白差异致验签不稳定;GET 无体时取 `{}`）
- `POST /api/open/v1/tasks`(scope task:create,走标准合规链:违禁词/电子签/冻结全部生效)
- `GET /api/open/v1/tasks/:id`(scope task:read)
- 不开放零工注册/实名代办(实名必须本人活体)

## 回调 /api/v1/webhooks/:provider(provider: escrow|einvoice|esign|insurance)
- 报文:`{ eventId, eventType, data }`;幂等(同 provider+eventId 重复推送直接成功);验签失败 400 并产生高风险预警
- 事件:`escrow:recharge.success {orderNo,txnNo,amount}`(入金确认入账)、`escrow:withdrawal.result {withdrawalId,success,txnNo,failReason}`(提现终态)、`einvoice:invoice.issued`、`esign:flow.finished {esignId,fileUrl}`、`insurance:claim.update {policyNo,status,result}`
- 处理失败的事件由补单 Job(每5分钟)自动重放;运营端可手工重放

---

# v6 增量(派单 / 定向派单)

任务到人新增一条路径,与原"报名→录用"互补:

- **报名→录用**(原有):零工在大厅报名 → 企业从报名者中录用。
- **派单→接受**(新增):企业向指定零工定向派单 → 零工接受后成立承揽关系。

派单仍严守四流硬校验——**零工接受时才电子签《分包工单》、按单投保、任务转 working**,企业单方派单不能直接绑定零工。

## 企业端 /company
- `GET /company/dispatch/candidates?keyword=` 候选零工(曾合作 ∪ 本企业邀请,已实名未锁定)
- `POST /company/tasks/:id/dispatch {workerId, note?}` 定向派单(仅 recruiting;非候选 400 `NOT_CANDIDATE`;重复 409 `ALREADY_DISPATCHED`)
- `GET /company/tasks/:id` 详情新增 `dispatches:[{id,workerId,workerName,status,note,rejectReason,createdAt,respondedAt}]`;applications 项新增 `source: apply|dispatch`

## 零工端 /worker
- `GET /worker/dispatches` 派单邀约列表(含 `estimate` 收入预估、`taskStatus`、`expired`)
- `POST /worker/dispatches/:id/accept` 接受 → 同录用落地 → `{accepted, workOrderNo, policyNo}`
- `POST /worker/dispatches/:id/reject {reason?}` 拒绝(任务保持 recruiting,企业可改派)

## 数据
- 新表 `dispatches(task_id, worker_id, company_id, status: invited|accepted|rejected|cancelled, note, reject_reason, ...)`;`applications.source` 列(apply/dispatch)
- 录用核心逻辑抽取为 `services/hiring.js#hireWorker`,报名录用与派单接受复用,保证两条路径落地完全一致

---

# v6 增量(连续性劳务 / 16 号公告累计预扣)

A 线自然人劳务报酬本就按累计预扣法计税;本轮按国税总局 2025 年第 16 号公告补齐口径,并按 15 号公告分类报送。详见 `docs/连续性劳务17类税务方案.md`。

## 计税口径(P0,影响实际税额)
- **断月重置**:连续取得报酬月份数改为"同一纳税年度内从本月逐月向前回溯、遇无 A 线收入月份即中断";累计收入与累计已预扣均**限当前连续段**(`taxEngine.js#consecutiveRun` / `calcWithholding`)。修正了断续接单多扣减除费用的偏差。

## 所得分类与打标(P1)
- 新配置 `continuousLaborCategories`(连续性劳务类目白名单,约 17 类,运营端可改)
- `tax_records.income_type`(labor_continuous|labor_other|business)与 `consecutive_months`(同步落 `settlements`);结算时按"类目白名单 + 主体类型"自动判定

## 申报与报送(P1)
- `GET /admin/tax/declare-file?period=` 扣缴申报底稿增列:所得项目 / 计税方式(累计预扣法) / 连续取得月份数
- `GET /admin/tax/quarter-summary?quarter=2026Q2`(tax:read)季度涉税信息按所得类型分类汇总 → `{quarter, periods, byType:[{incomeType,label,people,records,gross,tax,vat}], totals}`
- `GET /worker/tax/voucher?year=` 年度凭证新增 `incomeItem`、`taxMethod`,明细项加 `incomeType`、`consecutiveMonths`

## 零工端展示(P2)
- `GET /worker/income` 的 `taxSummary` 新增 `consecutiveMonths`、`cumulativeDeduction`(5000×连续月份)、`taxNote`(累计预扣口径与断月重置说明)
