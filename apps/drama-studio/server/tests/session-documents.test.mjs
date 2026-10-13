import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStudioEdge } from '../index.mjs'
import { fixtureActivationCode } from './account-fixtures.mjs'

test('当前账号稿件目录保留回复关联与下载句柄，拒绝跨账号会话和浏览器伪造来源', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-session-documents-'))
  const home = profile => path.join(root, '.hermes/profiles', profile)
  const documentPath = profile => path.join(home(profile), 'workspace/本批剧本.docx')
  const reconciled = []
  const runtime = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), profile = url.searchParams.get('profile')
    assert.equal(req.headers['x-hermes-session-token'], 'fixture-private-service')
    res.setHeader('content-type', 'application/json')
    if (url.pathname.startsWith('/api/sessions/')) {
      if (url.pathname.split('/')[3] !== profile + '-stored') { res.statusCode = 404; return res.end('{}') }
      return res.end(JSON.stringify({ id: profile + '-stored' }))
    }
    if (url.pathname === '/api/studio/session-documents') {
      let body = ''; for await (const part of req) body += part
      const request = JSON.parse(body)
      assert.deepEqual(request, { session_id: profile + '-stored' })
      reconciled.push(profile)
      const artifact = { id: 'batch-a', name: '本批剧本', kind: 'script', content: '第04集\n林岚：证据在这里。',
        source_message_id: '71', source_response_sha256: 'a'.repeat(64), export_status: 'ready', private_field: 'private-canary' }
      return res.end(JSON.stringify({ ok: true, documents: [artifact], private_field: 'private-canary', project: {
        id: 'agent-documents', title: '本次剧本', agent_id: 'gm3-1', artifacts: [artifact],
        exports: [{ artifact_id: artifact.id, name: '本批剧本.docx', format: 'docx', kind: 'script',
          path: documentPath(profile), source_message_id: '71', source_response_sha256: artifact.source_response_sha256 }]
      } }))
    }
    if (url.pathname === '/api/fs/download') return res.end(await readFile(url.searchParams.get('path')))
    res.statusCode = 404; res.end('{}')
  })
  runtime.listen(0, '127.0.0.1'); await once(runtime, 'listening')
  const edge = await createStudioEdge({ backend: `http://127.0.0.1:${runtime.address().port}`, backendToken: 'fixture-private-service', repoRoot: root,
    dataDir: path.join(root, 'accounts'), provisionProfile: async profile => {
      await mkdir(path.join(home(profile), 'workspace'), { recursive: true })
      await writeFile(documentPath(profile), '本批 Word 内容')
      return { profile }
    } })
  await edge.seedRoot('root-fixture-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  edge.install({ middlewares: { use(value) { middleware = value } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, auth, body, csrf = auth?.csrfToken) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { origin,
      ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (username, password) => {
    const result = await request('/studio/auth/login', null, { username, password,
      activation_code: await fixtureActivationCode(edge.store, username, 'root-fixture-password') })
    return { ...result.data, cookie: result.cookie }
  }
  t.after(async () => { await edge.close(); server.closeAllConnections(); runtime.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => runtime.close(resolve))]);
    await rm(root, { recursive: true, force: true }) })
  const admin = await login('root', 'root-fixture-password')
  await request('/studio/admin/users', admin, { username: 'writer', display_name: '编剧', password: 'writer-fixture-password', role: 'employee' })
  const writer = await login('writer', 'writer-fixture-password')
  const body = { session_id: writer.user.profile + '-stored' }
  const result = await request('/studio/session-documents', writer, body)
  assert.equal(result.status, 200)
  assert.equal(result.data.project.artifacts[0].source_message_id, '71')
  assert.equal(result.data.documents[0].source_response_sha256, 'a'.repeat(64))
  assert.equal(result.data.documents[0].content, '第04集\n林岚：证据在这里。')
  assert.ok(!JSON.stringify(result.data).includes(root))
  assert.ok(!JSON.stringify(result.data).includes('private-canary'))
  const handle = result.data.project.exports[0].path
  assert.match(handle, /^\/assets-data\/[A-Za-z0-9_-]{32}\//)
  assert.equal((await request('/api/fs/download?path=' + encodeURIComponent(handle), writer)).data, '本批 Word 内容')
  assert.equal((await request('/api/fs/download?path=' + encodeURIComponent(handle), admin)).status, 403)
  assert.equal((await request('/studio/session-documents', writer, { session_id: admin.user.profile + '-stored' })).status, 404)
  for (const field of ['profile', 'content', 'path', 'agent_id']) {
    assert.equal((await request('/studio/session-documents', writer, { ...body, [field]: 'forged' })).status, 400)
  }
  assert.equal((await request('/studio/session-documents', writer, body, 'invalid')).status, 403)
  assert.deepEqual(reconciled, [writer.user.profile])
})
