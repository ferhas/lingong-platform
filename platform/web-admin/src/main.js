import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import './styles/main.css'
import { useThemeStore } from './stores/theme'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
// 提前实例化主题(useDark),确保登录页也能应用持久化的暗黑模式
useThemeStore(pinia)
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
