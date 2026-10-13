import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'

function gate() {
  let enter, release
  return { entered: new Promise(resolve => { enter = resolve }), waiting: new Promise(resolve => { release = resolve }), enter: () => enter(), release: () => release() }
}
async function fixture(t, { sessionGate, transportGate } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-revocation-')), calls = [], answers = [], peers = new Set()
  let connections = 0
  const upstream = createServer(async (req, res) => {
    if (sessionGate) { sessionGate.enter(); await sessionGate.waiting }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'stored' }))
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', ws => {
    connections++; peers.add(ws)
    ws.on('message', raw => {
      const frame = JSON.parse(raw)
      if (!frame.method) { answers.push(frame); return }
      calls.push(frame)
      const result = ['session.create', 'session.resume'].includes(frame.method) ? { session_id: 'live', stored_session_id: 'stored', messages: [], info: {} } : { providers: [] }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const endpoint = new URL(`http://127.0.0.1:${upstream.address().port}`)
  const workerPool = { get: async () => { if (transportGate) { transportGate.enter(); await transportGate.waiting } return { endpoint, token: 'fixture-private-token', profile: 'default' } }, homeFor: () => directory, close: async () => {} }
  const edge = await createStudioEdge({ backend: endpoint.href, backendToken: 'fixture-private-token', dataDir: directory, repoRoot: directory, workerPool, provisionProfile: async () => ({}) })
  await edge.seedRoot('root-fixture-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => res.end()))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(route, auth, body, method = 'POST') {
    const res = await fetch(origin + route, { method, headers: { origin, 'content-type': 'application/json', ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': auth.csrfToken } : {}) }, body: JSON.stringify(body) })
    return { ...await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] }
  }
  const root = await request('/studio/auth/login', null, { username: 'root', password: 'root-fixture-password' })
  await request('/studio/admin/users', root, { username: 'alice', display_name: '员工', password: 'alice-fixture-password', role: 'employee' })
  const employee = await request('/studio/auth/login', null, { username: 'alice', password: 'alice-fixture-password', activation_code: await fixtureActivationCode(edge.store, 'alice', 'root-fixture-password') })
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: employee.cookie, origin } })
  const frames = []; ws.on('message', raw => frames.push(JSON.parse(raw))); await once(ws, 'open')
  const closed = once(ws, 'close')
  const send = (id, method, params = {}) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  const rpc = async (id, method, params = {}) => {
    const next = new Promise(resolve => { const on = raw => { const frame = JSON.parse(raw); if (frame.id === id) { ws.off('message', on); resolve(frame) } }; ws.on('message', on) })
    send(id, method, params); return next
  }
  const expire = () => { for (const row of edge.store.sessions.values()) if (row.userId === employee.user.id) row.expires = Date.now() - 1 }
  const revoke = async kind => kind === 'expired' ? expire() : kind === 'logout'
    ? request('/studio/auth/logout', employee, {})
    : request(`/studio/admin/users/${employee.user.id}`, root, { enabled: false }, 'PATCH')
  t.after(async () => { sessionGate?.release(); transportGate?.release(); await edge.close(); for (const peer of peers) peer.terminate(); await new Promise(resolve => wss.close(resolve)); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); await rm(directory, { recursive: true, force: true }) })
  return { send, rpc, ws, closed, calls, answers, frames, peers, expire, revoke, connections: () => connections }
}

test('身份在异步会话校验或连接准备期间失效时，旧账号请求不会到达创作进程', async t => {
  for (const kind of ['expired', 'logout', 'disabled']) {
    const delayed = gate(), f = await fixture(t, { sessionGate: delayed })
    await f.rpc('ping', 'gateway.ping')
    f.send('resume', 'session.resume', { session_id: 'stored' })
    await delayed.entered
    await f.revoke(kind)
    delayed.release()
    await f.closed
    assert.equal(f.calls.filter(frame => frame.id === 'resume').length, 0, '异步校验前的旧身份不能授权之后的发送')
  }
  const delayed = gate(), f = await fixture(t, { transportGate: delayed })
  await delayed.entered
  f.send('catalog', 'model.options')
  f.expire(); delayed.release()
  await f.closed
  assert.equal(f.connections(), 0, '准备期间过期的账号不应建立新的后台连接')
  assert.equal(f.calls.length, 0)
})

test('账号已失效时，不代答上游确认，也不继续处理客户端确认回执', async t => {
  for (const method of ['approval', 'secret']) {
    const f = await fixture(t)
    await f.rpc('create', 'session.create')
    const peer = [...f.peers][0]
    const observed = new Promise(resolve => peer.once('message', () => resolve('answered')))
    f.expire()
    peer.send(JSON.stringify({ jsonrpc: '2.0', id: 'system-request', method, params: { session_id: 'live', pattern_key: 'system-shell', prompt: '内部确认' } }))
    await Promise.race([observed, f.closed])
    assert.equal(f.answers.length, 0, '失效账号不能通过自动拒绝或错误回执继续操作后台请求')
  }
  const f = await fixture(t)
  await f.rpc('create', 'session.create')
  const peer = [...f.peers][0]
  const received = once(f.ws, 'message')
  peer.send(JSON.stringify({ jsonrpc: '2.0', id: 'confirm', method: 'approval', params: { session_id: 'live', pattern_key: 'plugin_rule:jubao-drama:' + 'a'.repeat(32), description: '确认本稿', choices: ['once', 'deny'] } }))
  await received
  f.expire()
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'confirm', result: { choice: 'once' } }))
  await f.closed
  assert.equal(f.answers.length, 0)
})
