import { defineStore } from 'pinia'
import { useDark, useToggle } from '@vueuse/core'
import { getSettings, patchSettings } from '../api/admin'
import { TOKEN_KEY } from '../api/client'

export const useThemeStore = defineStore('theme', () => {
  // html.dark + localStorage 持久化
  const isDark = useDark({ storageKey: 'gw-admin-theme' })
  const toggleDark = useToggle(isDark)

  /** 登录后从服务端偏好同步主题(静默失败) */
  async function syncFromServer() {
    try {
      const settings = await getSettings()
      if (settings?.theme === 'dark') isDark.value = true
      else if (settings?.theme === 'light') isDark.value = false
    } catch {
      /* 静默失败,以本地为准 */
    }
  }

  /** 切换主题并静默同步到服务端 */
  function toggle() {
    toggleDark()
    if (localStorage.getItem(TOKEN_KEY)) {
      patchSettings({ theme: isDark.value ? 'dark' : 'light' }).catch(() => {})
    }
  }

  return { isDark, toggle, syncFromServer }
})
