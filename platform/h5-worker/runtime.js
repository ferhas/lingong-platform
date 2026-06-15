/* =====================================================================
 * 灵工云 零工端 · 微信小程序 → H5 运行时
 * ---------------------------------------------------------------------
 * 不重写任何页面：把 miniprogram-worker 的 .js/.wxml/.wxss 原样跑在浏览器里。
 *  - CommonJS 装载器：在内存中同步 require 小程序源码（来自 window.__MP_FILES__）。
 *  - 表达式求值：with(scope) 形式解释 {{ }} 里的 JS 表达式（与小程序一致）。
 *  - WXML 编译：DOMParser 解析 → 轻量 vnode → keyed patch（输入框打字不丢焦点）。
 *  - WXSS：rpx→calc(var(--rpx))；page 选择器→.wx-page；深色模式原生支持。
 *  - wx.* API：request/storage/导航/toast/modal/actionSheet/picker/上传 等 ~20 个。
 *  - 页面栈 + 导航栏 + 自定义 tabBar + 各种浮层（chrome）。
 * ===================================================================== */
(function () {
  'use strict'
  var MP = window.__MP_FILES__ || {}

  /* ---------------------------------------------------------------- *
   * 0. 小工具
   * ---------------------------------------------------------------- */
  function deepClone(o) {
    if (o == null || typeof o !== 'object') return o
    if (Array.isArray(o)) return o.map(deepClone)
    var r = {}
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = deepClone(o[k])
    return r
  }
  // 解析 setData 的 key 路径，支持 'a.b'、'a.b[2].c'、'list[0].dot'
  function parsePath(key) {
    var parts = []
    key.replace(/[^.[\]]+/g, function (m) { parts.push(m); return m })
    return parts
  }
  function setByPath(obj, key, val) {
    var parts = parsePath(key)
    var o = obj
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i]
      if (o[p] == null || typeof o[p] !== 'object') {
        o[p] = /^\d+$/.test(parts[i + 1]) ? [] : {}
      }
      o = o[p]
    }
    o[parts[parts.length - 1]] = val
  }
  function applyData(data, partial) {
    for (var k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) {
      if (k.indexOf('.') === -1 && k.indexOf('[') === -1) data[k] = partial[k]
      else setByPath(data, k, partial[k])
    }
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase() }) }

  /* ---------------------------------------------------------------- *
   * 1. 表达式求值（{{ }} 内）
   * ---------------------------------------------------------------- */
  var exprCache = {}
  function evalExpr(expr, scope) {
    var fn = exprCache[expr]
    if (!fn) {
      try {
        fn = new Function('$s', 'with($s){ return (' + expr + ') }')
      } catch (e) {
        fn = function () { return undefined }
      }
      exprCache[expr] = fn
    }
    try { return fn(scope) } catch (e) { return undefined }
  }
  // 若整串是单个 {{expr}}（前后无其它文本）→ 返回内部表达式，用于取「原始类型值」
  function pureExpr(str) {
    var t = String(str).trim()
    if (t.slice(0, 2) !== '{{' || t.slice(-2) !== '}}') return null
    var inner = t.slice(2, -2)
    if (inner.indexOf('{{') !== -1 || inner.indexOf('}}') !== -1) return null
    return inner.trim()
  }
  // 含文本的混合串：把每个 {{}} 替换为求值结果字符串
  function evalStr(str, scope) {
    return String(str).replace(/\{\{([\s\S]+?)\}\}/g, function (_, e) {
      var v = evalExpr(e.trim(), scope)
      return v == null ? '' : '' + v
    })
  }
  // 取属性值：单 mustache 返回原始类型，否则返回拼接字符串
  function attrVal(raw, scope) {
    if (raw == null) return ''
    var p = pureExpr(raw)
    if (p != null) return evalExpr(p, scope)
    if (raw.indexOf('{{') === -1) return raw
    return evalStr(raw, scope)
  }

  /* ---------------------------------------------------------------- *
   * 2. WXML 解析（一次）→ 模板 DOM
   * ---------------------------------------------------------------- */
  // 微信 WXML 允许任意标签自闭合（<task-card/>、<textarea/>），HTML 解析器会把后续兄弟
  // 当成其子节点，故先把所有自闭合标签补成成对标签再用 HTML 解析器解析。
  function normalizeSelfClosing(src) {
    return src.replace(
      /<([\w-]+)((?:\s+[\w:.\-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/>/g,
      '<$1$2></$1>'
    )
  }
  var tplCache = {}
  function parseTpl(wxmlPath) {
    if (tplCache[wxmlPath]) return tplCache[wxmlPath]
    var src = MP[wxmlPath] || ''
    var doc = new DOMParser().parseFromString(normalizeSelfClosing(src), 'text/html')
    var nodes = Array.prototype.slice.call(doc.body.childNodes)
    tplCache[wxmlPath] = nodes
    return nodes
  }

  /* ---------------------------------------------------------------- *
   * 3. 渲染：模板 DOM + data → vnode 列表
   * ---------------------------------------------------------------- */
  // vnode: {t, key, cls, style, attrs, dataset, on, val, picker, children, owner}
  // t === '#text' → {t,text}

  var EVENT_ATTRS = {
    bindtap: 'tap', 'bind:tap': 'tap', catchtap: 'tap', 'catch:tap': 'tap',
    bindinput: 'input', 'bind:input': 'input',
    bindchange: 'change', 'bind:change': 'change',
    bindconfirm: 'confirm', 'bind:confirm': 'confirm',
    bindfocus: 'focus', 'bind:focus': 'focus',
    bindblur: 'blur', 'bind:blur': 'blur'
  }
  function isCatch(name) { return name.indexOf('catch') === 0 }

  function renderList(domNodes, scope, owner) {
    var out = []
    var ifActive = false   // 当前 if 链是否已命中
    for (var i = 0; i < domNodes.length; i++) {
      var node = domNodes[i]
      if (node.nodeType === 8) continue // comment
      if (node.nodeType === 3) {        // text
        var txt = node.nodeValue
        if (txt == null) continue
        if (txt.indexOf('{{') !== -1) {
          ifActive = false
          out.push({ t: '#text', text: evalStr(txt, scope) })
        } else if (txt.trim() !== '') {
          ifActive = false
          out.push({ t: '#text', text: txt })
        }
        // 纯空白文本（元素间换行/缩进）：跳过，不重置 if 链。
        continue
      }
      if (node.nodeType !== 1) continue
      var el = node

      // wx:for —— 列表渲染（最高优先级）
      var forAttr = el.getAttribute('wx:for')
      if (forAttr != null) {
        ifActive = false
        var list = attrVal(forAttr, scope)
        var itemName = el.getAttribute('wx:for-item') || 'item'
        var idxName = el.getAttribute('wx:for-index') || 'index'
        var keyExpr = el.getAttribute('wx:key')
        var ifInFor = el.getAttribute('wx:if')
        if (list && typeof list === 'object') {
          var arr = Array.isArray(list) ? list : Object.keys(list).map(function (k) { return list[k] })
          for (var j = 0; j < arr.length; j++) {
            var s = Object.assign({}, scope)
            s[itemName] = arr[j]; s[idxName] = j
            if (ifInFor != null && !attrVal(ifInFor, s)) continue
            var k2 = keyExpr === '*this' ? arr[j]
              : keyExpr && arr[j] && typeof arr[j] === 'object' ? arr[j][keyExpr] : j
            pushOne(out, el, s, owner, k2)
          }
        }
        continue
      }

      // wx:if / wx:elif / wx:else —— 条件链
      var ifAttr = el.getAttribute('wx:if')
      if (ifAttr != null) {
        ifActive = !!attrVal(ifAttr, scope)
        if (ifActive) pushOne(out, el, scope, owner)
        continue
      }
      var elifAttr = el.getAttribute('wx:elif')
      if (elifAttr != null) {
        if (!ifActive) { ifActive = !!attrVal(elifAttr, scope); if (ifActive) pushOne(out, el, scope, owner) }
        continue
      }
      if (el.getAttribute('wx:else') != null) {
        if (!ifActive) pushOne(out, el, scope, owner)
        ifActive = false
        continue
      }

      ifActive = false
      pushOne(out, el, scope, owner)
    }
    return out
  }

  // 渲染单个元素并 push 到 out（block/slot 会摊平多个 vnode）
  function pushOne(out, el, scope, owner, key) {
    var tag = el.tagName.toLowerCase()
    if (tag === 'block') {
      var inner = renderList(Array.prototype.slice.call(el.childNodes), scope, owner)
      for (var i = 0; i < inner.length; i++) out.push(inner[i])
      return
    }
    if (tag === 'slot') {
      var sl = owner && owner.__slot || []
      for (var s = 0; s < sl.length; s++) out.push(sl[s])
      return
    }
    if (tag === 'page-meta' || tag === 'wxs' || tag === 'import' || tag === 'include') return
    // 子组件（如 task-card）
    if (owner && owner.__components && owner.__components[tag]) {
      out.push(renderComponent(owner.__components[tag], el, scope, owner))
      return
    }
    out.push(renderEl(el, scope, owner, key))
  }

  function renderEl(el, scope, owner, key) {
    var tag = el.tagName.toLowerCase()
    var v = { t: tag, key: key, owner: owner, attrs: {}, dataset: {}, on: {}, children: [] }
    var names = el.getAttributeNames()
    for (var i = 0; i < names.length; i++) {
      var name = names[i]
      if (name === 'wx:if' || name === 'wx:elif' || name === 'wx:else' ||
          name === 'wx:for' || name === 'wx:key' || name === 'wx:for-item' || name === 'wx:for-index') continue
      var raw = el.getAttribute(name)
      if (name === 'class') { v.cls = evalStr(raw, scope); continue }
      if (name === 'style') { v.style = cssRpx(evalStr(raw, scope)); continue }
      if (EVENT_ATTRS[name]) { v.on[EVENT_ATTRS[name]] = { handler: raw, catch: isCatch(name) }; continue }
      if (name.indexOf('data-') === 0) { v.dataset[camel(name.slice(5))] = attrVal(raw, scope); continue }
      v.attrs[name] = attrVal(raw, scope)
    }
    // picker：记录 range / value / 显示内容
    if (tag === 'picker') {
      v.picker = {
        range: v.attrs.range || [],
        rangeKey: v.attrs['range-key'],
        value: Number(v.attrs.value) || 0,
        mode: v.attrs.mode || 'selector'
      }
    }
    v.children = renderList(Array.prototype.slice.call(el.childNodes), scope, owner)
    return v
  }

  // 渲染子组件：实例化 → 属性注入 → 渲染其模板（含 slot）→ 返回根 vnode
  function renderComponent(def, el, scope, parent) {
    var props = {}
    for (var p in (def.properties || {})) {
      var raw = el.getAttribute(p) != null ? el.getAttribute(p) : el.getAttribute(p.toLowerCase())
      if (raw != null) props[p] = attrVal(raw, scope)
    }
    var events = {}
    var names = el.getAttributeNames()
    for (var i = 0; i < names.length; i++) {
      var n = names[i]
      if (EVENT_ATTRS[n]) events[EVENT_ATTRS[n]] = el.getAttribute(n)
    }
    var slot = renderList(Array.prototype.slice.call(el.childNodes), scope, parent)
    var inst = makeComponent(def, props, events, parent, slot)
    var tree = renderList(def.__tpl, inst.data, inst)
    var root = tree[0] || { t: 'view', attrs: {}, dataset: {}, on: {}, children: [] }
    return root
  }

  /* ---------------------------------------------------------------- *
   * 4. vnode → DOM + keyed patch
   * ---------------------------------------------------------------- */
  var SCROLL_TAGS = { 'scroll-view': 1 }
  function makeEl(tag) {
    if (tag === 'button') { var b = document.createElement('button'); b.type = 'button'; return b }
    return document.createElement(tag)
  }
  function sameType(a, b) {
    if (!a || !b) return false
    if (a.t === '#text' && b.t === '#text') return true
    return a.t === b.t && a.t !== '#text'
  }
  function dispatch(vnode, evtName, detail, domEl) {
    var spec = vnode.on[evtName]
    if (!spec) return
    var ev = {
      type: evtName, detail: detail || {},
      currentTarget: { dataset: vnode.dataset, id: vnode.attrs.id },
      target: { dataset: vnode.dataset, id: vnode.attrs.id }
    }
    var fn = vnode.owner && vnode.owner[spec.handler]
    if (typeof fn === 'function') fn.call(vnode.owner, ev)
  }

  function applyProps(dom, ov, nv) {
    // class
    var cls = nv.cls != null ? nv.cls : ''
    if (!ov || ov.cls !== nv.cls) dom.className = cls
    // style（含 picker/scroll-view 的附加样式）
    var style = nv.style || ''
    if (SCROLL_TAGS[nv.t]) {
      var sx = nv.attrs['scroll-x'] != null, sy = nv.attrs['scroll-y'] != null
      style += ';overflow-x:' + (sx ? 'auto' : 'hidden') + ';overflow-y:' + (sy ? 'auto' : 'visible')
      if (nv.attrs['enable-flex'] != null) style += ';display:flex'
      style += ';-webkit-overflow-scrolling:touch'
    }
    if (!ov || ov.style !== nv.style || SCROLL_TAGS[nv.t]) dom.style.cssText = style
    // 普通属性
    var attrs = nv.attrs
    if (nv.t === 'input' || nv.t === 'textarea') {
      var type = attrs.type === 'digit' || attrs.type === 'number' ? (attrs.type === 'digit' ? 'text' : 'number') : 'text'
      if (nv.t === 'input') dom.setAttribute('inputmode', attrs.type === 'digit' ? 'decimal' : attrs.type === 'number' ? 'numeric' : 'text')
      if (nv.t === 'input' && dom.type !== type) dom.type = type
      if (attrs.placeholder != null) dom.placeholder = attrs.placeholder; else dom.removeAttribute('placeholder')
      if (attrs.maxlength != null && Number(attrs.maxlength) >= 0) dom.maxLength = Number(attrs.maxlength)
      dom.disabled = !!attrs.disabled
      var val = nv.attrs.value != null ? nv.attrs.value : ''
      if (document.activeElement !== dom && dom.value !== val) dom.value = val
    } else if (nv.t === 'button') {
      dom.disabled = !!attrs.disabled
    } else if (nv.t === 'picker') {
      // 显示内容由 children 渲染，这里只挂点击
    }
    if (attrs.id != null) dom.id = attrs.id

    // 事件（每次 patch 覆盖，闭包捕获最新 vnode）
    dom.onclick = null; dom.oninput = null; dom.onchange = null
    dom.onfocus = null; dom.onblur = null; dom.onkeydown = null
    if (nv.t === 'picker') {
      dom.onclick = function (e) { openPicker(nv, dom) }
    } else if (nv.on.tap) {
      dom.onclick = function (e) {
        if (nv.on.tap.catch) e.stopPropagation()
        dispatch(nv, 'tap', {}, dom)
      }
    }
    if (nv.on.input) dom.oninput = function () { dispatch(nv, 'input', { value: dom.value }, dom) }
    if (nv.on.change && nv.t !== 'picker') dom.onchange = function () { dispatch(nv, 'change', { value: dom.value }, dom) }
    if (nv.on.focus) dom.onfocus = function () { dispatch(nv, 'focus', { value: dom.value }, dom) }
    if (nv.on.blur) dom.onblur = function () { dispatch(nv, 'blur', { value: dom.value }, dom) }
    if (nv.on.confirm) dom.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); dispatch(nv, 'confirm', { value: dom.value }, dom) } }
  }

  function createDom(vnode) {
    if (vnode.t === '#text') return document.createTextNode(vnode.text)
    var dom = makeEl(vnode.t)
    applyProps(dom, null, vnode)
    var kids = vnode.children || []
    for (var i = 0; i < kids.length; i++) dom.appendChild(createDom(kids[i]))
    return dom
  }

  function patchChildren(parent, oldList, newList) {
    oldList = oldList || []; newList = newList || []
    var i
    for (i = 0; i < newList.length; i++) {
      var nv = newList[i], ov = oldList[i], dom = parent.childNodes[i]
      if (!dom) { parent.appendChild(createDom(nv)); continue }
      if (sameType(ov, nv)) patchNode(dom, ov, nv)
      else parent.replaceChild(createDom(nv), dom)
    }
    while (parent.childNodes.length > newList.length) parent.removeChild(parent.lastChild)
  }
  function patchNode(dom, ov, nv) {
    if (nv.t === '#text') { if (dom.nodeValue !== nv.text) dom.nodeValue = nv.text; return }
    applyProps(dom, ov, nv)
    patchChildren(dom, ov.children, nv.children)
  }

  /* ---------------------------------------------------------------- *
   * 5. 组件实例 / 页面实例
   * ---------------------------------------------------------------- */
  function defaultProps(properties) {
    var d = {}
    for (var k in (properties || {})) {
      var def = properties[k]
      d[k] = def && typeof def === 'object' && 'value' in def ? def.value : null
    }
    return d
  }
  function makeComponent(def, props, events, parent, slot) {
    var inst = {}
    var methods = def.methods || {}
    for (var m in methods) inst[m] = methods[m]
    inst.data = Object.assign({}, deepClone(def.data || {}), defaultProps(def.properties), props || {})
    inst.properties = inst.data
    inst.__tpl = def.__tpl
    inst.__slot = slot || []
    inst.__components = def.__components || {}
    inst.triggerEvent = function (name, detail) {
      var h = events && events[name]
      if (h && parent && typeof parent[h] === 'function') {
        parent[h].call(parent, { type: name, detail: detail || {}, currentTarget: { dataset: {} }, target: { dataset: {} } })
      }
    }
    inst.setData = function (partial, cb) {
      applyData(inst.data, partial || {})
      if (inst.__mount) renderInto(inst)
      else if (parent && parent.__rerender) parent.__rerender()
      if (cb) cb()
    }
    inst.selectComponent = function () { return null }
    if (def.lifetimes && def.lifetimes.attached) def.lifetimes.attached.call(inst)
    else if (def.attached) def.attached.call(inst)
    return inst
  }
  // 独立挂载的组件（自定义 tabBar）自渲染
  function renderInto(inst) {
    var tree = renderList(inst.__tpl, inst.data, inst)
    patchChildren(inst.__mount, inst.__vtree || [], tree)
    inst.__vtree = tree
  }

  /* ---------------------------------------------------------------- *
   * 6. 模块装载（极简同步 CommonJS）
   * ---------------------------------------------------------------- */
  var moduleCache = {}
  function joinPath(baseDir, req) {
    var parts = (baseDir ? baseDir.split('/') : [])
    var segs = req.split('/')
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i]
      if (s === '.' || s === '') continue
      if (s === '..') parts.pop()
      else parts.push(s)
    }
    return parts.join('/')
  }
  function resolveModule(from, req) {
    var baseDir = from ? from.split('/').slice(0, -1).join('/') : ''
    var p = req.charAt(0) === '/' ? req.slice(1) : joinPath(baseDir, req)
    if (!/\.js$/.test(p)) p += '.js'
    return p
  }
  function requireModule(path, from) {
    var resolved = from != null ? resolveModule(from, path) : path
    if (moduleCache[resolved]) return moduleCache[resolved].exports
    var code = MP[resolved]
    if (code == null) throw new Error('Cannot find module: ' + resolved + ' (from ' + from + ')')
    var module = { exports: {} }
    moduleCache[resolved] = module
    var fn = new Function('module', 'exports', 'require', code + '\n//# sourceURL=mp/' + resolved)
    fn(module, module.exports, function (r) { return requireModule(r, resolved) })
    return module.exports
  }

  /* ---------------------------------------------------------------- *
   * 7. 全局：App / Page / Component / getApp / getCurrentPages
   * ---------------------------------------------------------------- */
  var appInstance = null
  var pageStack = []          // 页面实例栈
  var pendingPageDef = null   // require 页面 js 时由 Page() 写入
  var pageDefs = {}           // route -> options
  var componentDefs = {}      // path -> def（已解析模板）

  window.App = function (options) { appInstance = options }
  window.getApp = function () { return appInstance }
  window.getCurrentPages = function () { return pageStack }
  window.Page = function (options) { pendingPageDef = options }
  window.Component = function (options) { window.__lastComponent = options }
  window.Behavior = function (o) { return o }

  function loadComponentDef(compPath) {
    // compPath 形如 '/components/task-card/task-card' 或 'components/...'
    var base = compPath.charAt(0) === '/' ? compPath.slice(1) : compPath
    if (componentDefs[base]) return componentDefs[base]
    window.__lastComponent = null
    requireModule(base + '.js')
    var def = window.__lastComponent || {}
    def.__tpl = parseTpl(base + '.wxml')
    // 组件内引用的子组件
    var json = safeJson(MP[base + '.json'])
    def.__components = resolveUsing(json && json.usingComponents, base)
    componentDefs[base] = def
    return def
  }
  function resolveUsing(using, fromBase) {
    var map = {}
    if (!using) return map
    for (var tag in using) {
      var p = using[tag]
      var abs = p.charAt(0) === '/' ? p.slice(1) : joinPath(fromBase.split('/').slice(0, -1).join('/'), p)
      map[tag] = loadComponentDef('/' + abs)
    }
    return map
  }
  function safeJson(s) { try { return JSON.parse(s) } catch (e) { return null } }

  function loadPageDef(route) {
    if (pageDefs[route]) return pageDefs[route]
    pendingPageDef = null
    requireModule(route + '.js')      // 触发 Page(options)
    var def = pendingPageDef || {}
    def.__tpl = parseTpl(route + '.wxml')
    var json = safeJson(MP[route + '.json']) || {}
    def.__json = json
    def.__components = resolveUsing(json.usingComponents, route)
    pageDefs[route] = def
    return def
  }

  /* ---------------------------------------------------------------- *
   * 8. 路由 / 页面栈
   * ---------------------------------------------------------------- */
  var TAB_PAGES = ['pages/index/index', 'pages/orders/orders', 'pages/mine/mine']
  function parseUrl(url) {
    var clean = url.charAt(0) === '/' ? url.slice(1) : url
    var qi = clean.indexOf('?')
    var path = qi === -1 ? clean : clean.slice(0, qi)
    var query = {}
    if (qi !== -1) {
      clean.slice(qi + 1).split('&').forEach(function (kv) {
        if (!kv) return
        var idx = kv.indexOf('=')
        var k = idx === -1 ? kv : kv.slice(0, idx)
        var val = idx === -1 ? '' : decodeURIComponent(kv.slice(idx + 1))
        query[k] = val
      })
    }
    return { path: path, query: query }
  }

  function instantiatePage(route, query) {
    var def = loadPageDef(route)
    var inst = {}
    for (var k in def) {
      if (k === 'data' || k.indexOf('__') === 0) continue
      inst[k] = def[k]
    }
    inst.route = route
    inst.options = query || {}
    inst.data = deepClone(def.data || {})
    inst.__tpl = def.__tpl
    inst.__json = def.__json
    inst.__components = def.__components
    inst.__title = (def.__json && def.__json.navigationBarTitleText) || '灵工云'
    inst.setData = function (partial, cb) {
      applyData(inst.data, partial || {})
      if (inst.__el && inst.__active) inst.__rerender()
      if (cb) cb()
    }
    inst.__rerender = function () {
      var tree = renderList(inst.__tpl, inst.data, inst)
      patchChildren(inst.__el, inst.__vtree || [], tree)
      inst.__vtree = tree
      inst.__el.style.setProperty('--fs', inst.data.fsScale != null ? inst.data.fsScale : 1)
      // 小程序里页面底色/文字色由 <page-meta page-style> 注入页面根；H5 落到 .wx-page 容器，
      // 否则深色模式下 page 默认浅色底/深色字会透出来（与 .t-dark 卡片撞色）。
      applyPageStyle(inst.__el, inst.data.pageStyle)
    }
    inst.getTabBar = function () { return TAB_PAGES.indexOf(route) !== -1 ? tabBarInst : undefined }
    inst.selectComponent = function () { return null }
    inst.animate = function () {}
    inst.createSelectorQuery = function () { return { select: function () { return this }, boundingClientRect: function () { return this }, exec: function (cb) { cb && cb([]) } } }
    return inst
  }

  function mountPage(inst) {
    var el = document.createElement('div')
    el.className = 'wx-page'
    el.setAttribute('data-route', inst.route)
    if (TAB_PAGES.indexOf(inst.route) !== -1) el.classList.add('has-tabbar')
    inst.__el = el
    document.getElementById('wx-pages').appendChild(el)
    ensureStyle(inst.route, inst.__components)
    inst.__active = true
    if (inst.onLoad) try { inst.onLoad(inst.options) } catch (e) { console.error(e) }
    inst.__rerender()
    bindScroll(inst)
    if (inst.onShow) try { inst.onShow() } catch (e) { console.error(e) }
    inst.__rerender()
    if (inst.onReady) try { inst.onReady() } catch (e) { console.error(e) }
    Chrome.refresh()
  }

  function showTop() {
    for (var i = 0; i < pageStack.length; i++) {
      var p = pageStack[i]
      p.__el.style.display = i === pageStack.length - 1 ? 'block' : 'none'
    }
    var top = pageStack[pageStack.length - 1]
    if (top) { document.title = top.__title; Chrome.refresh() }
  }

  var Router = {
    navigateTo: function (url) {
      var u = parseUrl(url)
      var inst = instantiatePage(u.path, u.query)
      var prev = pageStack[pageStack.length - 1]
      if (prev) { prev.__active = false; if (prev.onHide) try { prev.onHide() } catch (e) {} }
      pageStack.push(inst)
      mountPage(inst)
      showTop()
    },
    redirectTo: function (url) {
      var u = parseUrl(url)
      var prev = pageStack.pop()
      if (prev) { if (prev.onUnload) try { prev.onUnload() } catch (e) {} prev.__el.remove() }
      var inst = instantiatePage(u.path, u.query)
      pageStack.push(inst)
      mountPage(inst)
      showTop()
    },
    reLaunch: function (url) {
      while (pageStack.length) {
        var p = pageStack.pop()
        if (p.onUnload) try { p.onUnload() } catch (e) {}
        p.__el.remove()
      }
      Router.navigateTo(url)
    },
    switchTab: function (url) {
      Router.reLaunch(url)
    },
    navigateBack: function (delta) {
      delta = delta || 1
      while (delta-- > 0 && pageStack.length > 1) {
        var p = pageStack.pop()
        if (p.onUnload) try { p.onUnload() } catch (e) {}
        p.__el.remove()
      }
      var top = pageStack[pageStack.length - 1]
      if (top) { top.__active = true; if (top.onShow) try { top.onShow() } catch (e) {} top.__rerender() }
      showTop()
    }
  }

  // 滚动：onReachBottom（触底加载）+ 下拉刷新
  function bindScroll(inst) {
    var el = inst.__el
    var reaching = false
    el.addEventListener('scroll', function () {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
        if (!reaching && inst.onReachBottom) { reaching = true; try { inst.onReachBottom() } catch (e) {} setTimeout(function () { reaching = false }, 400) }
      }
    })
    // 下拉刷新（指针拖拽）
    if (inst.__json && inst.__json.enablePullDownRefresh) {
      var startY = 0, pulling = false
      el.addEventListener('touchstart', function (e) { if (el.scrollTop <= 0) { startY = e.touches[0].clientY; pulling = true } }, { passive: true })
      el.addEventListener('touchmove', function (e) {
        if (!pulling) return
        var dy = e.touches[0].clientY - startY
        if (dy > 70) { pulling = false; triggerPull(inst) }
      }, { passive: true })
      el.addEventListener('touchend', function () { pulling = false })
    }
  }
  function triggerPull(inst) {
    Chrome.toast({ title: '刷新中…', icon: 'loading', duration: 600 })
    if (inst.onPullDownRefresh) try { inst.onPullDownRefresh() } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * 9. WXSS 注入（rpx → calc(var(--rpx))，page → .wx-page）
   * ---------------------------------------------------------------- */
  // H5 统一走浅色主题：真机/桌面深色系统下小程序的深色配色偏暗发闷，这里强制浅色，
  // 视觉更清爽统一。想恢复「跟随系统深色」把 FORCE_LIGHT 改 false 即可。
  var FORCE_LIGHT = true
  // 去掉 @media (prefers-color-scheme: dark){...} 整块（花括号配平，保留其余 @media）
  function stripDarkMedia(css) {
    var out = '', i = 0
    while (i < css.length) {
      var at = css.indexOf('@media', i)
      if (at === -1) { out += css.slice(i); break }
      var open = css.indexOf('{', at)
      if (open === -1) { out += css.slice(i); break }
      var head = css.slice(at, open)
      if (/prefers-color-scheme\s*:\s*dark/.test(head)) {
        out += css.slice(i, at)
        var depth = 0, j = open
        for (; j < css.length; j++) {
          if (css[j] === '{') depth++
          else if (css[j] === '}') { depth--; if (depth === 0) { j++; break } }
        }
        i = j
      } else { out += css.slice(i, open + 1); i = open + 1 }
    }
    return out
  }
  function cssRpx(css) {
    return String(css).replace(/(-?\d*\.?\d+)rpx/g, function (_, n) { return 'calc(' + n + ' * var(--rpx))' })
  }
  // 判断颜色是否偏暗（用于由顶栏背景推断当前主题明暗）。支持 #rrggbb 与 rgb()。
  function isDarkColor(c) {
    c = String(c || '').trim()
    var r, g, b, m = c.match(/^#([0-9a-fA-F]{6})$/)
    if (m) { var n = parseInt(m[1], 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255 }
    else { var rm = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); if (!rm) return false; r = +rm[1]; g = +rm[2]; b = +rm[3] }
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128
  }
  // 把页面 page-style（形如 "--fs:1; background:<grad>; color:<c>;"）逐条落到 .wx-page 根容器，
  // rpx→calc；逐条 setProperty 而非整体 cssText，保留 showTop 设置的 display 等内联样式。
  function applyPageStyle(el, style) {
    if (!el || !style) return
    cssRpx(style).split(';').forEach(function (decl) {
      var i = decl.indexOf(':')
      if (i === -1) return
      var prop = decl.slice(0, i).trim()
      if (prop) el.style.setProperty(prop, decl.slice(i + 1).trim())
    })
  }
  function transformWxss(css) {
    if (FORCE_LIGHT) css = stripDarkMedia(css)
    css = cssRpx(css)
    // page 选择器 → .wx-page（注意只替换选择器位置的 page，不动 page-* 类名）
    css = css.replace(/(^|[},])\s*page\b/g, function (m, pre) { return pre + ' .wx-page' })
    return css
  }
  var injectedStyles = {}
  function injectStyle(id, css) {
    if (injectedStyles[id]) return
    injectedStyles[id] = true
    var s = document.createElement('style')
    s.setAttribute('data-wxss', id)
    s.textContent = transformWxss(css)
    document.head.appendChild(s)
  }
  function ensureStyle(route, components) {
    injectStyle('page:' + route, MP[route + '.wxss'] || '')
    if (components) for (var tag in components) {
      var def = components[tag]
      // 找到组件的 wxss 路径：componentDefs key
      for (var p in componentDefs) if (componentDefs[p] === def) injectStyle('comp:' + p, MP[p + '.wxss'] || '')
    }
  }

  /* ---------------------------------------------------------------- *
   * 10. Chrome：导航栏 / tabBar / 浮层
   * ---------------------------------------------------------------- */
  var tabBarInst = null
  var Chrome = {
    refresh: function () {
      var top = pageStack[pageStack.length - 1]
      if (!top) return
      var isTab = TAB_PAGES.indexOf(top.route) !== -1
      var nav = document.getElementById('wx-navbar')
      nav.querySelector('.nav-title').textContent = top.__title || ''
      var back = nav.querySelector('.nav-back')
      back.style.visibility = (!isTab && pageStack.length > 1) ? 'visible' : 'hidden'
      // tabBar 显隐 + 选中态
      var tb = document.getElementById('wx-tabbar')
      tb.style.display = isTab ? 'block' : 'none'
      if (isTab && tabBarInst) {
        if (tabBarInst.pageLifetimes && tabBarInst.pageLifetimes.show) tabBarInst.pageLifetimes.show.call(tabBarInst)
        else if (tabBarInst.syncSelected) tabBarInst.syncSelected()
      }
    },
    setTitle: function (title) {
      var top = pageStack[pageStack.length - 1]
      if (top) { top.__title = title; document.getElementById('wx-navbar').querySelector('.nav-title').textContent = title; document.title = title }
    },
    toast: function (opt) {
      var dur = opt.duration || 1500
      var root = overlayRoot()
      var box = document.createElement('div')
      box.className = 'wx-toast' + (opt.icon === 'none' ? ' wx-toast-text' : '')
      var icon = ''
      if (opt.icon === 'success') icon = '<div class="wx-toast-icon">✓</div>'
      else if (opt.icon === 'error') icon = '<div class="wx-toast-icon">✕</div>'
      else if (opt.icon === 'loading') icon = '<div class="wx-toast-icon wx-spin">◠</div>'
      box.innerHTML = icon + '<div class="wx-toast-title"></div>'
      box.querySelector('.wx-toast-title').textContent = opt.title || ''
      root.appendChild(box)
      setTimeout(function () { box.remove() }, dur)
    },
    loading: function (opt) {
      Chrome.hideLoading()
      var root = overlayRoot()
      var box = document.createElement('div')
      box.id = 'wx-loading'
      box.className = 'wx-toast'
      box.innerHTML = '<div class="wx-toast-icon wx-spin">◠</div><div class="wx-toast-title"></div>'
      box.querySelector('.wx-toast-title').textContent = (opt && opt.title) || '加载中'
      root.appendChild(box)
    },
    hideLoading: function () { var e = document.getElementById('wx-loading'); if (e) e.remove() },
    modal: function (opt) {
      return new Promise(function (resolve) {
        var root = overlayRoot()
        var mask = document.createElement('div')
        mask.className = 'wx-mask'
        var showCancel = opt.showCancel !== false
        var editable = !!opt.editable
        mask.innerHTML =
          '<div class="wx-dialog">' +
          '<div class="wx-dialog-title"></div>' +
          (opt.content != null ? '<div class="wx-dialog-content"></div>' : '') +
          (editable ? '<textarea class="wx-dialog-input" rows="3"></textarea>' : '') +
          '<div class="wx-dialog-btns">' +
          (showCancel ? '<button class="wx-dialog-btn wx-dialog-cancel" type="button"></button>' : '') +
          '<button class="wx-dialog-btn wx-dialog-ok" type="button"></button>' +
          '</div></div>'
        mask.querySelector('.wx-dialog-title').textContent = opt.title || ''
        if (opt.content != null) mask.querySelector('.wx-dialog-content').textContent = opt.content
        var input = mask.querySelector('.wx-dialog-input')
        if (input && opt.placeholderText) input.placeholder = opt.placeholderText
        var ok = mask.querySelector('.wx-dialog-ok'); ok.textContent = opt.confirmText || '确定'
        var cancel = mask.querySelector('.wx-dialog-cancel'); if (cancel) cancel.textContent = opt.cancelText || '取消'
        function close() { mask.remove() }
        ok.onclick = function () { var c = input ? input.value : ''; close(); resolve({ confirm: true, cancel: false, content: c }) }
        if (cancel) cancel.onclick = function () { close(); resolve({ confirm: false, cancel: true, content: '' }) }
        root.appendChild(mask)
        if (input) input.focus()
      })
    },
    actionSheet: function (opt) {
      return new Promise(function (resolve, reject) {
        var root = overlayRoot()
        var mask = document.createElement('div')
        mask.className = 'wx-mask wx-mask-bottom'
        var html = '<div class="wx-sheet">'
        ;(opt.itemList || []).forEach(function (it, i) { html += '<button class="wx-sheet-item" type="button" data-i="' + i + '"></button>' })
        html += '<button class="wx-sheet-item wx-sheet-cancel" type="button">取消</button></div>'
        mask.innerHTML = html
        var items = mask.querySelectorAll('.wx-sheet-item')
        ;(opt.itemList || []).forEach(function (it, i) { items[i].textContent = it })
        mask.querySelectorAll('.wx-sheet-item').forEach(function (btn) {
          btn.onclick = function () {
            var i = btn.getAttribute('data-i')
            mask.remove()
            if (i == null) reject({ errMsg: 'showActionSheet:fail cancel' })
            else resolve({ tapIndex: Number(i) })
          }
        })
        mask.onclick = function (e) { if (e.target === mask) { mask.remove(); reject({ errMsg: 'showActionSheet:fail cancel' }) } }
        root.appendChild(mask)
      })
    }
  }
  function overlayRoot() { return document.getElementById('wx-overlay') }

  // picker 选择浮层（selector 模式）
  function openPicker(vnode, dom) {
    var p = vnode.picker
    var range = p.range || []
    var root = overlayRoot()
    var mask = document.createElement('div')
    mask.className = 'wx-mask wx-mask-bottom'
    var html = '<div class="wx-sheet wx-picker">'
    range.forEach(function (it, i) {
      var label = p.rangeKey ? (it && it[p.rangeKey]) : it
      html += '<button class="wx-sheet-item' + (i === p.value ? ' wx-picker-on' : '') + '" type="button" data-i="' + i + '"></button>'
    })
    html += '</div>'
    mask.innerHTML = html
    var btns = mask.querySelectorAll('.wx-sheet-item')
    range.forEach(function (it, i) { btns[i].textContent = p.rangeKey ? (it && it[p.rangeKey]) : it })
    btns.forEach(function (btn) {
      btn.onclick = function () {
        var i = Number(btn.getAttribute('data-i'))
        mask.remove()
        dispatch(vnode, 'change', { value: i }, dom)
      }
    })
    mask.onclick = function (e) { if (e.target === mask) mask.remove() }
    root.appendChild(mask)
  }

  /* ---------------------------------------------------------------- *
   * 11. wx.* API
   * ---------------------------------------------------------------- */
  var fileStore = {}      // wxfile://id -> File
  var fileSeq = 0
  function storageGet(key) {
    try {
      var v = localStorage.getItem('wx:' + key)
      if (v == null) return ''
      return JSON.parse(v)
    } catch (e) { return '' }
  }
  function storageSet(key, val) { try { localStorage.setItem('wx:' + key, JSON.stringify(val)) } catch (e) {} }

  var wx = {
    // —— 存储 ——
    getStorageSync: storageGet,
    setStorageSync: storageSet,
    removeStorageSync: function (key) { try { localStorage.removeItem('wx:' + key) } catch (e) {} },
    getStorage: function (o) { var v = storageGet(o.key); (v !== '' ? o.success : o.fail) && (v !== '' ? o.success({ data: v }) : o.fail({})); o.complete && o.complete() },
    setStorage: function (o) { storageSet(o.key, o.data); o.success && o.success(); o.complete && o.complete() },

    // —— 网络 ——
    request: function (o) {
      var method = (o.method || 'GET').toUpperCase()
      var url = o.url
      var headers = o.header || {}
      var init = { method: method, headers: headers }
      if (method !== 'GET' && method !== 'HEAD' && o.data != null) {
        init.body = typeof o.data === 'string' ? o.data : JSON.stringify(o.data)
      }
      fetch(url, init).then(function (res) {
        return res.text().then(function (text) {
          var data
          try { data = JSON.parse(text) } catch (e) { data = text }
          var h = {}; res.headers.forEach(function (v, k) { h[k] = v })
          o.success && o.success({ statusCode: res.status, data: data, header: h })
          o.complete && o.complete()
        })
      }).catch(function (err) {
        o.fail && o.fail({ errMsg: 'request:fail ' + err })
        o.complete && o.complete()
      })
      return { abort: function () {} }
    },
    uploadFile: function (o) {
      var file = fileStore[o.filePath]
      var fd = new FormData()
      if (file) fd.append(o.name || 'file', file, file.name)
      var headers = {}
      for (var k in (o.header || {})) headers[k] = o.header[k]
      if (o.formData) for (var f in o.formData) fd.append(f, o.formData[f])
      fetch(o.url, { method: 'POST', headers: headers, body: fd }).then(function (res) {
        return res.text().then(function (text) {
          o.success && o.success({ statusCode: res.status, data: text })
          o.complete && o.complete()
        })
      }).catch(function (err) {
        o.fail && o.fail({ errMsg: 'uploadFile:fail ' + err })
        o.complete && o.complete()
      })
      return { abort: function () {} }
    },
    chooseMessageFile: function (o) {
      var input = document.createElement('input')
      input.type = 'file'
      if ((o.count || 1) > 1) input.multiple = true
      input.style.position = 'fixed'; input.style.left = '-9999px'
      document.body.appendChild(input)
      input.onchange = function () {
        var files = Array.prototype.slice.call(input.files || [])
        document.body.removeChild(input)
        if (!files.length) { o.fail && o.fail({ errMsg: 'chooseMessageFile:fail cancel' }); o.complete && o.complete(); return }
        var tempFiles = files.slice(0, o.count || files.length).map(function (f) {
          var path = 'wxfile://' + (++fileSeq)
          fileStore[path] = f
          return { path: path, name: f.name, size: f.size, type: 'file' }
        })
        o.success && o.success({ tempFiles: tempFiles, tempFilePaths: tempFiles.map(function (t) { return t.path }) })
        o.complete && o.complete()
      }
      input.click()
    },
    chooseImage: function (o) {
      var input = document.createElement('input')
      input.type = 'file'; input.accept = 'image/*'
      if ((o.count || 1) > 1) input.multiple = true
      input.style.position = 'fixed'; input.style.left = '-9999px'
      document.body.appendChild(input)
      input.onchange = function () {
        var files = Array.prototype.slice.call(input.files || [])
        document.body.removeChild(input)
        if (!files.length) { o.fail && o.fail({ errMsg: 'chooseImage:fail cancel' }); o.complete && o.complete(); return }
        var tempFiles = files.slice(0, o.count || files.length).map(function (f) {
          var path = 'wxfile://' + (++fileSeq); fileStore[path] = f
          return { path: path, size: f.size }
        })
        o.success && o.success({ tempFilePaths: tempFiles.map(function (t) { return t.path }), tempFiles: tempFiles })
        o.complete && o.complete()
      }
      input.click()
    },
    chooseMedia: function (o) {
      var input = document.createElement('input')
      input.type = 'file'
      var mt = o.mediaType || ['image']
      input.accept = mt.indexOf('video') >= 0 ? 'video/*' : 'image/*'
      if ((o.count || 1) > 1) input.multiple = true
      input.style.position = 'fixed'; input.style.left = '-9999px'
      document.body.appendChild(input)
      input.onchange = function () {
        var files = Array.prototype.slice.call(input.files || [])
        document.body.removeChild(input)
        if (!files.length) { o.fail && o.fail({ errMsg: 'chooseMedia:fail cancel' }); o.complete && o.complete(); return }
        var tempFiles = files.slice(0, o.count || files.length).map(function (f) {
          var path = 'wxfile://' + (++fileSeq); fileStore[path] = f
          return { tempFilePath: path, size: f.size, fileType: (f.type.indexOf('video') >= 0 ? 'video' : 'image') }
        })
        o.success && o.success({ tempFiles: tempFiles })
        o.complete && o.complete()
      }
      input.click()
    },

    // —— 导航 ——
    navigateTo: function (o) { Router.navigateTo(o.url); o.success && o.success(); o.complete && o.complete() },
    redirectTo: function (o) { Router.redirectTo(o.url); o.success && o.success(); o.complete && o.complete() },
    reLaunch: function (o) { Router.reLaunch(o.url); o.success && o.success(); o.complete && o.complete() },
    switchTab: function (o) { Router.switchTab(o.url); o.success && o.success(); o.complete && o.complete() },
    navigateBack: function (o) { Router.navigateBack((o && o.delta) || 1); o && o.success && o.success(); o && o.complete && o.complete() },

    // —— 交互浮层 ——
    showToast: function (o) { Chrome.toast(o || {}); o && o.success && o.success(); o && o.complete && o.complete() },
    hideToast: function () {},
    showLoading: function (o) { Chrome.loading(o || {}); o && o.success && o.success() },
    hideLoading: function () { Chrome.hideLoading() },
    showModal: function (o) {
      o = o || {}
      Chrome.modal(o).then(function (r) { o.success && o.success(r); o.complete && o.complete() })
    },
    showActionSheet: function (o) {
      o = o || {}
      Chrome.actionSheet(o).then(function (r) { o.success && o.success(r); o.complete && o.complete() })
        .catch(function (e) { o.fail && o.fail(e); o.complete && o.complete() })
    },

    // —— 导航栏 / tabBar ——
    setNavigationBarTitle: function (o) { Chrome.setTitle(o.title); o.success && o.success() },
    setNavigationBarColor: function (o) {
      // 小程序原生导航栏对应 H5 宿主的 #wx-navbar。honor 颜色让 theme.applyChrome() 的深/浅色生效
      // （深色 navBg=#0F172A、浅色 #0F766E），否则顶栏恒为亮青、与深色 hero 撞色。
      if (o && o.backgroundColor) {
        var nav = document.getElementById('wx-navbar')
        if (nav) {
          nav.style.background = o.backgroundColor
          nav.style.color = o.frontColor || '#fff'
          var back = nav.querySelector('.nav-back'); if (back) back.style.color = o.frontColor || '#fff'
        }
        // 顶栏背景明暗 == 当前主题明暗：同步到 #wx-app 的 wx-dark 类，让宿主浮层
        // （wx.showModal/showActionSheet/picker）也跟随深色，避免深色页弹出白底框。
        var app = document.getElementById('wx-app')
        if (app) app.classList.toggle('wx-dark', isDarkColor(o.backgroundColor))
      }
      o && o.success && o.success()
    },
    showNavigationBarLoading: function () {},
    hideNavigationBarLoading: function () {},
    startPullDownRefresh: function (o) { var t = pageStack[pageStack.length - 1]; if (t && t.onPullDownRefresh) triggerPull(t); o && o.success && o.success() },
    stopPullDownRefresh: function (o) { o && o.success && o.success() },
    showTabBarRedDot: function (o) { if (tabBarInst && tabBarInst.setDot) tabBarInst.setDot(o.index, true) },
    hideTabBarRedDot: function (o) { if (tabBarInst && tabBarInst.setDot) tabBarInst.setDot(o.index, false) },
    setTabBarBadge: function () {}, removeTabBarBadge: function () {},

    // —— 微信登录（H5 无微信：复用体验账号 code，使「一键登录」可用）——
    login: function (o) { o.success && o.success({ code: 'demo-worker-2month-001', errMsg: 'login:ok' }) },
    checkSession: function (o) { o && o.fail && o.fail({}) },
    requestSubscribeMessage: function (o) { o && o.complete && o.complete({}); o && o.success && o.success({}) },
    getUserProfile: function (o) { o && o.fail && o.fail({ errMsg: 'getUserProfile:fail' }) },
    getSetting: function (o) { o && o.success && o.success({ authSetting: {} }) },

    // —— 杂项 ——
    stopPullDownRefresh: function (o) { o && o.success && o.success() },
    pageScrollTo: function (o) { var t = pageStack[pageStack.length - 1]; if (t && t.__el) t.__el.scrollTop = o.scrollTop || 0; o.success && o.success() },
    setClipboardData: function (o) {
      try { navigator.clipboard && navigator.clipboard.writeText(o.data || '') } catch (e) {}
      Chrome.toast({ title: '已复制', icon: 'success' })
      o.success && o.success()
    },
    makePhoneCall: function (o) { Chrome.toast({ title: '拨号：' + (o.phoneNumber || ''), icon: 'none' }); o.success && o.success() },
    previewImage: function (o) { if (o.urls && o.urls[0]) window.open(o.current || o.urls[0], '_blank'); o.success && o.success() },
    getSystemInfoSync: function () {
      return {
        platform: 'h5', system: 'H5', SDKVersion: '3.0.0', version: 'h5',
        windowWidth: window.innerWidth, windowHeight: window.innerHeight,
        screenWidth: window.innerWidth, screenHeight: window.innerHeight,
        statusBarHeight: 0, safeArea: { top: 0, bottom: window.innerHeight }, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
    },
    getSystemInfo: function (o) { o && o.success && o.success(wx.getSystemInfoSync()) },
    onThemeChange: function () {}, offThemeChange: function () {},
    nextTick: function (cb) { Promise.resolve().then(cb) },
    createSelectorQuery: function () { return { select: function () { return this }, selectAll: function () { return this }, boundingClientRect: function () { return this }, scrollOffset: function () { return this }, exec: function (cb) { cb && cb([]) } } },
    showShareMenu: function () {}, hideShareMenu: function () {}
  }
  window.wx = wx

  /* ---------------------------------------------------------------- *
   * 12. 启动
   * ---------------------------------------------------------------- */
  function setRpx() {
    var app = document.getElementById('wx-app')
    var w = app ? app.clientWidth : window.innerWidth
    // 关键：必须带 px 单位。calc(88 * var(--rpx)) 里 --rpx 若是无单位数字，
    // 结果是无单位数 → 不是合法长度 → 整条规则被丢弃（padding/圆角/高度全失效）。
    document.documentElement.style.setProperty('--rpx', (w / 750) + 'px')
  }

  function boot() {
    // 必须先注入基础样式（含 #wx-app 的 max-width:480 手机框）再算 --rpx：
    // 否则 DOMContentLoaded 时 #wx-app 仍是 body 全宽，桌面浏览器下 --rpx 会按 ~1300/750 算，
    // 导致整页 rpx 尺寸放大约 2.7×、文字逐字换行、布局崩坏（移动端视口本就≤480 故侥幸正常）。
    injectBaseCss()
    setRpx()
    window.addEventListener('resize', setRpx)

    // 注入全局样式（app.wxss + 自定义 tabBar wxss）
    injectStyle('app', MP['app.wxss'] || '')

    // 执行 app.js（注册 App、包装全局 Page 注入字体缩放/登录守卫）
    requireModule('app.js')

    // H5 同源：把 apiBase 改为相对路径，避免 127.0.0.1/localhost 跨域
    if (appInstance && appInstance.globalData) appInstance.globalData.apiBase = '/api/v1'

    // 自定义 tabBar 组件实例（挂到底部栏）
    var tabDef = loadComponentDef('/custom-tab-bar/index')
    injectStyle('comp:custom-tab-bar/index', MP['custom-tab-bar/index.wxss'] || '')
    tabBarInst = makeComponent(tabDef, {}, {}, null, [])
    tabBarInst.__mount = document.getElementById('wx-tabbar')
    renderInto(tabBarInst)

    // app onLaunch（无 token 会 reLaunch 到登录页）
    if (appInstance && appInstance.onLaunch) try { appInstance.onLaunch() } catch (e) { console.error(e) }
    // 若 onLaunch 未导航（已登录），进入首页
    if (!pageStack.length) Router.reLaunch('/pages/index/index')
  }

  function injectBaseCss() {
    var css =
      'html{color-scheme:light;}' +
      'html,body{margin:0;padding:0;height:100%;background:#e7ecf1;}' +
      // transform 让 #wx-app 成为 position:fixed 后代的包含块，否则自定义 tabBar 的 .tab-shell(fixed)
      // 与各页 .modal-mask(fixed) 会相对视口定位、在桌面宽屏铺满全宽（底部导航比内容宽）。
      '#wx-app{position:relative;width:100%;max-width:480px;height:100vh;margin:0 auto;background:#F3F7F6;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 0 50px rgba(15,23,42,.18);transform:translateZ(0);}' +
      // 隐藏所有滚动条（贴合 App 观感：横向类目条、纵向页面、底部弹层均无滚动条）
      '.wx-page,scroll-view,.wx-sheet,.wx-dialog-content{scrollbar-width:none;-ms-overflow-style:none;}' +
      '.wx-page::-webkit-scrollbar,scroll-view::-webkit-scrollbar,.wx-sheet::-webkit-scrollbar,.wx-dialog-content::-webkit-scrollbar{width:0;height:0;display:none;}' +
      '#wx-navbar{flex:0 0 auto;height:48px;background:#0F766E;color:#fff;display:flex;align-items:center;position:relative;z-index:20;padding:0 8px;}' +
      '#wx-navbar .nav-back{width:40px;text-align:center;font-size:22px;cursor:pointer;background:none;border:none;color:#fff;}' +
      '#wx-navbar .nav-title{position:absolute;left:0;right:0;text-align:center;font-size:16px;font-weight:600;pointer-events:none;}' +
      '#wx-pages{flex:1 1 auto;position:relative;overflow:hidden;}' +
      '.wx-page{position:absolute;inset:0;overflow-y:auto;-webkit-overflow-scrolling:touch;--fs:1;}' +
      '.wx-page.has-tabbar{bottom:0;}' +
      '#wx-tabbar{flex:0 0 auto;z-index:20;}' +
      '#wx-overlay{position:absolute;inset:0;pointer-events:none;z-index:1000;}' +
      '#wx-overlay>*{pointer-events:auto;}' +
      // 标签默认显示，贴合小程序
      'view,scroll-view{display:block;}text{display:inline;}image{display:inline-block;}' +
      // 小程序 <button> 默认块级且撑满容器宽度；HTML 按钮默认按内容宽，故显式 width:100%。
      'button{display:block;width:100%;box-sizing:border-box;margin:0;padding:0;font:inherit;color:inherit;background:none;border:none;text-align:center;line-height:normal;cursor:pointer;}' +
      // 处于 flex 行内、需按内容宽的按钮（如「我的接单」卡片操作区的并排按钮）还原 auto。
      '.card-actions button{width:auto;}' +
      'input,textarea{font:inherit;border:none;outline:none;background:none;-webkit-appearance:none;appearance:none;}' +
      'picker{display:block;cursor:pointer;}' +
      // 浮层
      '.wx-toast{position:absolute;top:45%;left:50%;transform:translate(-50%,-50%);background:rgba(17,24,39,.86);color:#fff;border-radius:12px;padding:18px 22px;min-width:120px;max-width:70%;text-align:center;font-size:14px;display:flex;flex-direction:column;align-items:center;gap:8px;}' +
      '.wx-toast-text{padding:12px 18px;}' +
      '.wx-toast-icon{font-size:30px;line-height:1;}' +
      '.wx-toast-title{white-space:pre-wrap;line-height:1.5;}' +
      '.wx-spin{display:inline-block;animation:wxspin 0.8s linear infinite;}' +
      '@keyframes wxspin{to{transform:rotate(360deg);}}' +
      '.wx-mask{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:32px;}' +
      '.wx-mask-bottom{align-items:flex-end;padding:0;}' +
      '.wx-dialog{background:#fff;border-radius:14px;width:100%;max-width:320px;padding:22px 0 0;overflow:hidden;}' +
      '.wx-dialog-title{font-size:17px;font-weight:700;text-align:center;color:#111;padding:0 20px;}' +
      '.wx-dialog-content{font-size:14px;color:#555;text-align:left;white-space:pre-wrap;line-height:1.6;padding:12px 22px 4px;max-height:46vh;overflow:auto;}' +
      '.wx-dialog-input{display:block;margin:14px 20px 4px;width:calc(100% - 40px);box-sizing:border-box;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:14px;resize:none;}' +
      '.wx-dialog-btns{display:flex;border-top:1px solid #eee;margin-top:18px;}' +
      '.wx-dialog-btn{flex:1;height:48px;font-size:16px;background:#fff;border:none;cursor:pointer;}' +
      '.wx-dialog-cancel{color:#666;border-right:1px solid #eee;}' +
      '.wx-dialog-ok{color:#0F766E;font-weight:600;}' +
      '.wx-sheet{background:#f7f7f7;width:100%;border-radius:14px 14px 0 0;overflow:hidden;padding-bottom:env(safe-area-inset-bottom);max-height:60vh;overflow-y:auto;}' +
      '.wx-sheet-item{display:block;width:100%;height:52px;font-size:16px;background:#fff;border:none;border-bottom:1px solid #f0f0f0;cursor:pointer;color:#111;}' +
      '.wx-sheet-cancel{margin-top:8px;color:#666;font-weight:600;}' +
      '.wx-picker-on{color:#0F766E;font-weight:600;}' +
      // 深色主题（#wx-app.wx-dark）下宿主浮层跟随，避免深色页弹出白底框/选择面板
      '.wx-dark .wx-dialog{background:#16202E;}' +
      '.wx-dark .wx-dialog-title{color:#E5E7EB;}' +
      '.wx-dark .wx-dialog-content{color:#94A3B8;}' +
      '.wx-dark .wx-dialog-input{background:#0F172A;border-color:#233149;color:#E5E7EB;}' +
      '.wx-dark .wx-dialog-btns{border-top-color:#233149;}' +
      '.wx-dark .wx-dialog-btn{background:#16202E;}' +
      '.wx-dark .wx-dialog-cancel{color:#94A3B8;border-right-color:#233149;}' +
      '.wx-dark .wx-dialog-ok{color:#5EEAD4;}' +
      '.wx-dark .wx-sheet{background:#0F172A;}' +
      '.wx-dark .wx-sheet-item{background:#16202E;color:#E5E7EB;border-bottom-color:#233149;}' +
      '.wx-dark .wx-sheet-cancel{background:#16202E;color:#94A3B8;}' +
      '.wx-dark .wx-picker-on{color:#5EEAD4;}'
    var s = document.createElement('style')
    s.setAttribute('data-wxss', 'base')
    s.textContent = css
    document.head.appendChild(s)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
