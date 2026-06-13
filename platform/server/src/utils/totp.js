// TOTP（RFC 6238，30s 步长，6 位，SHA-1）：运营端 2FA 与敏感操作 step-up 复验使用
import crypto from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes)
  let bits = 0, value = 0, output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0, value = 0
  const bytes = []
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(code % 1000000).padStart(6, '0')
}

export function totpCode(secret, time = Date.now()) {
  return hotp(secret, Math.floor(time / 1000 / 30))
}

/** 校验动态码（容忍 ±1 个时间窗，即 ±30 秒时钟漂移） */
export function verifyTotp(secret, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false
  const counter = Math.floor(time / 1000 / 30)
  for (const delta of [0, -1, 1]) {
    if (hotp(secret, counter + delta) === String(code)) return true
  }
  return false
}

export function otpauthUrl(secret, account, issuer = '灵工云运营端') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
}
