// 把 H5 零工端的静态文件装配进 dist/ 供 Vercel 托管。
// 先由 build.mjs 从 ../miniprogram-worker 重新生成 mp-bundle.js（见 package.json 的 build 脚本），
// 这里只负责把宿主页 + 运行时 + bundle 三个文件复制到一个干净的发布目录。
// 用法：node dist.mjs（通常作为 `node build.mjs && node dist.mjs` 的第二步）
import { mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
const FILES = ['index.html', 'runtime.js', 'mp-bundle.js']

await mkdir(dist, { recursive: true })
for (const f of FILES) {
  await copyFile(path.join(here, f), path.join(dist, f))
}
console.log(`[h5 dist] assembled ${FILES.length} files → ${dist}`)
