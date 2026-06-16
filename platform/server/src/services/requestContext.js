import { AsyncLocalStorage } from 'node:async_hooks'

// 请求级上下文：在 Express 中间件里 run 一次，整条异步调用链（含 await 之后）都能取到
// 发起方的终端证据（IP / User-Agent / 地理位置），使全量 logAction 自动带终端留痕，无需逐处传参。
const als = new AsyncLocalStorage()

export function runWithContext(ctx, fn) {
  return als.run(ctx, fn)
}

export function currentContext() {
  return als.getStore() || null
}
