import { defineStore } from 'pinia'
import { useDark, useToggle } from '@vueuse/core'
import client from '../api/client'

export const useThemeStore = defineStore('theme', () => {
  const isDark = useDark({ storageKey: 'gw-company-theme' })
  const toggleDark = useToggle(isDark)

  // 登录后调用：读服务端设置同步主题（静默失败）
  async function syncFromServer() {
    try {
      const settings = await client.get('/me/settings', { silent: true })
      if (settings?.theme === 'dark') isDark.value = true
      else if (settings?.theme === 'light') isDark.value = false
    } catch {
      // 静默失败，保留本地主题
    }
  }

  // 切换主题并持久化到服务端（静默失败）
  function toggle() {
    toggleDark()
    client.patch('/me/settings', { theme: isDark.value ? 'dark' : 'light' }, { silent: true }).catch(() => {})
  }

  return { isDark, toggle, syncFromServer }
})
