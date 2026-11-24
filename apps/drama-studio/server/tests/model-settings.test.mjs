import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStudioEdge } from '../index.mjs'

async function fixture(t, catalog = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-models-'))
  const writes = [], probes = [], endpoints = []
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/v1/models') {
      probes.push({ method: req.method, authorization: req.headers.authorization })
      res.writeHead(catalog.status || 200, { 'Content-Type': catalog.contentType || 'application/json', ...catalog.headers })
      return res.end(catalog.body ?? JSON.stringify({ data: [{ id: 'writer-model' }] }))
    }
    assert.equal(req.headers['x-hermes-session-token'], 'fixture-backend-token')
    assert.equal(url.searchParams.get('profile'), 'jubao-drama')
    if (!['/api/providers/custom-endpoints', '/api/studio/model-endpoints'].includes(url.pathname)) { res.writeHead(404); return res.end('{}') }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); writes.push(body)
      endpoints.push({ ...body, id: 'writer', has_api_key: true, api_key_preview: 'not-for-browser', api_key: body.api_key })
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, id: 'writer', endpoints }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const backend = `http://127.0.0.1:${upstream.address().port}`
  const edge = await createStudioEdge({ backend, dataDir: directory, repoRoot: directory, backendToken: 'fixture-backend-token', provisionProfile: async () => ({}) })
  await edge.seedRoot('fixture-root-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(value) { middleware = value } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, actor, body) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(actor ? { cookie: actor.cookie, 'x-studio-csrf': actor.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (username, password) => { const response = await request('/studio/auth/login', null, { username, password, activation_code: await fixtureActivationCode(edge.store, username, 'fixture-root-password')}); return { ...response, csrf: response.data.csrfToken } }
  t.after(async () => { await edge.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); await rm(directory, { recursive: true, force: true }) })
  return { request, login, writes, probes, backend }
}

test('只有超级管理员能接入模型，目录校验只发GET且凭证从不回传', async t => {
  const f = await fixture(t), root = await f.login('root', 'fixture-root-password')
  for (const role of ['admin', 'employee']) {
    assert.equal((await f.request('/studio/admin/users', root, { username: role, display_name: role, password: 'fixture-role-password', role })).status, 201)
    const actor = await f.login(role, 'fixture-role-password')
    for (const [route, body] of [['/studio/admin/models'], ['/studio/admin/models', {}], ['/studio/admin/models/validate', {}]]) assert.equal((await f.request(route, actor, body)).status, 403)
  }
  const input = { name: '写作模型', base_url: f.backend + '/v1', model: 'writer-model', models: ['writer-model'], api_mode: 'chat_completions', api_key: 'fixture-provider-secret' }
  assert.equal((await f.request('/studio/admin/models', { ...root, csrf: '' }, input)).status, 403)
  assert.equal((await f.request('/studio/admin/models', root, { ...input, profile: 'other' })).status, 400)
  const probe = await f.request('/studio/admin/models/validate', root, input)
  assert.equal(probe.status, 200); assert.equal(probe.data.ok, true)
  assert.deepEqual(f.probes, [{ method: 'GET', authorization: 'Bearer fixture-provider-secret' }])
  const saved = await f.request('/studio/admin/models', root, input)
  assert.equal(saved.status, 200)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].discover_models, false)
  assert.equal(f.writes[0].make_default, false)
  const list = await f.request('/studio/admin/models', root)
  assert.equal(list.data.endpoints[0].has_api_key, true)
  for (const value of [saved.data, list.data]) { assert.equal(JSON.stringify(value).includes('fixture-provider-secret'), false); assert.equal(JSON.stringify(value).includes('not-for-browser'), false) }
})

test('拒绝畸形接入参数、URL中的凭证以及无凭证新建，不触发上游写入', async t => {
  const f = await fixture(t), root = await f.login('root', 'fixture-root-password')
  const input = { name: '写作模型', base_url: f.backend + '/v1', model: 'writer-model', models: ['writer-model'], api_mode: 'chat_completions', api_key: 'fixture-provider-secret' }
  for (const patch of [{ base_url: 'https://user:password@example.com/v1' }, { base_url: 'file:///tmp/a' }, { api_mode: 'other' }, { models: ['../file'] }, { api_key: '' }, { api_key: 'bad\nkey' }, { model: 'missing' }]) assert.equal((await f.request('/studio/admin/models', root, { ...input, ...patch })).status, 400)
  assert.equal(f.writes.length, 0)
})

test('目录探测区分网页拦截、鉴权拒绝和访问限制，不回传上游私密正文', async t => {
  for (const scenario of [
    { status: 403, contentType: 'text/html; charset=UTF-8', message: /网页|安全验证/ },
    { status: 200, contentType: 'text/html', message: /网页|安全验证/ },
    { status: 403, headers: { 'cf-mitigated': 'challenge' }, message: /网页|安全验证/ },
    { status: 401, message: /密钥|API Key/ },
    { status: 403, message: /访问|白名单/ },
    { status: 429, message: /频繁|限流/ }
  ]) {
    await t.test(String(scenario.status) + ' ' + (scenario.contentType || JSON.stringify(scenario.headers) || 'JSON'), async t => {
      const f = await fixture(t, { ...scenario, body: '上游私密内容 fixture-provider-secret' })
      const root = await f.login('root', 'fixture-root-password')
      const result = await f.request('/studio/admin/models/validate', root, { name: '写作模型', base_url: f.backend + '/v1', model: 'writer-model', models: ['writer-model'], api_mode: 'chat_completions', api_key: 'fixture-provider-secret' })
      assert.equal(result.status, 200)
      assert.equal(result.data.ok, false)
      assert.match(result.data.message, scenario.message)
      assert.equal(JSON.stringify(result.data).includes('fixture-provider-secret'), false)
      assert.equal(JSON.stringify(result.data).includes('上游私密内容'), false)
    })
  }
})

test('误填已知中转密钥管理页时在保存和探测前指出 API 地址', async t => {
  const f = await fixture(t), root = await f.login('root', 'fixture-root-password')
  for (const host of ['zzshu.cc', 'www.zzshu.cc']) {
    for (const route of ['/studio/admin/models', '/studio/admin/models/validate']) {
      const result = await f.request(route, root, { name: '新站', base_url: `https://${host}/keys/`, model: 'writer-model', models: ['writer-model'], api_mode: 'chat_completions', api_key: 'fixture-provider-secret' })
      assert.equal(result.status, 400)
      assert.match(JSON.stringify(result.data), /https:\/\/api\.zzshu\.cc\/v1/)
    }
  }
  assert.equal(f.writes.length, 0)
  assert.equal(f.probes.length, 0)
})

test('密钥有效但目录缺少所选模型时明确提示，目录截断不影响型号判断', async t => {
  for (const available of [false, true]) {
    const data = Array.from({ length: 101 }, (_, index) => ({ id: 'other-' + index }))
    if (available) data.push({ id: 'writer-model' })
    const f = await fixture(t, { body: JSON.stringify({ data }) }), root = await f.login('root', 'fixture-root-password')
    const result = await f.request('/studio/admin/models/validate', root, { name: '新站', base_url: f.backend + '/v1', model: 'writer-model', models: ['writer-model'], api_mode: 'chat_completions', api_key: 'fixture-provider-secret' })
    assert.equal(result.status, 200)
    assert.equal(result.data.ok, available)
    assert.equal(result.data.models.length, 100)
    if (!available) assert.match(result.data.message, /密钥.*有效.*writer-model/)
  }
})

async function toggleFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-models-toggle-'))
  const toggles = []
  let endpoints = [
    { id: 'base', name: '默认接入', base_url: 'https://base.example/v1', model: 'base-model', models: ['base-model'], has_api_key: true, is_current: true },
    { id: 'proxy', name: '代理谷歌官key', base_url: 'http://127.0.0.1:18080/v1beta/openai', model: 'proxy-model', models: ['proxy-model'], has_api_key: true },
    { id: 'operator', name: '压缩接入', base_url: 'https://operator.example/v1', model: 'operator-model', models: ['operator-model'], has_api_key: true }
  ]
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    assert.equal(req.headers['x-hermes-session-token'], 'fixture-backend-token')
    assert.equal(url.searchParams.get('profile'), 'jubao-drama')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/studio/model-endpoints' && req.method === 'GET') return res.end(JSON.stringify({ endpoints }))
    if (url.pathname === '/api/studio/model-endpoints/enabled' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); toggles.push(body)
      // 压缩策略由 Python 后端拦截，这里模拟它返回的 400 说明。
      if (body.id === 'operator' && !body.enabled) { res.statusCode = 400; return res.end(JSON.stringify({ detail: '上下文压缩正在使用这个接入，停用后服务无法启动，不能停用。' })) }
      endpoints = endpoints.map(row => row.id === body.id ? { ...row, enabled: body.enabled } : row)
      return res.end(JSON.stringify({ ok: true, id: body.id, endpoints }))
    }
    res.statusCode = 404; res.end('{}')
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const backend = `http://127.0.0.1:${upstream.address().port}`
  const edge = await createStudioEdge({ backend, dataDir: directory, repoRoot: directory, backendToken: 'fixture-backend-token', provisionProfile: async () => ({}) })
  await edge.seedRoot('fixture-root-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(value) { middleware = value } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, actor, body) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(actor ? { cookie: actor.cookie, 'x-studio-csrf': actor.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (username, password) => { const response = await request('/studio/auth/login', null, { username, password, activation_code: await fixtureActivationCode(edge.store, username, 'fixture-root-password')}); return { ...response, csrf: response.data.csrfToken } }
  t.after(async () => { await edge.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); await rm(directory, { recursive: true, force: true }) })
  return { request, login, toggles }
}

test('接入启停：拦截默认接入、压缩接入和会让员工失去全部文字入口的停用，放行时隐藏并恢复绑定的品牌入口', async t => {
  const f = await toggleFixture(t), root = await f.login('root', 'fixture-root-password')
  assert.equal((await f.request('/studio/admin/users', root, { username: 'writer', display_name: '编剧', password: 'fixture-role-password', role: 'employee' })).status, 201)
  const writer = await f.login('writer', 'fixture-role-password')
  assert.equal((await f.request('/studio/admin/models/enabled', writer, { id: 'proxy', enabled: false })).status, 403)
  for (const body of [{ id: 'proxy' }, { id: 'proxy', enabled: 'no' }, { id: '../x', enabled: false }, { id: 'proxy', enabled: false, extra: 1 }]) assert.equal((await f.request('/studio/admin/models/enabled', root, body)).status, 400)
  assert.equal((await f.request('/studio/admin/models/enabled', root, { id: 'missing', enabled: false })).status, 404)
  const current = await f.request('/studio/admin/models/enabled', root, { id: 'base', enabled: false })
  assert.equal(current.status, 400); assert.match(current.data.error, /默认接入/)
  // 默认品牌入口都还没绑定接入：停用任何接入都会让员工没有文字入口。
  const empty = await f.request('/studio/admin/models/enabled', root, { id: 'proxy', enabled: false })
  assert.equal(empty.status, 400); assert.match(empty.data.error, /没有可用的文字模型入口/)
  assert.deepEqual(f.toggles, [])

  const names = (await f.request('/studio/admin/model-names', root)).data.models
  const bound = names.map(row => row.id === 'brand-text-1' ? { ...row, provider: 'base', model: 'base-model' } : row.id === 'brand-text-2' ? { ...row, provider: 'proxy', model: 'proxy-model', display_name: '巨豹满血版 V1.0' } : row)
  assert.equal((await f.request('/studio/admin/model-names', root, { models: bound })).status, 200)
  const operator = await f.request('/studio/admin/models/enabled', root, { id: 'operator', enabled: false })
  assert.equal(operator.status, 400); assert.match(operator.data.error, /上下文压缩/)

  const off = await f.request('/studio/admin/models/enabled', root, { id: 'proxy', enabled: false })
  assert.equal(off.status, 200)
  assert.match(off.data.message, /已停用「代理谷歌官key」.*「巨豹满血版 V1\.0」暂时对员工隐藏/)
  assert.equal(off.data.endpoints.find(row => row.id === 'proxy').enabled, false)
  const listed = await f.request('/studio/admin/model-names', root)
  assert.deepEqual(listed.data.disabled_targets, [{ provider: 'proxy', provider_name: '代理谷歌官key' }])
  const on = await f.request('/studio/admin/models/enabled', root, { id: 'proxy', enabled: true })
  assert.equal(on.status, 200); assert.match(on.data.message, /已启用「代理谷歌官key」/)
  assert.equal(on.data.endpoints.find(row => row.id === 'proxy').enabled, true)
  assert.ok((await f.request('/studio/admin/model-names', root)).data.targets.some(row => row.provider === 'proxy'))
  assert.deepEqual(f.toggles, [{ id: 'operator', enabled: false }, { id: 'proxy', enabled: false }, { id: 'proxy', enabled: true }])
})
