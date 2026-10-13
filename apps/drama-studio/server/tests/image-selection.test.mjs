import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { StudioBackend, authorizeRpc } from '../backend.mjs'

test('生图选择属于当前会话，保存期间拒绝并发改选，选择字段不进入原生提示请求', async t => {
  const saved = []
  let release, arrived
  const waiting = new Promise(resolve => { arrived = resolve })
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    saved.push(JSON.parse(text))
    assert.equal(req.url, '/api/studio/image-selection?profile=author')
    assert.equal(req.headers['x-hermes-session-token'], 'fixture-private-service')
    if (saved.length === 1) { arrived(); await new Promise(resolve => { release = resolve }) }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const backend = new StudioBackend({ backend: `http://127.0.0.1:${server.address().port}`, backendToken: 'fixture-private-service', repoRoot: '/unused' })
  const user = { id: 'author', profile: 'author', role: 'super_admin' }
  backend.runtimeOwners.set('live', user.id)
  backend.runtimeStates.set('live', { running: false })
  backend.catalogs.set(user.id, { providers: [{ slug: 'gemini', image_models: ['gemini-image'] }] })
  const request = (model = '', provider = '', target = user) => authorizeRpc({ jsonrpc: '2.0', id: 1, method: 'prompt.submit', params: { session_id: 'live', text: '画一张海报', image_model: model, image_provider: provider } }, target, backend)
  await assert.rejects(request('unapproved', 'gemini'), error => error.status === 403)
  await assert.rejects(request('gemini-image', 'gemini', { ...user, id: 'other' }), error => error.status === 403)
  const first = request('gemini-image', 'gemini')
  await waiting
  try { await assert.rejects(request(), error => error.status === 409) }
  finally { release() }
  const forwarded = await first
  assert.deepEqual(forwarded.params, { session_id: 'live', text: '画一张海报', profile: 'author' })
  await request()
  assert.deepEqual(saved, [
    { session_id: 'live', provider: 'gemini', model: 'gemini-image' },
    { session_id: 'live', provider: '', model: '' }
  ])
})
