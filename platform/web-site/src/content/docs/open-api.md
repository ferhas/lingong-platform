---
title: 开放 API
description: 大客户系统直连发单、查单，走标准承揽分包合规链路。
category: 开发者
order: 1
updated: 2026-06-15
---

## 概览

开放 API 位于 `/api/open/v1`，面向大客户的业务系统**直连发单、查单、回单**。所有调用同样走标准的承揽分包合规链路——API 只是入口，四流硬校验照常生效。开放 API **不开放代注册**。

## 鉴权：HMAC 签名 + 时间窗

每个请求需携带签名与时间戳，服务端校验签名、时间窗与限流：

```http
POST /api/open/v1/tasks HTTP/1.1
Host: lingong-api.eexb.com
Content-Type: application/json
X-Api-Key: ak_live_xxxxxxxx
X-Timestamp: 1750000000
X-Signature: hmac-sha256(secret, timestamp + rawBody)

{
  "title": "门店设备季度巡检",
  "subPrice": 80000,
  "trade": "安装维修",
  "city": "杭州"
}
```

- `X-Signature`：以 `secret` 对 `时间戳 + 原始报文` 做 HMAC-SHA256。
- 时间戳超出窗口（默认数分钟）即拒绝，防重放。
- 触发限流返回 `429`。

## 凭据管理

API 凭据在运营端创建与吊销。**`secret` 仅在创建时展示一次**，请妥善保存；遗失只能吊销重建。

## 错误约定

错误响应统一为：

```json
{ "error": { "code": "STRING_CODE", "message": "人话描述" } }
```

分页统一为 `?page&pageSize`，返回 `{ list, total }`。

## 回调

业务事件通过 Webhook 回推，回调报文以原始 body 做 HMAC 验签；处理失败由补单任务每 5 分钟自动重放，保证最终一致。
