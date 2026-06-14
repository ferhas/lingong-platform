import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 生产构建注入基础 CSP（仅 build 生效，不影响 dev HMR）：限制脚本来源为自身，削弱"一旦 XSS 即可
// 窃取 localStorage 令牌"的影响面。frame-ancestors/HSTS 等 meta 不支持，需由 Nginx 响应头补充（见 README）。
// 上线前请用 `npm run preview` 在浏览器确认无 CSP 违规。
function cspPlugin() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ')
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: html => html.replace('</head>', `  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  </head>`)
  }
}

export default defineConfig({
  plugins: [vue(), cspPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    // 关闭 module-preload 内联 polyfill，使 script-src 'self'（无 unsafe-inline）可用；现代浏览器原生支持
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // 拆分重依赖到独立可缓存 chunk：echarts/element-plus 不再被打进路由 chunk
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
          if (id.includes('element-plus') || id.includes('@element-plus/icons-vue')) return 'element-plus'
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('/@vue/') || id.includes('pinia')) return 'vue-vendor'
        }
      }
    }
  }
})
