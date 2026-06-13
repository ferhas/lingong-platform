// 进程入口：按 ROLE 拆分（多实例水平扩展的前置条件）
//   ROLE=all（默认）：API + 定时任务，单机部署
//   ROLE=api：仅 API（可起多实例挂负载均衡）
//   ROLE=worker：仅定时任务（全局单实例，避免 Job 重复执行）
import app from './app.js'
import config from './config.js'
import { startJobs } from './jobs/index.js'

if (config.role === 'worker') {
  startJobs()
  console.log(`[gigwork-worker] 定时任务进程已启动（ROLE=worker，不监听端口）`)
} else {
  app.listen(config.port, config.host, () => {
    console.log(`[gigwork-server] listening on http://${config.host}:${config.port} (ROLE=${config.role})`)
    if (config.role === 'all') startJobs()
  })
}
