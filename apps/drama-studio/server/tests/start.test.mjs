import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { shouldStartBackend } from '../../scripts/backend-lifecycle.mjs'

async function backendFixture(t, home, { token = true, status = 200 } = {}) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (request.url === '/') return response.end(token ? '<script>window.__HERMES_SESSION_TOKEN__="test-only-token";</script>' : '<p>其他服务</p>')
    if (request.url !== '/api/status' || request.headers['x-hermes-session-token'] !== 'test-only-token') {
      response.writeHead(401); return response.end('{}')
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ hermes_home: home, overall: 'degraded', components: { dashboard: { status: 'ok' } } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { server, url, requests }
}

test('默认启动复用同一仓库的已认证后端，空闲端口才建立自己的后端', async t => {
  const root = path.resolve('当前仓库')
  const fixture = await backendFixture(t, path.join(root, '.hermes'))
  assert.equal(await shouldStartBackend(fixture.url, root), false)
  assert.deepEqual(fixture.requests, ['/', '/api/status'])
  assert.equal(fixture.server.listening, true)
  await new Promise(resolve => fixture.server.close(resolve))
  assert.equal(await shouldStartBackend(fixture.url, root), true)
})

test('占用端口的其他仓库或未通过身份验证的服务不会被自动复用', async t => {
  const root = path.resolve('当前仓库')
  const home = path.join(root, '.hermes')
  for (const [reportedHome, options] of [[`${home}-other`, {}], [path.join(home, 'profiles/other'), {}], [undefined, {}], [home, { token: false }], [home, { status: 503 }]]) {
    const fixture = await backendFixture(t, reportedHome, options)
    await assert.rejects(shouldStartBackend(fixture.url, root), /已被其他服务占用|无法确认属于当前工作区/)
    assert.equal(fixture.server.listening, true)
  }
})
