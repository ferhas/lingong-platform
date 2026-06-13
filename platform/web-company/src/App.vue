<template>
  <router-view />
</template>

<script setup>
import { useThemeStore } from './stores/theme'

// 应用启动即激活主题（useDark 读取 localStorage 并写入 html.dark），登录页同样生效
useThemeStore()
</script>
