/** 成品只提供构建后的公开文件，未知路径不回退为内部开发入口。 */
export function staticBoundary(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/studio/') || url.pathname.startsWith('/api/')) return next()
  if (!['GET', 'HEAD'].includes(req.method) || !(url.pathname === '/auth/company/callback' || /^\/(?:assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2?)|jubao-mark\.png|favicon\.ico)?$/.test(url.pathname))) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end('页面不存在。')
    return
  }
  if (url.pathname === '/' || url.pathname === '/auth/company/callback') res.setHeader('Cache-Control', 'no-store')
  next()
}
