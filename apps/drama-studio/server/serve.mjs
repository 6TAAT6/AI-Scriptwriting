import { createServer } from 'node:http'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { createStudioEdge } from './index.mjs'
import { staticBoundary } from './static-boundary.mjs'
import { WorkerPool } from './worker-pool.mjs'
import { parsePublicOrigin } from './origin-policy.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
}
const LOOPBACK_HOSTS = new Map([['127.0.0.1', '127.0.0.1'], ['localhost', '127.0.0.1'], ['::1', '::1'], ['[::1]', '::1']])
const contains = (root, candidate) => candidate.startsWith(root + path.sep)
function missing(res) {
  if (res.headersSent) { res.destroy(); return }
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end('页面不存在。')
}

/** 正式入口只读取已构建的公开资产，关闭时先收回会话与员工进程，再释放监听。 */
export async function startStudioServer({ repoRoot, appRoot, backend, backendToken, hermesHome = path.join(repoRoot, '.hermes'), dataDir, host = '127.0.0.1', port = 10619, workerPool, publicOrigin }) {
  const configured = parsePublicOrigin(publicOrigin)
  const bindHost = LOOPBACK_HOSTS.get(host) ?? (configured ? host : null)
  if (!bindHost) throw new Error('未设置公开访问地址时，工作区仅支持本机回环地址。')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('工作区端口无效。')
  const dist = await realpath(path.join(appRoot, 'dist'))
  const index = await realpath(path.join(dist, 'index.html'))
  if (!contains(dist, index) || !(await stat(index)).isFile()) throw new Error('请先构建工作区前端。')
  const pool = workerPool ?? new WorkerPool({ repoRoot, hermesHome })
  const edge = await createStudioEdge({ repoRoot, backend, backendToken, hermesHome, dataDir, workerPool: pool, publicOrigin })
  const sockets = new Set()
  let closing, shuttingDown = false, middleware

  async function serveFile(req, res) {
    let handle
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1)
      const candidate = await realpath(path.join(dist, filename))
      if (!contains(dist, candidate)) { missing(res); return }
      const type = MIME[path.extname(filename)]
      if (!type) { missing(res); return }
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile()) { missing(res); return }
      res.statusCode = 200
      res.setHeader('Content-Type', type)
      res.setHeader('Content-Length', info.size)
      if (pathname !== '/') res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      if (req.method === 'HEAD') { res.end(); return }
      await pipeline(handle.createReadStream({ autoClose: false }), res)
    } catch {
      missing(res)
    } finally { await handle?.close() }
  }

  const httpServer = createServer((req, res) => {
    try {
      staticBoundary(req, res, () => {
        if (shuttingDown) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
          res.end('工作区正在关闭，请稍后重试。'); return
        }
        middleware(req, res, () => { void serveFile(req, res) })
      })
    } catch { missing(res) }
  })
  httpServer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  httpServer.on('upgrade', (req, socket) => {
    try { if (shuttingDown || new URL(req.url, 'http://localhost').pathname !== '/api/ws') socket.destroy() }
    catch { socket.destroy() }
  })
  edge.install({ middlewares: { use(handler) { middleware = handler } }, httpServer })
  const close = () => {
    if (closing) return closing
    shuttingDown = true
    closing = (async () => {
      try { await edge.close() }
      finally {
        const stopped = new Promise((resolve, reject) => {
          httpServer.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
        })
        httpServer.closeAllConnections()
        for (const socket of sockets) socket.destroy()
        await stopped
      }
    })()
    return closing
  }
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { httpServer.off('listening', ready); reject(error) }
      const ready = () => { httpServer.off('error', failed); resolve() }
      httpServer.once('error', failed)
      httpServer.once('listening', ready)
      httpServer.listen(port, bindHost)
    })
  } catch (error) { await close(); throw error }
  return { httpServer, close }
}
