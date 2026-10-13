import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'
import { startStudioServer } from '../serve.mjs'
import { AccountStore } from '../accounts.mjs'

const publicOrigin = 'http://192.168.10.36:10619'
const password = 'origin-fixture-password'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-origin-'))
  const appRoot = path.join(root, 'app')
  await mkdir(path.join(appRoot, 'dist'), { recursive: true })
  await writeFile(path.join(appRoot, 'dist/index.html'), '<!doctype html><title>测试工作区</title>')
  const backend = createServer((_req, res) => { res.writeHead(404); res.end('{}') })
  const upstream = new WebSocketServer({ server: backend })
  upstream.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(raw)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } }))
  }))
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
  t.after(async () => {
    for (const client of upstream.clients) client.terminate()
    await new Promise(resolve => upstream.close(resolve))
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  return { root, options: {
    repoRoot: root, appRoot, hermesHome: path.join(root, 'home'), dataDir: path.join(root, 'state'),
    backend: `http://127.0.0.1:${backend.address().port}`, backendToken: 'origin-fixture-token',
    workerPool: { provision: async profile => ({ profile }), close: async () => {} }
  } }
}

function request(server, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode, headers: res.headers, body: text.startsWith('{') ? JSON.parse(text) : text })
      })
    })
    req.once('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

test('显式服务器来源保留真实登录和CSRF边界，HTTPS会话不受转发头降级', async t => {
  const f = await fixture(t)
  for (const configured of [publicOrigin, 'https://studio.example', undefined]) {
    const edge = await createStudioEdge({ ...f.options, publicOrigin: configured })
    await edge.seedRoot(password)
    let middleware
    const server = createServer((req, res) => middleware(req, res, () => res.end('公开页面')))
    edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const origin = configured ?? `http://127.0.0.1:${server.address().port}`
      const headers = { host: new URL(origin).host, origin, 'x-forwarded-proto': configured?.startsWith('https:') ? 'http' : 'https' }
      const login = await request(server, '/studio/auth/login', { method: 'POST', headers, body: { username: 'root', password } })
      assert.equal(login.status, 200, origin)
      const cookieHeader = login.headers['set-cookie'][0]
      assert.equal(cookieHeader.includes('; Secure'), origin.startsWith('https:'))
      assert.ok(cookieHeader.includes('; HttpOnly; SameSite=Strict'))
      const authenticated = { ...headers, cookie: cookieHeader.split(';')[0] }
      const update = extra => request(server, '/studio/account', { method: 'PATCH', headers: { ...authenticated, ...extra }, body: { display_name: '已验证同源的编剧' } })
      assert.equal((await update({})).status, 403)
      assert.equal((await update({ 'x-studio-csrf': login.body.csrfToken })).status, 200)
      for (const overrides of [
        { origin: 'https://foreign.example' },
        { origin: 'null' },
        { 'sec-fetch-site': 'cross-site' },
        { host: 'foreign.example', 'x-forwarded-host': headers.host },
        { host: 'foreign.example', origin: 'http://foreign.example' }
      ]) assert.equal((await update({ 'x-studio-csrf': login.body.csrfToken, ...overrides })).status, 403)
      const { origin: unused, ...withoutOrigin } = authenticated
      assert.equal((await request(server, '/studio/auth/login', { method: 'POST', headers: withoutOrigin, body: { username: 'root', password } })).status, 403)
      assert.equal((await request(server, '/studio/auth/me', { headers: withoutOrigin })).status, 200)
      assert.equal((await request(server, '/', { headers: { host: 'foreign.example' } })).status, 403)
      const logout = await request(server, '/studio/auth/logout', { method: 'POST', headers: { ...authenticated, 'x-studio-csrf': login.body.csrfToken }, body: {} })
      assert.equal(logout.status, 200)
      assert.equal(logout.headers['set-cookie'][0].includes('; Secure'), origin.startsWith('https:'))
    } finally {
      await edge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    }
  }
  for (const invalid of ['ftp://studio.example', 'https://user:password@studio.example', 'https://studio.example/private', 'https://studio.example/?redirect=1']) {
    await assert.rejects(createStudioEdge({ ...f.options, publicOrigin: invalid }), /公开访问地址|publicOrigin/)
  }
})

test('非回环监听需显式来源，真实WebSocket仅接受该来源和已登录会话', async t => {
  const f = await fixture(t)
  await assert.rejects(startStudioServer({ ...f.options, host: '0.0.0.0', port: 0 }), /本机|回环|公开访问地址/)
  const store = await AccountStore.open(f.options.dataDir, f.options.workerPool.provision)
  await store.seedRoot(password)
  const running = await startStudioServer({ ...f.options, publicOrigin, host: '0.0.0.0', port: 0 })
  t.after(() => running.close())
  assert.equal(running.httpServer.address().address, '0.0.0.0')
  const headers = { host: new URL(publicOrigin).host, origin: publicOrigin }
  const login = await request(running.httpServer, '/studio/auth/login', { method: 'POST', headers, body: { username: 'root', password } })
  assert.equal(login.status, 200)
  const authenticated = { ...headers, cookie: login.headers['set-cookie'][0].split(';')[0] }
  const endpoint = `ws://127.0.0.1:${running.httpServer.address().port}/api/ws`
  const ws = new WebSocket(endpoint, { headers: authenticated })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const reply = once(ws, 'message')
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'gateway.ping', params: {} }))
  assert.deepEqual(JSON.parse((await reply)[0]).result, { pong: true })
  const { origin: unused, ...withoutOrigin } = authenticated
  for (const denied of [withoutOrigin, headers, { ...authenticated, origin: 'http://foreign.example' }, { ...authenticated, host: 'foreign.example', 'x-forwarded-host': headers.host }]) {
    const code = await new Promise((resolve, reject) => {
      const candidate = new WebSocket(endpoint, { headers: denied, handshakeTimeout: 2000 })
      candidate.once('open', () => { candidate.terminate(); reject(new Error('不应允许这个连接')) })
      candidate.on('error', reject)
      candidate.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode) })
    })
    assert.equal(code, 401)
  }
})
