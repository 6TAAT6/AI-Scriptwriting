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

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-delete-')), sessions = new Map(), deleted = [], closed = [], activeChecks = new Map(), raceOnSecond = new Set()
  const source = profile => path.join(root, '.hermes/profiles', profile, 'attachments/原稿.txt')
  async function prepare(profile) {
    await mkdir(path.dirname(source(profile)), { recursive: true }); await writeFile(source(profile), '原稿必须保留')
    await mkdir(path.join(root, '.hermes/profiles', profile, 'workspace'), { recursive: true })
    await writeFile(path.join(root, '.hermes/profiles', profile, 'workspace/交付.docx'), '成果必须保留')
    for (const suffix of ['normal', 'archived', 'live', 'idle', 'racing']) sessions.set(profile + '-' + suffix, { profile, id: profile + '-' + suffix, title: suffix, live: ['live', 'idle', 'racing'].includes(suffix), status: suffix === 'live' ? 'working' : 'idle' })
  }
  await prepare('jubao-drama')
  const backend = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), profile = url.searchParams.get('profile'), id = decodeURIComponent(url.pathname.split('/')[3] || '')
    const row = sessions.get(id)
    res.setHeader('content-type', 'application/json')
    if (req.headers['x-hermes-session-token'] !== 'fixture-service-token' || !row || row.profile !== profile) { res.writeHead(404); return res.end('{}') }
    res.end(JSON.stringify({ id: row.id, title: row.title, messages: [{ role: 'assistant', content: '聊天内容' }] }))
  })
  const wss = new WebSocketServer({ server: backend })
  wss.on('connection', (ws, req) => {
    if (new URL(req.url, 'http://localhost').searchParams.get('token') !== 'fixture-service-token') return ws.close()
    ws.on('message', data => {
      const frame = JSON.parse(data), params = frame.params || {}
      let result, error
      if (frame.method === 'session.list') result = { sessions: [...sessions.values()].filter(row => row.profile === params.profile).map(row => ({ id: row.id, title: row.title })) }
      else if (frame.method === 'session.active_list') result = { sessions: [...sessions.values()].filter(row => row.profile === params.profile && row.live).map(row => {
        const count = (activeChecks.get(row.id) || 0) + 1; activeChecks.set(row.id, count)
        if (raceOnSecond.has(row.id) && count === 2) row.status = 'working'
        return { id: row.id + '-runtime', session_key: row.id, status: row.status }
      }) }
      else if (frame.method === 'session.close') {
        const row = [...sessions.values()].find(value => value.id + '-runtime' === params.session_id && value.profile === params.profile)
        if (row) { row.live = false; closed.push(row.id) }
        result = { closed: Boolean(row) }
      }
      else if (frame.method === 'session.resume') {
        const row = sessions.get(params.session_id)
        result = { session_id: row.id + '-runtime', stored_session_id: row.id, messages: [], info: { running: row.status === 'working' } }
      }
      else if (frame.method === 'delegation.status') result = { active: [] }
      else if (frame.method === 'session.delete') {
        const row = sessions.get(params.session_id)
        if (!row || row.profile !== params.profile) error = { code: 4007, message: 'fixture internal profile information' }
        else if (row.live) error = { code: 4023, message: 'fixture internal active information' }
        else { sessions.delete(row.id); deleted.push({ id: row.id, profile: params.profile }); result = { deleted: row.id } }
      } else error = { code: -32601, message: 'fixture unsupported' }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(error ? { error } : { result }) }))
    })
  })
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
  const edge = await createStudioEdge({ backend: `http://127.0.0.1:${backend.address().port}`, backendToken: 'fixture-service-token', repoRoot: root, dataDir: path.join(root, 'state'), provisionProfile: async profile => { await prepare(profile); return { profile } } })
  await edge.seedRoot('root-fixture-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(route, auth, method = 'GET', body, sourceOrigin = origin) {
    const response = await fetch(origin + route, { method, headers: { origin: sourceOrigin, ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': auth.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  async function login(username, password) { const result = await request('/studio/auth/login', null, 'POST', { username, password, activation_code: await fixtureActivationCode(edge.store, username, 'root-fixture-password')}); return { ...result.data, csrf: result.data.csrfToken, cookie: result.cookie } }
  const admin = await login('root', 'root-fixture-password')
  await request('/studio/admin/users', admin, 'POST', { username: 'alice', display_name: '员工', password: 'alice-password', role: 'employee' })
  const employee = await login('alice', 'alice-password')
  async function list(auth) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: auth.cookie, origin } })
    await once(ws, 'open'); const reply = once(ws, 'message')
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list', params: {} }))
    const [raw] = await reply; ws.close(); return JSON.parse(String(raw)).result.sessions
  }
  async function resume(auth, id) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: auth.cookie, origin } })
    await once(ws, 'open'); const reply = once(ws, 'message')
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.resume', params: { session_id: id } }))
    await reply; ws.close()
  }
  t.after(async () => { await edge.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]); await rm(root, { recursive: true, force: true }) })
  return { root, admin, employee, request, list, resume, sessions, deleted, closed, source, activeChecks, raceOnSecond }
}

test('删除自己的普通或归档聊天会清除真实会话与侧栏归属，原稿和交付文件保留', async t => {
  const f = await fixture(t)
  for (const auth of [f.admin, f.employee]) {
    const project = await f.request('/studio/sidebar/projects', auth, 'POST', { title: '项目', requestId: randomUUID() })
    for (const kind of ['normal', 'archived', 'idle']) {
      const id = auth.user.profile + '-' + kind, route = '/studio/sidebar/sessions/' + id
      if (kind === 'idle') await f.resume(auth, id)
      await f.request(route, auth, 'PATCH', { title: '准备删除', pinned: true, archived: kind === 'archived', projectId: project.data.createdProjectId })
      assert.ok((await f.list(auth)).some(row => row.id === id))
      const result = await f.request(route, auth, 'DELETE', {})
      assert.equal(result.status, 200); assert.ok(!result.data.sessions.some(row => row.id === id))
      assert.ok(!JSON.stringify(result.data).includes('准备删除'))
      assert.equal((await f.request(`/api/sessions/${id}/messages`, auth)).status, 404)
      assert.ok(!(await f.list(auth)).some(row => row.id === id))
      assert.equal(result.data.projects.length, 2)
    }
    assert.equal(await readFile(f.source(auth.user.profile), 'utf8'), '原稿必须保留')
    assert.equal(await readFile(path.join(f.root, '.hermes/profiles', auth.user.profile, 'workspace/交付.docx'), 'utf8'), '成果必须保留')
  }
  assert.equal(f.deleted.length, 6)
  assert.deepEqual(f.closed.sort(), [f.admin.user.profile + '-idle', f.employee.user.profile + '-idle'].sort())
  assert.ok(!JSON.stringify(await readFile(path.join(f.root, 'state/sidebar.json'), 'utf8')).includes('准备删除'))
})

test('归档项目可彻底删除其中聊天，活动任务和跨账号项目必须拒绝', async t => {
  const f = await fixture(t), auth = f.employee
  const created = await f.request('/studio/sidebar/projects',auth,'POST',{title:'归档项目',requestId:randomUUID()})
  const id=created.data.createdProjectId,route='/studio/sidebar/projects/'+id
  for (const suffix of ['normal','live']) await f.request('/studio/sidebar/sessions/'+auth.user.profile+'-'+suffix,auth,'PATCH',{projectId:id})
  assert.equal((await f.request(route,auth,'DELETE',{})).status,409)
  await f.request(route,auth,'PATCH',{hidden:true})
  assert.equal((await f.request(route,f.admin,'DELETE',{})).status,404)
  assert.equal((await f.request(route,auth,'DELETE',{})).status,409)
  assert.equal(f.deleted.length,0)
  f.sessions.get(auth.user.profile+'-live').status='idle'
  assert.equal((await f.request(route,auth,'DELETE',{})).status,409)
  assert.equal(f.deleted.length,0)
  f.sessions.get(auth.user.profile+'-live').live=false
  const result=await f.request(route,auth,'DELETE',{})
  assert.equal(result.status,200)
  assert.equal(result.data.projects.some(project=>project.id===id),false)
  assert.equal(result.data.sessions.some(row=>row.projectId===id),false)
  assert.deepEqual(f.deleted.map(row=>row.id).sort(),[auth.user.profile+'-live',auth.user.profile+'-normal'].sort())
  assert.equal((await f.request(route,auth,'DELETE',{})).status,404)
  // 默认项目清空后刷新不复活，显式属于“最近”的聊天必须保留。
  for (const row of f.sessions.values()) if (row.profile===auth.user.profile) row.live=false
  const recent=auth.user.profile+'-archived'
  await f.request('/studio/sidebar/sessions/'+recent,auth,'PATCH',{projectId:null})
  await f.request('/studio/sidebar/projects/default',auth,'PATCH',{hidden:true})
  const cleared=await f.request('/studio/sidebar/projects/default',auth,'DELETE',{})
  assert.equal(cleared.status,200)
  assert.deepEqual(cleared.data.projects,[])
  assert.deepEqual((await f.request('/studio/sidebar',auth)).data.projects,[])
  assert.ok((await f.list(auth)).some(row=>row.id===recent))
})

test('删除聊天复用账号归属与CSRF边界，拒绝运行中、未知和伪造目标', async t => {
  const f = await fixture(t), own = f.employee.user.profile + '-normal', route = '/studio/sidebar/sessions/' + own
  assert.equal((await f.request(route, null, 'DELETE', {})).status, 401)
  assert.equal((await f.request(route, { ...f.employee, csrf: 'invalid' }, 'DELETE', {})).status, 403)
  assert.equal((await f.request(route, f.employee, 'DELETE', {}, 'https://other.invalid')).status, 403)
  assert.equal((await f.request(route + '?profile=jubao-drama', f.employee, 'DELETE', {})).status, 400)
  assert.equal((await f.request(route, f.employee, 'DELETE', { profile: 'jubao-drama' })).status, 400)
  assert.equal((await f.request(route, f.admin, 'DELETE', {})).status, 404)
  assert.equal((await f.request('/studio/sidebar/sessions/jubao-drama-normal', f.employee, 'DELETE', {})).status, 404)
  for (const id of ['missing', 'bad%2Fid', 'bad%00id']) assert.ok([400, 404].includes((await f.request('/studio/sidebar/sessions/' + id, f.employee, 'DELETE', {})).status))
  const liveId = f.employee.user.profile + '-live', liveRoute = '/studio/sidebar/sessions/' + liveId
  const denied = await f.request(liveRoute, f.employee, 'DELETE', {})
  assert.equal(denied.status, 409); assert.ok(!JSON.stringify(denied.data).includes('fixture internal'))
  const racing = f.employee.user.profile + '-racing'
  await f.resume(f.employee, racing); f.raceOnSecond.add(racing); f.activeChecks.set(racing, 0)
  assert.equal((await f.request('/studio/sidebar/sessions/' + racing, f.employee, 'DELETE', {})).status, 409)
  assert.equal(f.closed.length, 0)
  assert.equal(f.deleted.length, 0); assert.ok((await f.list(f.employee)).some(row => row.id === own))
  f.sessions.get(liveId).live = false
  assert.equal((await f.request(liveRoute, f.employee, 'DELETE', {})).status, 200)
  assert.deepEqual(f.deleted, [{ id: liveId, profile: f.employee.user.profile }])
})
