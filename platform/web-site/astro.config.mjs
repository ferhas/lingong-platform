// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 灵工云官网 · 静态站（Vercel 自动识别 Astro，输出 dist/）
export default defineConfig({
  site: 'https://lingong.eexb.com',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  build: {
    inlineStylesheets: 'auto',
  },
});
