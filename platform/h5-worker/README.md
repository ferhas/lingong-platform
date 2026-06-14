# 零工端 H5（微信小程序 → H5）

把原生微信小程序 `miniprogram-worker/` **原样**跑成浏览器 H5：不重写任何页面，
复用全部 `.js / .wxml / .wxss`，通过一个轻量运行时把小程序的 `Page/Component/wx.*`
模型与 WXML 模板翻译到 DOM。与 API **同源**部署，免跨域。

打开方式（服务端已挂静态托管）：

```
http://127.0.0.1:3000/h5/
```

> 体验账号：登录页点「🧪 模拟登录」直接进入预置两月数据的零工账号；
> 或账号登录 `13900000001 / Demo@123456`。

## 组成

| 文件 | 作用 |
|---|---|
| `index.html` | 宿主页：手机框 + 顶部导航栏 + 底部 tabBar + 浮层容器，加载 bundle 与 runtime |
| `build.mjs` | 把 `miniprogram-worker/` 全部源码打包进 `mp-bundle.js`（`window.__MP_FILES__`） |
| `mp-bundle.js` | 构建产物（改了小程序源码后重跑 `node build.mjs` 重新生成） |
| `runtime.js` | 运行时核心（见下） |
| `h5-test.mjs` | CDP 驱动无头 Edge 的端到端测试：走通登录 + 全部 22 个页面 + 关键交互，逐页截图、捕获 console/异常 |

## runtime.js 做了什么

- **CommonJS 装载器**：在内存里同步 `require` 小程序源码（`require/module/exports`），
  `wx / App / Page / Component / getApp / getCurrentPages` 作为全局注入，
  使 `app.js` 对全局 `Page` 的包装（字体缩放注入 + 登录守卫）照常生效。
- **表达式求值**：`with(scope)` 解释 `{{ }}` 内的 JS 表达式，语义与小程序一致。
- **WXML 编译**：先把自闭合标签（`<task-card/>`、`<textarea/>`）补成成对标签，再用
  `DOMParser` 解析为模板 DOM；渲染时 `data + 模板 → 轻量 vnode`，配 keyed patch
  就地更新（输入框打字不丢焦点）。支持 `wx:if/elif/else`、`wx:for/key/item`、`block`、
  `slot`、`page-meta`、自定义组件、`bind*/catch*` 事件、`data-*`、`picker`（selector）。
- **WXSS**：`Nrpx → calc(N * var(--rpx))`（`--rpx` 带 px 单位，按手机框宽/750 实时计算）；
  `page` 选择器 → `.wx-page`；`@media (prefers-color-scheme)` 深色模式原生支持。
- **wx.\* API**（~30 个）：`request`(fetch)、`uploadFile`/`chooseMessageFile`(File 桥接)、
  `localStorage` 存储、导航（页面栈 + 导航栏 + 自定义 tabBar）、`showToast/Loading/Modal`
  (含 `editable`)/`showActionSheet`、`picker` 浮层、`login`（H5 无微信→复用体验 code）等。
- **同源**：启动时把 `globalData.apiBase` 改为相对路径 `/api/v1`，规避 127.0.0.1/localhost 跨域。

## 改了小程序源码后

```bash
node build.mjs          # 重新打包 mp-bundle.js（runtime.js 是静态文件，浏览器刷新即生效）
```

## 跑端到端测试（需先启动 server，并已 seed 体验数据：server 目录 npm run demo）

```bash
NO_PROXY='*' node h5-test.mjs
# 输出 36/36 通过，截图与 h5_report.json 落在 ../.review-shots/
```

## 服务端托管（已接入 `server/src/app.js`）

`app.use('/h5', h5Csp, express.static(h5Dir))`：对 `/h5` 放宽 CSP 允许 `unsafe-eval`
（运行时用 `new Function` 装载源码/解释模板表达式），其余接口仍受全局 helmet 约束。
