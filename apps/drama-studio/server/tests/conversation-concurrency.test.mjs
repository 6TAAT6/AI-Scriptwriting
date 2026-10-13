import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'
import { fixtureActivationCode } from './account-fixtures.mjs'

test('所有角色均能同时启动十个独立项目对话，完成回执只返回所属账号', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-concurrency-'))
  const calls = [], clients = []
  let nextSession = 0
  const native = createServer((_req, res) => { res.writeHead(404); res.end('{}') })
  const wss = new WebSocketServer({ server: native })
  wss.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw), params = frame.params || {}
    let result = {}
    if (frame.method === 'session.create') {
      const id = `live-${++nextSession}`
      result = { session_id: id, stored_session_id: `stored-${id}`, message_count: 0, messages: [], info: {} }
    } else if (frame.method === 'prompt.submit') {
      calls.push(params.session_id)
      result = { status: 'streaming' }
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
  }))
  native.listen(0, '127.0.0.1'); await once(native, 'listening')
  const edge = await createStudioEdge({ backend: `http://127.0.0.1:${native.address().port}`, backendToken: 'fixture-private-token', repoRoot: directory, dataDir: directory, provisionProfile: async profile => ({ profile }) })
  await edge.seedRoot('root-fixture-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end('{}') }))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    for (const client of clients) client.terminate()
    await edge.close(); for (const peer of wss.clients) peer.terminate()
    await new Promise(resolve => wss.close(resolve))
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => native.close(resolve))])
    await rm(directory, { recursive: true, force: true })
  })
  async function request(route, auth, body, method = 'POST') {
    const response = await fetch(origin + route, { method, headers: { origin, 'content-type': 'application/json', ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': auth.csrfToken } : {}) }, body: JSON.stringify(body) })
    assert.ok(response.ok)
    return { ...await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const root = await request('/studio/auth/login', null, { username: 'root', password: 'root-fixture-password' })
  const actors = [root]
  for (const role of ['admin', 'employee']) {
    await request('/studio/admin/users', root, { username: role, display_name: role === 'admin' ? '普通管理员' : '员工', role, password: 'fixture-password' })
    actors.push(await request('/studio/auth/login', null, { username: role, password: 'fixture-password', activation_code: await fixtureActivationCode(edge.store, role, 'root-fixture-password') }))
  }
  const contexts = []
  for (const actor of actors) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { origin, cookie: actor.cookie } }); clients.push(socket)
    // 十条并行 RPC 各自等待回执，另有完成事件监听器。
    socket.setMaxListeners(20)
    await once(socket, 'open')
    const completed = []
    socket.on('message', raw => { const frame = JSON.parse(raw); if (frame.method === 'event' && frame.params.type === 'message.complete') completed.push(frame.params.session_id) })
    let sequence = 0
    const rpc = (method, params = {}, id = ++sequence) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('并发验收响应超时')) }, 5000)
      function receive(raw) { const frame = JSON.parse(raw); if (frame.id !== id) return; clearTimeout(timer); socket.off('message', receive); resolve(frame) }
      socket.on('message', receive); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    const sessions = []
    for (let i = 0; i < 10; i++) {
      const session = (await rpc('session.create')).result; sessions.push(session)
      if (i < 10) {
        const project = await request('/studio/sidebar/projects', actor, { title: `独立剧本 ${i + 1}`, requestId: randomUUID() })
        await request('/studio/sidebar/sessions/' + session.stored_session_id, actor, { projectId: project.createdProjectId }, 'PATCH')
      }
    }
    const responses = await Promise.all(sessions.slice(0, 10).map(session => rpc('prompt.submit', { session_id: session.session_id, text: '开始当前项目' })))
    assert.ok(responses.every(frame => frame.result?.status === 'streaming'), actor.user.role)
    contexts.push({ actor, socket, rpc, sessions, completed })
  }
  assert.equal(calls.length, 30, '三个账号同时存在各自十个进行中的项目对话')
  for (const { rpc, socket, sessions } of contexts) {
    async function complete(session) {
      const delivered = new Promise(resolve => {
        const receive = raw => { const frame = JSON.parse(raw); if (frame.method === 'event' && frame.params.session_id === session.session_id) { socket.off('message', receive); resolve() } }
        socket.on('message', receive)
      })
      for (const peer of wss.clients) peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: session.session_id, payload: { status: 'complete', text: '已完成' } } }))
      await delivered
    }
    for (const session of sessions) await complete(session)
    assert.equal((await rpc('prompt.submit', { session_id: sessions[0].session_id, text: '继续下一轮' })).result?.status, 'streaming')
  }
  for (const { rpc, sessions, completed } of contexts) {
    await rpc('gateway.ping')
    assert.deepEqual(completed.sort(), sessions.map(session => session.session_id).sort())
  }
})
