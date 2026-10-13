import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'
import { fixtureActivationCode } from './account-fixtures.mjs'

const rawCatalog = { model: 'gpt-6.1-sol', provider: 'private-vendor', providers: [{
  slug: 'private-vendor', aliases: ['custom:private-vendor'], name: '供应商真实名称', authenticated: true,
  models: ['gpt-6.1-sol', 'gemini-pro-agent', 'gemini-3.1-pro-low', 'grok-4.7', 'new-private-model'],
  image_models: ['gpt-image-2.5-sunburst'], image_model: 'gpt-image-2.5-sunburst',
  capabilities: { 'gpt-6.1-sol': { reasoning: true, supported_efforts: ['low', 'high'] } }
}] }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-display-names-')), calls = [], imageSelections = []
  let runtimeEpoch = 0
  const native = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/studio/model-endpoints') return res.end(JSON.stringify({ endpoints: [{ id: 'private-vendor', name: '供应商真实名称', is_current: true, models: rawCatalog.providers[0].models, image_models: rawCatalog.providers[0].image_models }, { id: 'a', name: '短名称接入', models: ['a'] }] }))
    if (url.pathname === '/api/studio/image-selection') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      imageSelections.push(JSON.parse(Buffer.concat(chunks).toString()))
      return res.end('{"ok":true}')
    }
    res.end('{}')
  })
  const wss = new WebSocketServer({ server: native })
  wss.on('connection', socket => socket.on('message', raw => {
    const call = JSON.parse(raw); calls.push(call)
    if (call.method === 'gateway.ping') return socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: 503, message: '模型 new-private-model 暂不可用，请稍后重试。' } }))
    let result = {}
    if (call.method === 'model.options') {
      result = structuredClone(rawCatalog)
      if (call.params.profile !== 'jubao-drama') { result.provider = 'studio-inference'; result.providers[0].slug = 'studio-inference'; result.providers[0].aliases = ['custom:studio-inference'] }
    }
    if (call.method === 'session.create') result = { session_id: 'live-' + call.params.profile + '-' + runtimeEpoch, stored_session_id: 'stored', messages: [], info: { model: call.params.model || 'gpt-6.1-sol', provider: call.params.provider || 'private-vendor' } }
    if (call.method === 'session.resume') result = { session_id: 'live-' + call.params.profile + '-' + runtimeEpoch, stored_session_id: 'stored', messages: [], info: { model: call.params.session_id === 'stored-current' ? 'gpt-6.1-sol' : 'gemini-3.1-pro-low', provider: 'custom:studio-inference' } }
    if (call.method === 'config.set') {
      const [model, , provider] = call.params.value.split(' ')
      result = { key: 'model', value: model, scope: 'session', info: { model, provider } }
    }
    if (call.method === 'subagent.list') result = { subagents: [{ agent_id: 'child', status: 'running', model: 'gpt-6.1-sol' }], delegations: [] }
    if (call.method === 'prompt.submit') {
      result = { accepted: true }
      if (call.params.text === '模型身份探测') {
        for (const text of ['使用 new-private-', 'model 完成。 A rainy day.']) socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: call.params.session_id, payload: { text } } }))
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'error', session_id: call.params.session_id, payload: { message: '模型 new-private-model 暂不可用，请稍后重试。' } } }))
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: call.params.session_id, payload: { text: '使用 new-private-model 完成。 A rainy day.', error: '模型 new-private-model 暂不可用，请稍后重试。' } } }))
      }
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
  }))
  native.listen(0, '127.0.0.1'); await once(native, 'listening')
  const options = { backend: `http://127.0.0.1:${native.address().port}`, backendToken: 'fixture-only', repoRoot: directory, dataDir: directory, provisionProfile: async () => ({}) }
  let edge = await createStudioEdge(options)
  await edge.seedRoot('fixture-root-password')
  let middleware
  const web = createServer((req, res) => middleware(req, res, () => res.end()))
  const install = () => edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: web })
  install(); web.listen(0, '127.0.0.1'); await once(web, 'listening')
  const origin = `http://127.0.0.1:${web.address().port}`
  const request = async (route, actor, body) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(actor ? { cookie: actor.cookie, 'x-studio-csrf': actor.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async username => {
    const response = await request('/studio/auth/login', null, { username, password: 'fixture-root-password', activation_code: await fixtureActivationCode(edge.store, username, 'fixture-root-password') })
    assert.equal(response.status, 200)
    return { ...response, csrf: response.data.csrfToken }
  }
  const sockets = []
  const connect = async actor => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { origin, cookie: actor.cookie } })
    sockets.push(socket); await once(socket, 'open')
    let sequence = 0
    const frames = []
    socket.on('message', raw => frames.push(JSON.parse(raw)))
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { socket.off('message', on); reject(new Error('验收超时')) }, 5000)
      const on = raw => { const frame = JSON.parse(raw); if (frame.id === id) { clearTimeout(timer); socket.off('message', on); resolve(frame) } }
      socket.on('message', on); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    rpc.frames = frames
    return rpc
  }
  const restart = async () => { await edge.close(); runtimeEpoch++; edge = await createStudioEdge(options); install() }
  t.after(async () => { for (const socket of sockets) socket.terminate(); await edge.close(); for (const peer of wss.clients) peer.terminate(); await new Promise(resolve => wss.close(resolve)); await Promise.all([new Promise(resolve => native.close(resolve)), new Promise(resolve => web.close(resolve))]); await rm(directory, { recursive: true, force: true }) })
  return { request, login, connect, calls, imageSelections, restart, directory }
}

test('模型名称仅 root 可修改，新增模型自动纳入并在重启后保留名称，非法保存不覆盖旧值', async t => {
  const f = await fixture(t), root = await f.login('root')
  const initial = await f.request('/studio/admin/model-names', root)
  assert.equal(initial.status, 200)
  assert.ok(Array.isArray(initial.data.targets))
  assert.ok(initial.data.targets.some(row => row.models.includes('new-private-model')))
  assert.ok(initial.data.models.every(row => row.id && row.provider === 'private-vendor' || row.provider === ''))
  const models = initial.data.models.map(row => row.model === 'gpt-6.1-sol' ? { ...row, display_name: '  团队精品模型  ' } : row)
  for (const role of ['admin', 'employee']) {
    assert.equal((await f.request('/studio/admin/users', root, { username: role, display_name: role, password: 'fixture-root-password', role })).status, 201)
    const actor = await f.login(role)
    for (const body of [undefined, { models }]) assert.equal((await f.request('/studio/admin/model-names', actor, body)).status, 403)
  }
  assert.equal((await f.request('/studio/admin/model-names', { ...root, csrf: '' }, { models })).status, 403)
  assert.equal((await f.request('/studio/admin/model-names', root, { models })).status, 200)
  const changed = patch => models.map((row, index) => index === 0 ? { ...row, ...patch } : row)
  for (const bad of [{ models, extra: true }, ...[{ display_name: '  ' }, { display_name: 'a\nb' }, { provider: 'missing-provider' }, { model: 'missing-model' }].map(patch => ({ models: changed(patch) })), { models: [models[0], models[0], ...models.slice(2)] }]) assert.equal((await f.request('/studio/admin/model-names', root, bad)).status, 400)
  await f.restart()
  const restored = await f.request('/studio/admin/model-names', root)
  assert.equal(restored.status, 200)
  assert.equal(restored.data.models.find(row => row.model === 'gpt-6.1-sol').display_name, '团队精品模型')
  assert.ok((await readFile(path.join(f.directory, 'model-display-names.json'), 'utf8')).includes('团队精品模型'))
  assert.equal(f.calls.length, 0)
})

test('管理员和员工只得到公开模型标识，文字和生图选择可还原真实路由，隐藏旧会话继续保留显示名', async t => {
  const f = await fixture(t)
  let root = await f.login('root')
  for (const role of ['admin', 'employee']) {
    assert.equal((await f.request('/studio/admin/users', root, { username: role, display_name: role, password: 'fixture-root-password', role })).status, 201)
    const settings = (await f.request('/studio/admin/model-names', root)).data.models
    assert.equal((await f.request('/studio/admin/model-names', root, { models: settings.map(row => row.id === 'brand-text-3' ? { ...row, model: 'gpt-6.1-sol' } : row) })).status, 200)
    const rpc = await f.connect(await f.login(role))
    const catalog = (await rpc('model.options')).result
    assert.ok(!JSON.stringify(catalog).includes('gpt-6.1-sol'))
    assert.ok(!JSON.stringify(catalog).includes('private-vendor'))
    const provider = catalog.providers[0]
    const model = Object.keys(provider.display_names).find(id => provider.display_names[id] === '巨豹测试版 V2.1')
    assert.ok(model)
    assert.ok(!provider.models.some(id => provider.display_names[id] === '巨豹创作模型'))
    assert.equal(provider.display_names[catalog.model], '巨豹满血版 V1.1')
    const created = (await rpc('session.create', { model, provider: provider.slug, reasoning_effort: 'high' })).result
    assert.equal(created.info.model, model)
    assert.equal(created.info.model_display_name, provider.display_names[model])
    assert.deepEqual(f.calls.at(-1).params.model, 'gpt-6.1-sol')
    const switched = await rpc('config.set', { session_id: created.session_id, key: 'model', scope: 'session', value: { model, provider: provider.slug } })
    assert.equal(switched.result.value, model)
    assert.equal(switched.result.info.provider, provider.slug)
    assert.match(f.calls.at(-1).params.value, /^gpt-6\.1-sol --provider studio-inference --session$/)
    const image = provider.image_models[0]
    assert.equal((await rpc('prompt.submit', { session_id: created.session_id, text: '准备图片', image_model: image, image_provider: provider.slug })).result.accepted, true)
    assert.deepEqual(f.imageSelections.at(-1), { session_id: created.session_id, model: 'gpt-image-2.5-sunburst', provider: 'studio-inference' })
    assert.equal((await rpc('session.create', { model: 'gpt-6.1-sol', provider: 'private-vendor' })).error.code, 403)
    assert.equal((await rpc('session.create', { model: 'unknown-brand', provider: provider.slug })).error.code, 403)
    const resumed = (await rpc('session.resume', { session_id: 'stored' })).result
    assert.ok(!resumed.info.model.includes('gemini'))
    assert.ok(resumed.info.model_display_name && !resumed.info.model_display_name.includes('gemini'))
    const subagents = (await rpc('subagent.list', { session_id: resumed.session_id })).result
    assert.equal(subagents.subagents[0].model, model)
    await rpc('session.create', { model, provider: provider.slug })
    const changed = settings.map(row => row.id === model ? { ...row, model: 'new-private-model' } : row)
    assert.equal((await f.request('/studio/admin/model-names', root, { models: changed })).status, 200)
    const updated = (await rpc('model.options')).result
    assert.ok(updated.providers[0].models.includes(model))
    assert.equal(updated.providers[0].display_names[model], provider.display_names[model])
    const existing = (await rpc('session.resume', { session_id: 'stored-current' })).result
    assert.equal(existing.info.model, model)
    assert.equal(existing.info.model_display_name, provider.display_names[model])
    assert.equal(existing.info.model_capabilities.model, model)
    assert.deepEqual(existing.info.model_capabilities.capabilities.supported_efforts, ['low', 'high'])
    assert.deepEqual(updated.providers[0].capabilities[model].supported_efforts, [])
    await rpc('session.create', { model, provider: provider.slug })
    assert.equal(f.calls.at(-1).params.model, 'new-private-model')
    assert.equal(f.calls.at(-1).params.provider, 'studio-inference')
    await rpc('prompt.submit', { session_id: existing.session_id, text: '模型身份探测' })
    const deltas = rpc.frames.filter(frame => frame.params?.type === 'message.delta').map(frame => frame.params.payload.text).join('')
    assert.equal(deltas, '使用 当前模型 完成。 A rainy day.')
    const error = await rpc('gateway.ping')
    assert.equal(error.error.message, '模型 当前模型 暂不可用，请稍后重试。')
    assert.ok(!JSON.stringify(rpc.frames).includes('new-private-model'))
    const duplicate = changed.map(row => row.id === 'brand-text-5' ? { ...row, provider: 'private-vendor', model: 'gpt-6.1-sol' } : row)
    assert.equal((await f.request('/studio/admin/model-names', root, { models: duplicate })).status, 200)
    await rpc('model.options')
    await rpc('session.create', { model: 'brand-text-5', provider: provider.slug })
    await f.restart()
    root = await f.login('root')
    const reopened = await f.connect(await f.login(role))
    await reopened('model.options')
    const recovered = (await reopened('session.resume', { session_id: 'stored-current' })).result
    assert.equal(recovered.info.model, 'brand-text-5')
    assert.equal(recovered.info.model_display_name, duplicate.find(row => row.id === 'brand-text-5').display_name)
  }
})
