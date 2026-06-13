import { z } from 'zod'

const REPLACEMENT_CHAR = /\uFFFD/
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const COMMON_MOJIBAKE = /(?:Ã.|Â.|å.|æ.|ä.|ç.|é.|è.){2,}/

export function hasUnreadableText(value) {
  if (typeof value !== 'string') return false
  return REPLACEMENT_CHAR.test(value) || CONTROL_CHAR.test(value) || COMMON_MOJIBAKE.test(value)
}

export function readableText(label, schema = z.string()) {
  return schema.superRefine((value, ctx) => {
    if (hasUnreadableText(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label}包含疑似乱码，请重新输入`
      })
    }
  })
}
