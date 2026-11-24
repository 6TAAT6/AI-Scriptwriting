import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StudioBackend, authorizeRpc } from '../backend.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'

test('所有账号只能切换自己空闲对话的已接入文字模型，原生控制参数和密钥不得透传', async () => {
  for (const role of ['super_admin', 'admin', 'employee']) {
    const user = { id: role, role, profile: role }
    const backend = new StudioBackend({ backend: 'http://127.0.0.1:1', repoRoot: '/fixture', backendToken: 'fixture-only' })
    backend.runtimeOwners.set('live', user.id)
    backend.runtimeStates.set('live', { model: 'old-writer', running: false })
    backend.catalogs.set(user.id, { providers: [{ slug: 'writer', models: ['writer-b'], image_models: ['image-model'], capabilities: {
      'writer-b': { reasoning: true, supported_efforts: ['low', 'medium', 'high'] }
    } }] })
    const frame = { jsonrpc: '2.0', id: 1, method: 'config.set', params: { profile: role, session_id: 'live', scope: 'session', key: 'model', value: { provider: 'writer', model: 'writer-b', reasoning_effort: 'high' } } }
    const allowed = await authorizeRpc(frame, user, backend)
    assert.deepEqual(allowed.params.value, frame.params.value)
    for (const patch of [
      { scope: 'global' }, { session_id: 'foreign' }, { key: 'api_key' },
      { value: 'writer-b --global' }, { value: { provider: 'writer', model: 'writer-b --global' } },
      { value: { provider: 'other', model: 'writer-b' } }, { value: { provider: 'writer', model: 'image-model' } },
      { value: { ...frame.params.value, api_key: 'private' } }, { value: { ...frame.params.value, reasoning_effort: 'unknown' } }
    ]) await assert.rejects(authorizeRpc({ ...frame, params: { ...frame.params, ...patch } }, user, backend))
    backend.runtimeStates.get('live').running = true
    await assert.rejects(authorizeRpc(frame, user, backend), /生成中/)
  }
})

test('真实连接使用原生会话模型切换，确认前拒绝发送，失败和延后回执均按实际结果处理', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-model-switch-')), calls = []
  let release
  const native = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ endpoints: [{ id: 'first', models: ['writer-a'] }, { id: 'second', models: ['writer-b'] }] })) })
  const wss = new WebSocketServer({ server: native })
  wss.on('connection', socket => socket.on('message', raw => {
    const call = JSON.parse(raw); calls.push(call)
    const send = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
    if (call.method === 'session.create') send({ session_id: 'live', stored_session_id: 'stored', messages: [], info: { model: 'writer-a', provider: 'first' } })
    else if (call.method === 'model.options') send({ providers: [
      { slug: 'first', models: ['writer-a'] },
      { slug: 'second', models: ['writer-b'], capabilities: { 'writer-b': { reasoning: true, supported_efforts: ['low', 'high'] } } }
    ] })
    else if (call.method === 'config.set') {
      release = result => send(result)
    } else send({ status: 'streaming' })
  }))
  native.listen(0, '127.0.0.1'); await once(native, 'listening')
  const edge = await createStudioEdge({ backend: `http://127.0.0.1:${native.address().port}`, backendToken: 'fixture-only', repoRoot: directory, dataDir: directory })
  await edge.seedRoot('fixture-root-password')
  let middleware
  const web = createServer((req, res) => middleware(req, res, () => res.end()))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: web })
  web.listen(0, '127.0.0.1'); await once(web, 'listening')
  const origin = `http://127.0.0.1:${web.address().port}`
  const auth = await fetch(origin + '/studio/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'fixture-root-password' }) })
  assert.equal(auth.status, 200)
  const authData = await auth.json(), cookie = auth.headers.get('set-cookie').split(';')[0]
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-studio-csrf': authData.csrfToken }
  const names = await (await fetch(origin + '/studio/admin/model-names', { headers })).json()
  const saved = await fetch(origin + '/studio/admin/model-names', { method: 'POST', headers, body: JSON.stringify({ models: names.models.map(row => row.id === 'brand-text-1' ? { ...row, model: 'writer-a', provider: 'first' } : row.id === 'brand-text-2' ? { ...row, model: 'writer-b', provider: 'second' } : row) }) })
  assert.equal(saved.status, 200)
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { origin, cookie: auth.headers.get('set-cookie').split(';')[0] } })
  await once(socket, 'open')
  t.after(async () => { socket.terminate(); await edge.close(); for (const peer of wss.clients) peer.terminate(); await new Promise(resolve => wss.close(resolve)); await Promise.all([new Promise(resolve => native.close(resolve)), new Promise(resolve => web.close(resolve))]); await rm(directory, { recursive: true, force: true }) })
  let sequence = 0
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { socket.off('message', on); reject(new Error('验收超时')) }, 5000)
    const on = raw => { const frame = JSON.parse(raw); if (frame.id === id) { clearTimeout(timer); socket.off('message', on); resolve(frame) } }
    socket.on('message', on); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  await rpc('model.options'); await rpc('session.create')
  const changing = rpc('config.set', { session_id: 'live', key: 'model', scope: 'session', value: { model: 'brand-text-2', provider: 'jubao-models', reasoning_effort: 'high' } })
  // 同一 WebSocket 的请求按序处理，ping 回执证明前一条设置已进入原生后端。
  await rpc('gateway.ping')
  const wire = calls.find(call => call.method === 'config.set')
  assert.equal(wire.params.value, 'writer-b --provider second --session --reasoning high')
  assert.equal(wire.params.confirm_expensive_model, true)
  assert.equal((await rpc('prompt.submit', { session_id: 'live', text: '不应提前提交' })).error.code, 409)
  assert.ok(!calls.some(call => call.method === 'prompt.submit'))
  release({ key: 'model', value: 'writer-b', scope: 'session', deferred: true,
    info: { model: 'writer-b', provider: 'second', reasoning_effort: 'high', reasoning_effort_wire: '' } })
  const confirmed = await changing
  assert.equal(confirmed.result.deferred, true)
  assert.equal(confirmed.result.info.model, 'brand-text-2')
  assert.equal(confirmed.result.info.provider, 'jubao-models')
  assert.equal(confirmed.result.info.reasoning_effort, 'high')
  assert.equal(confirmed.result.info.reasoning_effort_wire, '')
  const failing = rpc('config.set', { session_id: 'live', key: 'model', scope: 'session', value: { model: 'brand-text-1', provider: 'jubao-models' } })
  await rpc('gateway.ping')
  release({ key: 'model', value: 'writer-a', confirm_required: true })
  assert.equal((await failing).error.code, 503)
  assert.equal((await rpc('prompt.submit', { session_id: 'live', text: '继续原会话' })).result.status, 'streaming')
})

test('原生热恢复的 session_key 保留为持久化会话标识，避免实时状态关联到临时ID',async()=>{
  const {sessionReceipt}=await import('../session-model.mjs')
  const native={jsonrpc:'2.0',id:1,result:{session_id:'runtime',session_key:'stored-conversation',messages:[],running:true}}
  const receipt=sessionReceipt({method:'session.resume'},native)
  assert.equal(receipt.result.stored_session_id,'stored-conversation')
  assert.equal(receipt.result.session_id,'runtime')
  assert.equal(native.result.stored_session_id,undefined)
  assert.strictEqual(sessionReceipt({method:'session.list'},native),native)
})

test('模型切换没有运行时身份回执或回执仍是旧模型时拒绝确认', async () => {
  const { modelSwitchReceipt } = await import('../session-model.mjs')
  const call = { method: 'config.set', params: { key: 'model', value: { model: 'writer-b', provider: 'second' } } }
  const base = { jsonrpc: '2.0', id: 1, result: { key: 'model', value: 'writer-b', scope: 'session' } }
  assert.equal(modelSwitchReceipt(call, base).error.code, 503)
  assert.equal(modelSwitchReceipt(call, { ...base, result: { ...base.result, info: { model: 'writer-a', provider: 'first' } } }).error.code, 503)
  const confirmed = modelSwitchReceipt(call, { ...base, result: { ...base.result, info: { model: 'writer-b', provider: 'second' } } })
  assert.equal(confirmed.result.info.model, 'writer-b')
  assert.equal(confirmed.result.info.provider, 'second')
})
