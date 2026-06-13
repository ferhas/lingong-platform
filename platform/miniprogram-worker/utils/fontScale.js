// 全局字体大小（无障碍）：以缩放因子驱动。
// 原理：各页 wxss 的 font-size 统一写成 calc(Nrpx * var(--fs, 1))，
// 每个页面顶部的 <page-meta page-style="--fs:{{fsScale}}"> 把因子注入 page 根节点，
// CSS 变量自动级联到全部子节点（含自定义组件），改值即时重排，无需重启。
// fsScale 由 app.js 里的全局 Page 包装统一注入到每个页面 data，页面无需各自接入。

const STORAGE_KEY = 'fontScale'

// 档位：键名为 ASCII（避免中文标识符问题），label 仅用于设置页展示。
const OPTIONS = [
  { key: 'small', label: '小', scale: 0.9 },
  { key: 'normal', label: '标准', scale: 1 },
  { key: 'large', label: '大', scale: 1.15 },
  { key: 'xlarge', label: '特大', scale: 1.3 }
]

const DEFAULT_KEY = 'normal'

function scaleOf(key) {
  const hit = OPTIONS.find(o => o.key === key)
  return hit ? hit.scale : 1
}

// 当前档位键（带兜底）。storage 读取失败或未设置时回到“标准”。
function currentKey() {
  let key
  try { key = wx.getStorageSync(STORAGE_KEY) } catch (e) {}
  return OPTIONS.some(o => o.key === key) ? key : DEFAULT_KEY
}

function currentScale() {
  return scaleOf(currentKey())
}

// 持久化新档位。返回对应缩放因子，供调用方就地 setData。
function setKey(key) {
  if (!OPTIONS.some(o => o.key === key)) key = DEFAULT_KEY
  try { wx.setStorageSync(STORAGE_KEY, key) } catch (e) {}
  return scaleOf(key)
}

// 供全局 Page 包装注入到页面 data 的字段。
function injectData() {
  const key = currentKey()
  return { fsScale: scaleOf(key), fsKey: key }
}

module.exports = { OPTIONS, scaleOf, currentKey, currentScale, setKey, injectData }
