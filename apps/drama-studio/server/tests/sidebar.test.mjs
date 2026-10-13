import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'
import { StudioBackend } from '../backend.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-sidebar-'))
  const backend = createServer((req, res) => {
    if (req.url === '/') return res.end('<script>window.__HERMES_SESSION_TOKEN__ = "test-only-token";</script>')
    const url = new URL(req.url, 'http://localhost')
    const owner = url.searchParams.get('profile')
    const id = decodeURIComponent(url.pathname.split('/')[3] || '')
    if (req.headers['x-hermes-session-token'] !== 'test-only-token' || id !== `${owner}-stored`) { res.writeHead(404); return res.end('{}') }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id, title: 'Bot Chat' }))
  })
  const backendWs = new WebSocketServer({ server: backend })
  backendWs.on('connection', (ws, req) => {
    if (new URL(req.url, 'http://localhost').searchParams.get('token') !== 'test-only-token') return ws.close()
    ws.on('message', raw => {
      const frame = JSON.parse(raw)
      if (frame.method === 'session.create') ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { session_id: `${frame.params.profile}-live`, stored_session_id: `${frame.params.profile}-draft`, messages: [], info: {} } }))
    })
  })
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
  const options = { backend: `http://127.0.0.1:${backend.address().port}`, backendToken: 'test-only-token', dataDir: path.join(root, 'state'), repoRoot: root,
    provisionProfile: async profile => { await mkdir(path.join(root, '.hermes/profiles', profile, 'workspace'), { recursive: true }); return { profile } } }
  let edge = await createStudioEdge(options); await edge.seedRoot('root-test-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, auth, method = 'GET', body, source = origin) => {
    const response = await fetch(origin + route, { method, headers: { origin: source, ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': auth.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (username = 'root', password = 'root-test-password') => { const result = await request('/studio/auth/login', null, 'POST', { username, password, activation_code: await fixtureActivationCode(edge.store, username, 'root-test-password')}); return { cookie: result.cookie, csrf: result.data.csrfToken, user: result.data.user } }
  const createDraft = async auth => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: auth.cookie, origin } })
    await once(ws, 'open')
    const reply = once(ws, 'message')
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.create', params: {} }))
    const [raw] = await reply
    ws.close()
    return JSON.parse(String(raw)).result
  }
  const reopen = async sidebar => { await edge.close(); if (sidebar) await writeFile(path.join(root, 'state/sidebar.json'), JSON.stringify(sidebar)); edge = await createStudioEdge(options); edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server }) }
  t.after(async () => { await edge.close(); for (const ws of backendWs.clients) ws.terminate(); await new Promise(resolve => backendWs.close(resolve)); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]); await rm(root, { recursive: true, force: true }) })
  return { root, request, login, reopen, createDraft }
}

test('侧栏更名、置顶、归档与恢复按账号持久化，不改原始会话身份', async t => {
  const f = await fixture(t)
  let root = await f.login()
  assert.equal((await f.request('/studio/sidebar', root)).status, 200)
  const created = await f.request('/studio/admin/users', root, 'POST', { username: 'alice', display_name: '编剧甲', password: 'alice-test-password', role: 'employee' })
  const alice = await f.login('alice', 'alice-test-password')
  const own = `/studio/sidebar/sessions/${root.user.profile}-stored`
  assert.equal((await f.request(own, root, 'PATCH', { title: '小福星', pinned: true, archived: true })).status, 200)
  assert.equal((await f.request('/studio/sidebar/project', root, 'PATCH', { title: '我的短剧', pinned: true, hidden: true })).status, 200)
  assert.equal((await f.request(own, alice, 'PATCH', { title: '越权修改' })).status, 404)
  assert.equal((await f.request('/studio/sidebar', alice)).data.sessions.length, 0)
  assert.equal(created.data.user.profile, alice.user.profile)
  await f.reopen(); root = await f.login()
  const state = (await f.request('/studio/sidebar', root)).data
  assert.equal(state.project.title, '我的短剧'); assert.equal(state.project.hidden, true)
  assert.deepEqual(state.sessions, [{ id: 'jubao-drama-stored', title: '小福星', pinned: true, archived: true }])
  const restored = await f.request(own, root, 'PATCH', { archived: false })
  assert.equal(restored.data.sessions[0].archived, false)
  assert.equal((await f.request('/studio/sidebar/project', root, 'PATCH', { hidden: false })).data.project.hidden, false)
  const saved = await readFile(path.join(f.root, 'state/sidebar.json'), 'utf8')
  assert.ok(!saved.includes('test-only-token')); assert.ok(!saved.includes('root-test-password'))
})

test('侧栏写入沿用登录、来源与CSRF校验，拒绝越界字段和任意Finder路径', async t => {
  const f = await fixture(t), root = await f.login()
  assert.equal((await f.request('/studio/sidebar')).status, 401)
  assert.equal((await f.request('/studio/sidebar/project', { ...root, csrf: 'wrong' }, 'PATCH', { title: '修改' })).status, 403)
  assert.equal((await f.request('/studio/sidebar/project', root, 'PATCH', { title: '修改' }, 'https://foreign.example')).status, 403)
  for (const body of [{ profile: 'another', title: '越界' }, { title: '' }, { pinned: 'true' }, { hidden: 1 }]) {
    assert.equal((await f.request('/studio/sidebar/project', root, 'PATCH', body)).status, 400)
  }
  assert.equal((await f.request('/studio/sidebar/project/reveal', root, 'POST', { path: '/tmp' })).status, 400)
  assert.equal((await f.request('/studio/sidebar/sessions/foreign-stored', root, 'PATCH', { archived: true })).status, 404)
})

test('创建的项目持久保存名称和独立对话归属，账号之间不能读取或修改', async t => {
  const f = await fixture(t)
  let root = await f.login()
  await f.request('/studio/admin/users', root, 'POST', { username: 'alice', display_name: '编剧甲', password: 'alice-test-password', role: 'employee' })
  const alice = await f.login('alice', 'alice-test-password')
  const first = await f.request('/studio/sidebar/projects', root, 'POST', { title: '  第一个故事  ', requestId: randomUUID() })
  assert.equal(first.status, 201)
  const firstId = first.data.createdProjectId
  assert.ok(firstId && firstId !== 'default')
  assert.equal(first.data.projects.find(project => project.id === firstId).title, '第一个故事')
  const second = await f.request('/studio/sidebar/projects', root, 'POST', { title: '第二个故事', requestId: randomUUID() })
  assert.notEqual(second.data.createdProjectId, firstId)
  assert.equal(second.data.projects.length, 3)
  assert.deepEqual(second.data.projects.map(project => project.id), [second.data.createdProjectId, firstId, 'default'])
  const own = `/studio/sidebar/sessions/${root.user.profile}-stored`
  assert.equal((await f.request(own, root, 'PATCH', { title: '章节讨论', projectId: firstId })).status, 200)
  const updated = await f.request(`/studio/sidebar/projects/${firstId}`, root, 'PATCH', { title: '已经命名的故事', pinned: true, hidden: true })
  assert.equal(updated.status, 200)
  assert.equal(updated.data.projects.find(project => project.id === firstId).hidden, true)
  assert.equal((await f.request('/studio/sidebar', alice)).data.projects.length, 1)
  assert.equal((await f.request(`/studio/sidebar/projects/${firstId}`, alice, 'PATCH', { title: '越权编辑' })).status, 404)
  assert.equal((await f.request(`/studio/sidebar/sessions/${alice.user.profile}-stored`, alice, 'PATCH', { projectId: firstId })).status, 404)
  assert.equal((await f.request(own, alice, 'PATCH', { projectId: 'default' })).status, 404)
  assert.equal((await f.request('/studio/sidebar/projects', { ...root, csrf: 'wrong' }, 'POST', { title: '不会创建' })).status, 403)
  for (const body of [{}, { title: '' }, { title: '项目', path: '/tmp' }, { title: '项目', profile: alice.user.profile }]) {
    assert.equal((await f.request('/studio/sidebar/projects', root, 'POST', body)).status, 400)
  }
  assert.equal((await f.request(own, root, 'PATCH', { projectId: 123 })).status, 400)
  assert.equal((await f.request(own, root, 'PATCH', { projectId: 'missing' })).status, 404)
  await f.reopen(); root = await f.login()
  const state = (await f.request('/studio/sidebar', root)).data
  assert.deepEqual(state.projects.find(project => project.id === firstId), { id: firstId, title: '已经命名的故事', pinned: true, hidden: true })
  assert.equal(state.sessions.find(session => session.id === `${root.user.profile}-stored`).projectId, firstId)
  assert.equal((await f.request(`/studio/sidebar/projects/${firstId}`, root, 'PATCH', { hidden: false })).data.projects.find(project => project.id === firstId).hidden, false)
})

test('旧侧栏项目和聊天原样迁移为默认项目，再创建项目不会覆盖旧内容', async t => {
  const f = await fixture(t)
  let root = await f.login()
  const legacySession = { id: `${root.user.profile}-stored`, title: '原来的章节', pinned: true, archived: true }
  await f.reopen({ version: 1, accounts: [{ userId: root.user.id, profile: root.user.profile, project: { title: '旧剧本合集', pinned: true, hidden: false }, sessions: [legacySession] }] })
  root = await f.login()
  const before = (await f.request('/studio/sidebar', root)).data
  assert.deepEqual(before.projects, [{ id: 'default', title: '旧剧本合集', pinned: true, hidden: false }])
  assert.deepEqual(before.sessions, [legacySession])
  assert.equal((await f.request('/studio/sidebar/projects', root, 'POST', { title: '新的故事', requestId: randomUUID() })).status, 201)
  assert.equal((await f.request('/studio/sidebar/project', root, 'PATCH', { title: '保留下来的剧本合集' })).status, 200)
  await f.reopen(); root = await f.login()
  const after = (await f.request('/studio/sidebar', root)).data
  assert.equal(after.projects.length, 2)
  assert.equal(after.projects.find(project => project.id === 'default').title, '保留下来的剧本合集')
  assert.equal(after.project.title, '保留下来的剧本合集')
  assert.deepEqual(after.sessions, [legacySession])
})

test('创建项目的重试在重启后仍返回同一项目，同键不同名称和其他账号不能复用该项目', async t => {
  const f = await fixture(t)
  let root = await f.login()
  const body = { title: '不重复的故事', requestId: randomUUID() }
  const first = await f.request('/studio/sidebar/projects', root, 'POST', body)
  assert.equal(first.status, 201)
  const id = first.data.createdProjectId
  const retried = await f.request('/studio/sidebar/projects', root, 'POST', body)
  assert.equal(retried.data.createdProjectId, id)
  assert.equal(retried.data.projects.length, 2)
  assert.equal((await f.request('/studio/sidebar/projects', root, 'POST', { ...body, title: '换了名称' })).status, 409)
  for (const invalid of [{ title: body.title }, { ...body, requestId: 'wrong' }, { requestId: body.requestId }]) {
    assert.equal((await f.request('/studio/sidebar/projects', root, 'POST', invalid)).status, 400)
  }
  await f.request(`/studio/sidebar/projects/${id}`, root, 'PATCH', { title: '创建后重命名' })
  await f.reopen(); root = await f.login()
  assert.equal((await f.request('/studio/sidebar/projects', root, 'POST', body)).data.createdProjectId, id)
  await f.request('/studio/admin/users', root, 'POST', { username: 'alice', display_name: '编剧甲', password: 'alice-test-password', role: 'employee' })
  const alice = await f.login('alice', 'alice-test-password')
  const other = await f.request('/studio/sidebar/projects', alice, 'POST', body)
  assert.equal(other.status, 201)
  assert.notEqual(other.data.createdProjectId, id)
  assert.equal(other.data.projects.length, 2)
})

test('可信创建回执允许先保存空对话归属，其他账号和猜测的会话仍被拒绝', async t => {
  const f = await fixture(t), root = await f.login()
  await f.request('/studio/admin/users', root, 'POST', { username: 'alice', display_name: '编剧甲', password: 'alice-test-password', role: 'employee' })
  const alice = await f.login('alice', 'alice-test-password')
  const created = await f.request('/studio/sidebar/projects', alice, 'POST', { title: '先选择的项目', requestId: randomUUID() })
  const projectId = created.data.createdProjectId
  const draft = await f.createDraft(alice)
  const route = `/studio/sidebar/sessions/${draft.stored_session_id}`
  assert.equal((await f.request(route, alice, 'PATCH', { projectId })).status, 200)
  assert.equal((await f.request('/studio/sidebar', alice)).data.sessions[0].projectId, projectId)
  assert.equal((await f.request(route, root, 'PATCH', { projectId: 'default' })).status, 404)
  assert.equal((await f.request(`/studio/sidebar/sessions/${draft.session_id}`, alice, 'PATCH', { projectId })).status, 404)
  assert.equal((await f.request('/studio/sidebar/sessions/guessed-draft', alice, 'PATCH', { projectId })).status, 404)
  await f.reopen()
  const restored = await f.login('alice', 'alice-test-password')
  assert.equal((await f.request('/studio/sidebar', restored)).data.sessions[0].projectId, projectId)
})

test('空会话证明只接受有效同账号同profile回执，并按期限和容量淘汰', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const service = new StudioBackend({ backend: 'http://127.0.0.1:1', repoRoot: '/tmp' })
  const user = { id: 'writer', profile: 'writer-profile' }
  service.rememberSession(user, { session_id: 'live', stored_session_id: 'stored' })
  assert.equal(service.ownsFreshSession(user, 'stored'), true)
  assert.equal(service.ownsFreshSession({ ...user, id: 'another' }, 'stored'), false)
  assert.equal(service.ownsFreshSession({ ...user, profile: 'another' }, 'stored'), false)
  assert.equal(service.ownsFreshSession(user, 'live'), false)
  service.rememberSession(user, { session_id: 'bad', stored_session_id: '../forged' })
  assert.equal(service.ownsFreshSession(user, '../forged'), false)
  t.mock.timers.tick(24 * 60 * 60 * 1000)
  assert.equal(service.ownsFreshSession(user, 'stored'), false)
  for (let index = 0; index < 5000; index++) service.rememberSession(user, { session_id: `live-${index}`, stored_session_id: `stored-${index}` })
  assert.equal(service.ownsFreshSession(user, 'stored-0'), false)
  assert.equal(service.ownsFreshSession(user, 'stored-4999'), true)
})

test('未选择项目的对话保存到最近并可在重开后恢复，项目和账号归属继续校验', async t => {
  const f = await fixture(t)
  let root = await f.login()
  await f.request('/studio/admin/users', root, 'POST', { username: 'alice', display_name: '编剧甲', password: 'alice-test-password', role: 'employee' })
  const alice = await f.login('alice', 'alice-test-password')
  const draft = await f.createDraft(root)
  const route = `/studio/sidebar/sessions/${draft.stored_session_id}`
  assert.equal((await f.request(route, root, 'PATCH', { projectId: null })).status, 200)
  assert.equal((await f.request(route, alice, 'PATCH', { projectId: null })).status, 404)
  assert.equal((await f.request(route, root, 'PATCH', { projectId: 'missing' })).status, 404)
  assert.equal((await f.request(route, root, 'PATCH', { projectId: '' })).status, 400)
  await f.reopen(); root = await f.login()
  assert.equal((await f.request('/studio/sidebar', root)).data.sessions[0].projectId, null)
  const stored = `/studio/sidebar/sessions/${root.user.profile}-stored`
  assert.equal((await f.request(stored, root, 'PATCH', { projectId: 'default' })).status, 200)
  assert.equal((await f.request('/studio/sidebar', root)).data.sessions.find(row => row.id === `${root.user.profile}-stored`).projectId, 'default')
})
