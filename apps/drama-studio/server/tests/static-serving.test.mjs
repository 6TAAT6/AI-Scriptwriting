import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { AccountStore } from '../accounts.mjs'

async function fixture(t) {
  const { startStudioServer } = await import('../serve.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'studio-static-'))
  const appRoot = path.join(root, 'app'), dist = path.join(appRoot, 'dist'), dataDir = path.join(root, 'state')
  await mkdir(path.join(dist, 'assets'), { recursive: true })
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>巨豹智能体</title>')
  await writeFile(path.join(dist, 'assets/app-test.js'), 'globalThis.publicFixture = true;')
  await writeFile(path.join(dist, 'assets/app-test.css'), 'body { color: #222; }')
  await writeFile(path.join(dist, 'assets/font-test.woff2'), Buffer.from([1, 2, 3]))
  await writeFile(path.join(dist, 'jubao-mark.png'), Buffer.from([137, 80, 78, 71]))
  await writeFile(path.join(root, 'private.txt'), 'PRIVATE_STATIC_CANARY')
  await symlink(path.join(root, 'private.txt'), path.join(dist, 'assets/escape.js'))
  await writeFile(path.join(dist, 'assets/app-test.js.map'), 'PRIVATE_SOURCE_MAP')
  await writeFile(path.join(dist, '.env'), 'PRIVATE_ENV_CANARY')
  const backend = createHttpServer((_req, res) => { res.writeHead(404); res.end('{}') })
  const upstream = new WebSocketServer({ server: backend })
  upstream.on('connection', ws => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
    ws.on('message', raw => { const frame = JSON.parse(raw); ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } })) })
  })
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
  const workerListener = createTcpServer(socket => socket.end())
  workerListener.listen(0, '127.0.0.1'); await once(workerListener, 'listening')
  const workerPort = workerListener.address().port
  let closes = 0
  const workerPool = {
    provision: async profile => ({ profile }),
    close: async () => { closes++; await new Promise(resolve => workerListener.close(resolve)) }
  }
  const store = await AccountStore.open(dataDir, workerPool.provision)
  await store.seedRoot('fixture-root-password')
  let server
  t.after(async () => {
    await server?.close()
    if (workerListener.listening) await new Promise(resolve => workerListener.close(resolve))
    for (const client of upstream.clients) client.terminate()
    await new Promise(resolve => upstream.close(resolve))
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  server = await startStudioServer({ repoRoot: root, appRoot, dataDir, backend: `http://127.0.0.1:${backend.address().port}`, backendToken: 'fixture-service-token', workerPool, port: 0 })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  return { server, origin, upstream, closes: () => closes, workerPort, options: { repoRoot: root, appRoot, dataDir, backend: 'http://127.0.0.1:1', backendToken: 'fixture-service-token', workerPool }, startStudioServer }
}

test('正式入口只提供公开构建文件，开发与秘密路径不回退首页且带安全响应头', async t => {
  const f = await fixture(t)
  for (const [route, type, content] of [
    ['/', 'text/html', '巨豹智能体'], ['/assets/app-test.js', 'text/javascript', 'publicFixture'],
    ['/assets/app-test.css', 'text/css', 'color'], ['/assets/font-test.woff2', 'font/woff2', null],
    ['/jubao-mark.png', 'image/png', null]
  ]) {
    const response = await fetch(f.origin + route)
    assert.equal(response.status, 200, route)
    assert.ok(response.headers.get('content-type').startsWith(type))
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
    const body = await response.text()
    if (content) assert.ok(body.includes(content))
  }
  const head = await fetch(f.origin + '/assets/app-test.js', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.ok(Number(head.headers.get('content-length')) > 0); assert.equal(await head.text(), '')
  for (const route of ['/unknown', '/src/main.tsx', '/@vite/client', '/@fs/private.txt', '/node_modules/react/package.json', '/.env', '/.hermes/config.yaml', '/.cache/a', '/assets/', '/assets/missing.js', '/assets/app-test.js.map', '/assets/escape.js']) {
    const response = await fetch(f.origin + route)
    assert.equal(response.status, 404, route)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const body = await response.text()
    assert.ok(!body.includes('巨豹智能体') && !body.includes('PRIVATE_'), route)
  }
  const account = await fetch(f.origin + '/studio/auth/me')
  assert.equal(account.status, 200); assert.deepEqual(await account.json(), { user: null })
  await assert.rejects(f.startStudioServer({ ...f.options, host: '0.0.0.0', port: 0 }), /本机|回环/)
})

test('正式服务保留真实WebSocket代理，重复关闭收回员工资源和全部监听连接', async t => {
  const f = await fixture(t)
  const login = await fetch(f.origin + '/studio/auth/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'fixture-root-password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  await login.text()
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/ws', { headers: { origin: f.origin, cookie } })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const ready = await once(ws, 'message')
  assert.equal(JSON.parse(ready[0]).params.type, 'gateway.ready')
  const reply = once(ws, 'message'); ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'gateway.ping', params: {} }))
  assert.deepEqual(JSON.parse((await reply)[0]).result, { pong: true })
  const port = f.server.httpServer.address().port
  const idle = createConnection({ host: '127.0.0.1', port }); await once(idle, 'connect')
  t.after(() => idle.destroy())
  idle.on('error', error => assert.equal(error.code, 'ECONNRESET'))
  const wsClosed = once(ws, 'close'), idleClosed = new Promise(resolve => idle.once('close', resolve))
  await Promise.all([f.server.close(), f.server.close(), wsClosed, idleClosed])
  await f.server.close()
  assert.equal(f.closes(), 1)
  assert.equal(f.server.httpServer.listening, false)
  assert.equal(f.upstream.clients.size, 0)
  for (const target of [port, f.workerPort]) {
    const probe = createConnection({ host: '127.0.0.1', port: target })
    const [error] = await once(probe, 'error')
    assert.equal(error.code, 'ECONNREFUSED'); probe.destroy()
  }
})
