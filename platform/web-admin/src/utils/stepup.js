import { ElMessage, ElMessageBox } from 'element-plus'

/** 服务端要求 step-up 二次验证的 403(错误信息含「动态码/二次验证」) */
function isStepUpError(err) {
  const status = err?.response?.status
  const msg = err?.response?.data?.error?.message || ''
  return status === 403 && (msg.includes('动态码') || msg.includes('二次验证'))
}

function showError(err) {
  ElMessage.error(err?.response?.data?.error?.message || '操作失败，请稍后重试')
}

/**
 * step-up 二次验证统一封装。
 * 用法:withStepUp(totp => sensitiveApi(args, totp))
 * - request 必须是 silent 请求(失败不触发全局错误提示,由本函数兜底提示)
 * - 首次不带动态码调用;若 403 且服务端要求二次验证,弹窗输入 6 位动态码后
 *   携带 X-TOTP-Code 头重试
 * - 用户取消输码时抛出 err.cancelled = true,调用方可静默忽略
 */
export async function withStepUp(request) {
  let code
  try {
    return await request()
  } catch (err) {
    if (!isStepUpError(err)) {
      showError(err)
      throw err
    }
    try {
      const { value } = await ElMessageBox.prompt(
        '该操作为敏感操作，请输入认证器 App 中的 6 位动态码完成二次验证。',
        '二次验证',
        {
          confirmButtonText: '验证并继续',
          cancelButtonText: '取消',
          inputPattern: /^\s*\d{6}\s*$/,
          inputErrorMessage: '请输入 6 位数字动态码',
          inputPlaceholder: '6 位动态码'
        }
      )
      code = value.trim()
    } catch {
      const cancel = new Error('已取消二次验证')
      cancel.cancelled = true
      throw cancel
    }
  }
  try {
    return await request(code)
  } catch (err) {
    showError(err)
    throw err
  }
}
