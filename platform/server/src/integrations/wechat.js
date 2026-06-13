// 微信小程序登录适配器：code → openid。
// 生产环境配置 WX_APPID / WX_SECRET 后走微信官方 jscode2session；
// 未配置（开发/测试）时为确定性模拟（同一 code 恒得同一 openid），便于联调。
import crypto from 'node:crypto'

const APPID = process.env.WX_APPID
const SECRET = process.env.WX_SECRET

export async function code2session(code) {
  if (!code || code.length < 4) {
    return { ok: false, message: '无效的登录凭证 code' }
  }
  if (APPID && SECRET) {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APPID}&secret=${SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
    const resp = await (await fetch(url)).json()
    if (resp.errcode) return { ok: false, message: `微信登录失败：${resp.errmsg}` }
    return { ok: true, openid: resp.openid }
  }
  // 开发态模拟：openid = 'mock_' + sha256(code) 前16位
  const openid = 'mock_' + crypto.createHash('sha256').update(code).digest('hex').slice(0, 16)
  return { ok: true, openid, mocked: true }
}
