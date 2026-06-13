export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const badRequest = (code, message) => new ApiError(400, code, message)
export const unauthorized = (message = '未登录或登录已过期') => new ApiError(401, 'UNAUTHORIZED', message)
export const forbidden = (message = '无权访问') => new ApiError(403, 'FORBIDDEN', message)
export const notFound = (message = '资源不存在') => new ApiError(404, 'NOT_FOUND', message)
export const locked = (message = '账户已锁定') => new ApiError(423, 'LOCKED', message)
export const conflict = (code, message) => new ApiError(409, code, message)
