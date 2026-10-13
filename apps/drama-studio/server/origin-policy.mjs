import { fail } from './accounts.mjs'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export function parsePublicOrigin(value) {
  if (value === undefined) return null
  let url
  try { url = new URL(value) } catch { throw new Error('公开访问地址 publicOrigin 无效。') }
  if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('公开访问地址 publicOrigin 必须为不含凭证、路径和参数的 HTTP 或 HTTPS 来源。')
  }
  return url
}

/** 服务器来源由部署配置决定，转发头不能扩展访问范围或降低 Cookie 保护。 */
export function createOriginPolicy(publicOrigin) {
  const configured = parsePublicOrigin(publicOrigin)
  return {
    cookieSecure: req => configured?.protocol === 'https:' || Boolean(req.socket.encrypted),
    sameOrigin(req, requireOrigin = false) {
      const rawHost = req.headers.host
      if (typeof rawHost !== 'string' || !rawHost || /[\/\\?#@\s]/.test(rawHost)) fail(403, '访问来源无效。')
      const protocol = configured?.protocol ?? (req.socket.encrypted ? 'https:' : 'http:')
      let host
      try { host = new URL(`${protocol}//${rawHost}`) } catch { fail(403, '访问来源无效。') }
      if (configured ? host.origin !== configured.origin : !LOOPBACK_NAMES.has(host.hostname)) fail(403, '访问地址与工作区配置不一致。')
      const origin = req.headers.origin
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '不允许跨站访问。')
      if (!origin && requireOrigin) fail(403, '请从巨豹智能体页面发起操作。')
      if (origin && origin !== (configured?.origin ?? host.origin)) fail(403, '不允许跨站访问。')
    }
  }
}
