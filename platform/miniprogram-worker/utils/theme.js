// 深色模式：偏好 system|light|dark 持久化到 Storage；effective() 结合系统主题解析为 light|dark。
// 与 fontScale 同样由 app.js 劫持 Page 注入到每页 data：
//  - 页面背景/文字色经 <page-meta page-style="{{pageStyle}}"> 注入到 page 根节点；
//  - 内容样式由各页根节点 <view class="theme-root {{themeClass}}"> 上的 t-dark/t-light 类驱动；
//  - 原生导航栏 / 窗口背景由 applyChrome() 用 JS 同步（forced 主题需覆盖 theme.json 的系统跟随）。
// 自定义组件样式隔离：task-card / 自定义 tabBar 各自读取本模块并给自身根节点挂 themeClass。

const KEY = 'theme_pref'
const VALID = ['system', 'light', 'dark']

// 档位（设置页展示用）
const OPTIONS = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' }
]

// 主题色板：与 app.wxss、theme.json 保持一致（改这里 = 改导航/窗口/页面底色）
const PALETTE = {
  light: {
    pageBg: 'linear-gradient(180deg, #EAF4F1 0%, #F3F7F6 360rpx, #F4F6FA 100%)',
    pageFg: '#172033',
    navBg: '#0F766E',
    navFront: '#ffffff',
    winBg: '#F3F7F6'
  },
  dark: {
    pageBg: 'linear-gradient(180deg, #0B1322 0%, #0F172A 360rpx, #0F172A 100%)',
    pageFg: '#E5E7EB',
    navBg: '#0F172A',
    navFront: '#ffffff',
    winBg: '#0F172A'
  }
}

// 当前偏好（带兜底）
function getPref() {
  let v
  try { v = wx.getStorageSync(KEY) } catch (e) {}
  return VALID.includes(v) ? v : 'system'
}

// 持久化偏好，返回规范化后的值
function setPref(v) {
  if (!VALID.includes(v)) v = 'system'
  try { wx.setStorageSync(KEY, v) } catch (e) {}
  return v
}

// 系统主题（'dark' | 'light'）。低版本无 theme 字段时回退 light。
function systemTheme() {
  try {
    if (typeof wx.getAppBaseInfo === 'function') {
      const t = wx.getAppBaseInfo().theme
      if (t) return t
    }
    const t = wx.getSystemInfoSync().theme
    return t || 'light'
  } catch (e) {
    return 'light'
  }
}

// 实际生效主题（'dark' | 'light'）：偏好为 system 时取系统主题
function effective() {
  const p = getPref()
  return p === 'system' ? systemTheme() : p
}

// 供全局 Page 包装注入到页面 data 的字段（pageStyle 同时带上字号 --fs）
function injectData(fsScale) {
  const name = effective()
  const c = PALETTE[name] || PALETTE.light
  const fs = fsScale == null ? 1 : fsScale
  return {
    themeName: name,
    themeClass: name === 'dark' ? 't-dark' : 't-light',
    themePref: getPref(),
    pageStyle: `--fs: ${fs}; background: ${c.pageBg}; color: ${c.pageFg};`
  }
}

// 同步原生导航栏 + 窗口背景到当前生效主题（每个页面 onShow 调用；切换主题后也调用）
function applyChrome() {
  const c = PALETTE[effective()] || PALETTE.light
  try { wx.setNavigationBarColor({ frontColor: c.navFront, backgroundColor: c.navBg }) } catch (e) {}
  try { wx.setBackgroundColor({ backgroundColor: c.winBg }) } catch (e) {}
  try { wx.setBackgroundTextStyle({ textStyle: effective() === 'dark' ? 'light' : 'dark' }) } catch (e) {}
}

module.exports = { OPTIONS, getPref, setPref, systemTheme, effective, injectData, applyChrome, PALETTE }
