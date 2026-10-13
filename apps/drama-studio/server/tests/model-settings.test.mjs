import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStudioEdge } from '../index.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-models-'))
  const writes = [], probes = [], endpoints = []
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/v1/models') {
      probes.push({ method: req.method, authorization: req.headers.authorization })
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'writer-model' }] }))
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
