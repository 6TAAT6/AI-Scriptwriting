import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'

const CANARY = 'fixture-private-provider-76543'
async function fixture(t, { emptySessionDatabase = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-boundary-'))
  const requests = [], responses = [], peers = new Set(), historyOverrides = new Map(), replayOverrides = new Map(), resumeOverrides = new Map(), subagentOverrides = new Map()
  const home = profile => path.join(root, '.hermes/profiles', profile)
  const file = profile => path.join(home(profile), 'attachments/原稿.txt')
  const project = profile => ({ id: 'project-a', title: '测试剧本', stage: 'H1', api_key: CANARY,
    source: { content: '这是原稿', internal: CANARY }, core: { content: '核心期待' },
    exports: [{ path: path.join(home(profile), 'workspace/交付.docx'), api_key: CANARY }] })
  const messages = profile => historyOverrides.get(profile) ?? [{ role: 'system', content: CANARY },
    { role: 'user', content: `请阅读 @file:\`${file(profile)}\`\n\n--- Attached Context ---\n${CANARY}` },
    { role: 'tool', tool_call_id: 'tool-a', name: 'drama_project_status', content: JSON.stringify({ ok: true, project: project(profile), debug: CANARY }) },
    { role: 'assistant', content: '可以开始创作。', reasoning: CANARY, tool_calls: [{ function: { arguments: CANARY } }] }]
  const be = createServer(async (req, res) => {
    if (req.url === '/') return res.end('<script>window.__HERMES_SESSION_TOKEN__="fixture-only-token";</script>')
    const url = new URL(req.url, 'http://localhost'), profile = url.searchParams.get('profile')
    if (url.pathname === '/api/studio/model-endpoints') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ endpoints: [{ id: 'configured', name: '测试接入', models: ['approved-model'] }] })) }
    if (emptySessionDatabase && (url.pathname.startsWith('/api/sessions/') || url.pathname === '/api/fs/download' && url.searchParams.has('session_id'))) {
      res.writeHead(404); return res.end('{}')
    }
    if (url.pathname.startsWith('/api/sessions/')) {
      if (url.pathname.split('/')[3] !== profile + '-stored') { res.writeHead(404); return res.end('{}') }
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: profile + '-stored', messages: messages(profile), cwd: home(profile) }))
    }
    if (url.pathname === '/api/fs/read-text') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ path: url.searchParams.get('path'), text: '原稿内容', debug: CANARY })) }
    if (url.pathname === '/api/fs/download' && url.searchParams.get('path')?.includes('/cache/spillover/')) { res.setHeader('content-type', 'text/plain'); return res.end(JSON.stringify({ ok: true, project: project(profile), debug: CANARY })) }
    if (url.pathname === '/api/fs/download' && url.searchParams.get('path')?.endsWith('.png')) {
      res.setHeader('content-type', 'image/png'); return res.end(await readFile(url.searchParams.get('path')))
    }
    if (url.pathname === '/api/fs/download' && /\.(docx|xlsx)$/i.test(url.searchParams.get('path') || '')) {
      res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); return res.end(await readFile(url.searchParams.get('path')))
    }
    res.setHeader('content-type', 'text/plain'); res.end('原稿内容')
  })
  const wss = new WebSocketServer({ server: be })
  wss.on('connection', ws => {
    peers.add(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { version: 'Hermes', api_key: CANARY } } }))
    ws.on('message', async raw => {
      const frame = JSON.parse(raw)
      if (!frame.method) { responses.push(frame); return }
      requests.push(frame)
      const p = { profile: 'jubao-drama', ...frame.params }, sid = p.profile + '-live'
      const uploaded = p.name?.endsWith('.png') ? path.join(home(p.profile), 'attachments', p.name) : file(p.profile)
      if (frame.method === 'file.attach' && p.name?.endsWith('.png')) await writeFile(uploaded, Buffer.from(p.data_url.split(',')[1], 'base64'))
      const results = {
        'model.options': { model: 'approved-model', provider: 'configured', api_key: CANARY, providers: [{ slug: 'configured', name: '创作模型', models: ['approved-model'], api_url: CANARY, key_env: CANARY, warning: CANARY }] },
        'session.create': { session_id: sid, stored_session_id: p.profile + '-stored', messages: [], info: { model: 'approved-model', provider: 'configured', cwd: home(p.profile), api_key: CANARY } },
        'session.resume': { session_id: sid, stored_session_id: p.session_id, messages: messages(p.profile), info: { running: false, system_prompt: CANARY }, open_requests: [], ...resumeOverrides.get(p.profile) },
        'subagent.list': subagentOverrides.get(p.session_id) ?? { subagents: [], delegations: [] },
        'session.list': { sessions: [{ id: p.profile + '-stored', title: '测试剧本', preview: '创作预览', cwd: CANARY }] },
        'file.attach': { attached: true, name: p.name, path: uploaded, ref_path: uploaded, ref_text: `@file:\`${uploaded}\``, uploaded: true, api_key: CANARY },
        'prompt.submit': { accepted: true, debug: CANARY },
        'session.events.since': replayOverrides.get(p.session_id) ?? { latest_seq: 5, epoch: 'fixture-epoch', truncated: false, count: 2,
          events: [{ type: 'tool.complete', session_id: p.session_id, seq: 4, payload: { tool_id: 'replay', name: 'terminal', result: CANARY } }, { type: 'reasoning.delta', session_id: p.session_id, seq: 5, payload: { text: CANARY } }],
          open_requests: [{ jsonrpc: '2.0', id: 'replay-system', method: 'secret', params: { session_id: p.session_id, prompt: CANARY } }] },
        'gateway.ping': { pong: true, debug: CANARY }
      }
      if (frame.method === 'session.interrupt') ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 5033, message: CANARY, data: { api_key: CANARY } } }))
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: results[frame.method] || { ok: true } }))
    })
  })
  be.listen(0, '127.0.0.1'); await once(be, 'listening')
  const edge = await createStudioEdge({ backend: `http://127.0.0.1:${be.address().port}`, backendToken: 'fixture-only-token', dataDir: path.join(root, 'state'), repoRoot: root,
    provisionProfile: async profile => {
      await mkdir(path.join(home(profile), 'attachments'), { recursive: true }); await mkdir(path.join(home(profile), 'workspace'), { recursive: true })
      await writeFile(file(profile), '原稿内容'); await writeFile(path.join(home(profile), 'workspace/交付.docx'), '交付内容')
      await writeFile(path.join(home(profile), 'workspace/内部数据库.db'), CANARY)
      await mkdir(path.join(home(profile), 'cache/spillover'), { recursive: true })
      await writeFile(path.join(home(profile), 'cache/spillover/call_fixture.txt'), JSON.stringify({ project: { id: 'on-disk-internal', title: CANARY } }))
      return { profile }
    } })
  await edge.seedRoot('root-fixture-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(route, auth, body, method = body ? 'POST' : 'GET') {
    const res = await fetch(origin + route, { method, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': auth.csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (username, password) => { const result = await request('/studio/auth/login', null, { username, password, activation_code: await fixtureActivationCode(edge.store, username, 'root-fixture-password')}); return { ...result.data, cookie: result.cookie } }
  const admin = await login('root', 'root-fixture-password')
  const employees = []
  for (const username of ['alice', 'bravo']) {
    await request('/studio/admin/users', admin, { username, display_name: username, password: username + '-password', role: 'employee' })
    employees.push(await login(username, username + '-password'))
  }
  await request('/studio/admin/users', admin, { username: 'manager', display_name: '组长', password: 'manager-password', role: 'admin' })
  const manager = await login('manager', 'manager-password')
  async function connect(auth) {
    const frames = [], ws = new WebSocket(origin.replace('http', 'ws') + '/api/ws', { headers: { Cookie: auth.cookie, Origin: origin } })
    ws.on('message', data => frames.push(JSON.parse(data))); await once(ws, 'open')
    let id = 0
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id, timer = setTimeout(() => { ws.off('message', cb); reject(new Error(`等待 ${method} 响应超时，连接状态 ${ws.readyState}`)) }, 5000)
      const cb = data => { const frame = JSON.parse(data); if (frame.id === key) { clearTimeout(timer); ws.off('message', cb); resolve(frame) } }
      ws.on('message', cb); ws.send(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }))
    })
    return { ws, rpc, frames }
  }
  t.after(async () => { await edge.close(); for (const peer of peers) peer.terminate(); await new Promise(resolve => wss.close(resolve)); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => be.close(resolve))]); await rm(root, { recursive: true, force: true }) })
  return { request, connect, employees, admin, manager, home, file, project, requests, responses, peers, historyOverrides, replayOverrides, resumeOverrides, subagentOverrides }
}

test('截图上传后以视觉内容交给原生会话，历史保留附件且拒绝伪图片和跨账号读取', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees, a = await f.connect(alice), b = await f.connect(bravo)
  const sid = (await a.rpc('session.create')).result.session_id, other = (await b.rpc('session.create')).result.session_id
  const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const image = 'data:image/png;base64,' + encoded
  const upload = await a.rpc('file.attach', { session_id: sid, name: '截图.png', data_url: image })
  assert.equal(upload.result?.attached, true)
  const ref = upload.result.ref_text
  assert.ok(ref.startsWith('@file:`/assets-data/'))
  const sent = await a.rpc('prompt.submit', { session_id: sid, text: '请识别图片中的文字\n' + ref })
  assert.equal(sent.result?.accepted, true, JSON.stringify(sent))
  const parts = f.requests.findLast(row => row.method === 'prompt.submit').params.text
  assert.equal(parts[0].type, 'text'); assert.ok(parts[0].text.startsWith('请识别图片中的文字'))
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: image } })
  f.historyOverrides.set(alice.user.profile, [{ role: 'user', content: parts }])
  const restored = await a.rpc('session.resume', { session_id: alice.user.profile + '-stored' })
  assert.ok(restored.result.messages[0].text.includes(ref))
  assert.ok(!JSON.stringify(restored).includes(encoded))
  assert.equal((await b.rpc('prompt.submit', { session_id: other, text: ref })).error?.code, 403)
  assert.equal((await a.rpc('file.attach', { session_id: sid, name: '伪图片.png', data_url: 'data:image/png;base64,aGVsbG8=' })).error?.code, 400)
  assert.equal((await a.rpc('prompt.submit', { session_id: sid, text: [{ type: 'image_url', image_url: { url: 'file:///secret.png' } }] })).error?.code, 400)
})

test('员工实时与重放事件保留同一子代理身份和公开回顾，隔离内部正文及其他账号快照', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees, a = await f.connect(alice), b = await f.connect(bravo)
  const sid = (await a.rpc('session.create')).result.session_id, other = (await b.rpc('session.create')).result.session_id
  const identity = { subagent_id: 'child-a', parent_id: 'parent-a', child_session_id: 'child-session-a', delegation_id: 'batch-a', task_count: 1, task_index: 0, depth: 1, model: 'approved-model', goal: '创作第 9—12 集', tool_count: 3 }
  const privateFields = { reasoning: CANARY, tool_preview: CANARY, summary: CANARY, output_tail: [{ tool: 'terminal', preview: CANARY }], args: { command: CANARY }, system_prompt: CANARY }
  const events = [
    ...['subagent.spawn_requested', 'subagent.start', 'subagent.progress', 'subagent.complete'].map((type, index) => ({ type, payload: { ...identity, ...privateFields, text: CANARY, status: index === 3 ? 'completed' : index === 0 ? 'queued' : 'running', ...(index === 2 ? { tool_name: 'read_file' } : {}), ...(index === 3 ? { duration_seconds: 59 } : {}) } })),
    { type: 'review.summary', payload: { text: '技能已完成修补。', ...privateFields } },
    { type: 'background.complete', payload: { task_id: 'background-a', text: '初稿已完成。', ...privateFields } },
    { type: 'status.update', payload: { kind: 'lifecycle', text: CANARY, ...privateFields } },
    { type: 'subagent.thinking', payload: { ...identity, ...privateFields, text: CANARY } },
    { type: 'subagent.tool', payload: { ...identity, ...privateFields, tool_name: 'read_file', text: CANARY } },
    { type: 'notification.show', payload: { key: 'retry-notice', level: 'warn', kind: 'sticky', text: '连接恢复后将继续。', ...privateFields } },
    { type: 'notification.clear', payload: { key: 'retry-notice', ...privateFields } },
    { type: 'tool.start', payload: { tool_id: 'skill-a', name: 'skill_view', args: { name: 'jubao-drama:drama-workflow', command: CANARY } } },
    { type: 'tool.complete', payload: { tool_id: 'skill-a', name: 'skill_view', args: { name: 'jubao-drama:drama-workflow' }, result: { success: false, error: CANARY, content: CANARY } } }
  ].map((row, index) => ({ ...row, session_id: sid, seq: index + 1, timestamp: 123 + index }))
  for (const event of events) [...f.peers][0].send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event }))
  await a.rpc('gateway.ping')
  const live = a.frames.filter(frame => frame.params?.session_id === sid).map(frame => frame.params)
  assert.deepEqual(live.map(row => row.type), events.map(row => row.type), '公开生命周期事件不能被员工投影丢弃')
  assert.deepEqual(live.slice(0, 4).map(row => row.payload.subagent_id), ['child-a', 'child-a', 'child-a', 'child-a'])
  assert.equal(live[0].payload.goal, identity.goal); assert.equal(live[2].payload.tool_name, 'read_file')
  assert.equal(live[3].payload.duration_seconds, 59); assert.equal(live[4].payload.text, '技能已完成修补。')
  assert.equal(live[5].payload.task_id, 'background-a'); assert.equal(live[5].payload.text, '初稿已完成。')
  assert.equal(live[6].payload.kind, 'lifecycle'); assert.ok(live[6].payload.text)
  assert.equal(live[7].payload.subagent_id, 'child-a'); assert.equal(live[8].payload.tool_name, 'read_file')
  assert.equal(live[9].payload.text, '连接恢复后将继续。'); assert.equal(live[10].payload.key, 'retry-notice')
  assert.equal(live[11].payload.args.name, 'jubao-drama:drama-workflow')
  assert.equal(live[12].payload.result.ok, false); assert.match(live[12].payload.result.summary, /技能加载失败/)
  assert.match(live[12].payload.result.summary, /jubao-drama:drama-workflow/)
  f.replayOverrides.set(sid, { events, epoch: 'native-activity', latest_seq: 13, truncated: false })
  const replay = await a.rpc('session.events.since', { session_id: sid, last_seen: 0 })
  assert.deepEqual(replay.result.events, live)
  f.subagentOverrides.set(sid, { subagents: [{ ...identity, ...privateFields, started_at: 123, status: 'running', last_tool: 'read_file', accepting_steer: true }], delegations: [{ delegation_id: 'failed-batch', task_index: 1, status: 'failed', goal: '复核第 8 集', error: CANARY, dispatched_at: 120, completed_at: 130 }] })
  const snapshot = await a.rpc('subagent.list', { session_id: sid })
  assert.equal(snapshot.result.subagents[0].subagent_id, 'child-a'); assert.equal(snapshot.result.subagents[0].last_tool, 'read_file')
  assert.equal(snapshot.result.subagents[0].started_at, 123); assert.equal(snapshot.result.delegations[0].status, 'failed')
  assert.equal((await b.rpc('subagent.list', { session_id: sid })).error.code, 403)
  assert.equal((await a.rpc('subagent.list', { session_id: other })).error.code, 403)
  assert.equal((await a.rpc('subagent.list', { session_id: sid, subagent_id: 'child-a' })).error.code, 400)
  assert.ok(!JSON.stringify([live, replay, snapshot]).includes(CANARY))
})

test('员工恢复保留运行中快照和自动续接标记，HTTP 与 WS 历史不返回隐藏恢复指令', async t => {
  const f = await fixture(t), user = f.employees[0], client = await f.connect(user)
  const metadata = { task_count: 2, completed_count: 1, failed_count: 1, duration_seconds: 59, delegation_id: 'batch-a', display_text: '后台任务已完成。', notification_category: 'diagnostic', private: CANARY, error_surface: { raw: CANARY } }
  f.historyOverrides.set(user.user.profile, [
    { role: 'user', row_id: 1, timestamp: 100, content: CANARY, display_kind: 'auto_continue', display_metadata: metadata },
    { role: 'user', row_id: 2, timestamp: 110, content: '[ASYNC DELEGATION ' + CANARY, display_kind: 'async_delegation_complete', display_metadata: JSON.stringify(metadata) },
    { role: 'user', row_id: 3, timestamp: 115, content: CANARY, display_kind: 'process_complete', display_metadata: { display_text: 'Background Process Finished: ' + CANARY } }
  ])
  f.resumeOverrides.set(user.user.profile, { running: true, status: 'resuming', turn_started_at: 123, auto_continue: { attempt: 2, interrupted_at: 120, prompt: CANARY },
    inflight: { assistant: '', streaming: true, user: CANARY, display_kind: 'auto_continue', display_metadata: metadata, reasoning: CANARY, corrections: ['继续第 9 集'], correction_offsets: [0], error: CANARY, status: 'error', recoverable: true },
    info: { running: true, turn_started_at: 123, system_prompt: CANARY } })
  const resumed = await client.rpc('session.resume', { session_id: user.user.profile + '-stored' })
  assert.equal(resumed.result.inflight.streaming, true, '空正文的运行中回合仍应恢复')
  assert.equal(resumed.result.inflight.display_kind, 'auto_continue'); assert.equal(resumed.result.inflight.recoverable, true)
  assert.equal(resumed.result.auto_continue.attempt, 2); assert.equal(resumed.result.auto_continue.interrupted_at, 120)
  assert.deepEqual(resumed.result.inflight.corrections, ['继续第 9 集']); assert.deepEqual(resumed.result.inflight.correction_offsets, [0])
  const history = await f.request(`/api/sessions/${user.user.profile}-stored/messages`, user)
  assert.equal(history.data.messages.length, 3)
  assert.equal(history.data.messages[0].display_kind, 'auto_continue'); assert.equal(history.data.messages[0].timestamp, 100)
  assert.equal(history.data.messages[1].display_metadata.task_count, 2)
  assert.equal(history.data.messages[1].display_metadata.display_text, '后台任务已完成。')
  assert.deepEqual(resumed.result.messages, history.data.messages)
  assert.ok(!JSON.stringify([resumed, history]).includes(CANARY))
})

test('所有创作账号只收到剧本业务确认，技术权限实时及恢复请求均拒绝而不自动批准', async t => {
  const f = await fixture(t)
  for (const auth of [f.admin, f.manager, f.employees[0]]) {
    const client = await f.connect(auth), sid = (await client.rpc('session.create')).result.session_id
    const peer = [...f.peers].at(-1), prefix = auth.user.username, key = 'plugin_rule:jubao-drama:' + 'b'.repeat(32)
    const requests = suffix => [
      { id: prefix + suffix + '-shell', method: 'approval', params: { session_id: sid, request_id: 'technical', pattern_key: 'script_execution', description: 'script execution via -e/-c flag', command: CANARY, choices: ['once', 'always', 'deny'] } },
      { id: prefix + suffix + '-mixed', method: 'approval', params: { session_id: sid, pattern_key: key, pattern_keys: [key, 'shell'], description: '混合权限', command: CANARY } },
      { id: prefix + suffix + '-secret', method: 'secret', params: { session_id: sid, prompt: CANARY } },
      { id: prefix + suffix + '-system', method: 'system', params: { session_id: sid, prompt: CANARY } },
      { id: prefix + suffix + '-gate', method: 'approval', params: { session_id: sid, request_id: 'business', pattern_key: key, pattern_keys: [key], description: '确认第 9—12 集正式提交', command: CANARY, choices: ['once', 'always', 'deny'], allow_permanent: true } },
      { id: prefix + suffix + '-clarify', method: 'clarify', params: { session_id: sid, questions: [{ qid: 'work', question: '接着创作哪一部？', choices: ['小福星', '曾逢君时花照眼'], internal: CANARY }], prompt: CANARY } }
    ].map(row => ({ jsonrpc: '2.0', ...row }))
    const assertProjected = (rows, suffix) => {
      assert.deepEqual(rows.map(row => row.id), [prefix + suffix + '-gate', prefix + suffix + '-clarify'])
      assert.deepEqual(rows[0].params.choices, ['once', 'deny'])
      assert.equal(rows[0].params.allow_permanent, false); assert.equal(rows[0].params.allow_session, false)
      assert.equal(rows[0].params.description, '确认第 9—12 集正式提交')
      assert.equal(rows[1].params.questions[0].question, '接着创作哪一部？')
      assert.ok(!JSON.stringify(rows).includes(CANARY)); assert.ok(!JSON.stringify(rows).includes('command'))
    }
    for (const frame of requests('-live')) peer.send(JSON.stringify(frame))
    await client.rpc('gateway.ping')
    assertProjected(client.frames.filter(frame => frame.method && frame.id?.startsWith?.(prefix + '-live')), '-live')
    client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: prefix + '-live-gate', result: { choice: 'once', all: true } }))
    client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: prefix + '-live-clarify', result: { answers: { work: '小福星', system: CANARY }, all: true } }))
    await client.rpc('gateway.ping')
    assert.deepEqual(f.responses.find(row => row.id === prefix + '-live-gate').result, { choice: 'once' })
    assert.deepEqual(f.responses.find(row => row.id === prefix + '-live-clarify').result, { answers: { work: '小福星' } })
    f.resumeOverrides.set(auth.user.profile, { open_requests: requests('-resume') })
    const resumed = await client.rpc('session.resume', { session_id: auth.user.profile + '-stored' })
    assertProjected(resumed.result.open_requests, '-resume')
    f.replayOverrides.set(sid, { latest_seq: 0, events: [], open_requests: requests('-replay') })
    const replayed = await client.rpc('session.events.since', { session_id: sid, last_seen: 0 })
    assertProjected(replayed.result.open_requests, '-replay')
    client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: prefix + '-replay-gate', result: { choice: 'always' } }))
    await client.rpc('gateway.ping')
    assert.deepEqual(f.responses.find(row => row.id === prefix + '-replay-gate').result, { choice: 'deny' })
    for (const suffix of ['-live', '-resume', '-replay']) {
      for (const type of ['shell', 'mixed']) assert.deepEqual(f.responses.filter(row => row.id === prefix + suffix + '-' + type).map(row => row.result), [{ choice: 'deny' }])
      for (const type of ['system', 'secret']) assert.equal(f.responses.filter(row => row.id === prefix + suffix + '-' + type)[0]?.error.code, -32601)
    }
  }
})

test('员工协议按业务字段投影，系统请求拒绝但保留当前产物的真实确认', async t => {
  const f = await fixture(t), user = f.employees[0], client = await f.connect(user)
  const names = (await f.request('/studio/admin/model-names', f.admin)).data.models
  await f.request('/studio/admin/model-names', f.admin, { models: names.map(row => row.id === 'brand-text-1' ? { ...row, model: 'approved-model', provider: 'configured' } : row) })
  const catalog = await client.rpc('model.options', { include_unconfigured: true })
  const created = await client.rpc('session.create', { model: catalog.result.model, provider: catalog.result.provider })
  const sid = created.result.session_id
  const history = await f.request(`/api/sessions/${user.user.profile}-stored/messages`, user)
  const resumed = await client.rpc('session.resume', { session_id: user.user.profile + '-stored' })
  const error = await client.rpc('session.interrupt', { session_id: sid })
  const replay = await client.rpc('session.events.since', { session_id: sid, last_seen: 0 })
  assert.ok(!JSON.stringify([catalog, created, history.data, resumed, error, replay]).includes(CANARY), '内部字段不能进入员工 HTTP/WS 响应')
  assert.equal(replay.result.events.length, 2); assert.equal(replay.result.events[0].type, 'tool.complete'); assert.equal(replay.result.events[0].seq, 4)
  assert.equal(replay.result.events[1].type, 'reasoning.delta'); assert.deepEqual(replay.result.events[1].payload, {})
  assert.equal(replay.result.latest_seq, 5); assert.deepEqual(replay.result.open_requests, [])
  assert.equal(f.requests.find(row => row.method === 'model.options').params.include_unconfigured, false)
  assert.equal((await client.rpc('session.create', { model: 'unapproved-model', provider: 'configured' })).error.code, 403)
  const peer = [...f.peers][0]
  const send = frame => peer.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
  send({ method: 'event', params: { type: 'status.update', session_id: sid, payload: { kind: 'compacting', text: CANARY } } })
  send({ method: 'event', params: { type: 'thinking.delta', session_id: sid, payload: { text: '(¬‿¬) 推敲… ' + CANARY } } })
  send({ method: 'event', params: { type: 'tool.start', session_id: sid, payload: { tool_id: 'stage', name: 'drama_submit', args: { kind: 'outline_batch', data: CANARY } } } })
  await client.rpc('gateway.ping')
  assert.deepEqual(client.frames.findLast(frame => frame.params?.type === 'thinking.delta').params.payload, {})
  assert.equal(client.frames.findLast(frame => frame.params?.type === 'status.update').params.payload.kind, 'compacting')
  assert.ok(client.frames.findLast(frame => frame.params?.type === 'status.update').params.payload.text)
  assert.deepEqual(client.frames.findLast(frame => frame.params?.type === 'tool.start').params.payload.args, { kind: 'outline_batch' })
  send({ method: 'event', params: { type: 'tool.complete', session_id: sid, payload: { tool_id: 'tool-a', name: 'drama_project_status', result: { ok: true, project: f.project(user.user.profile), debug: CANARY }, args: { command: CANARY }, duration_s: 2 } } })
  for (const request of [{ id: 'secret', method: 'secret', params: { prompt: CANARY } }, { id: 'system', method: 'approval', params: { session_id: sid, command: CANARY, pattern_key: 'shell' } }]) send(request)
  send({ id: 'gate', method: 'approval', params: { session_id: sid, request_id: 'approval-a', pattern_key: 'plugin_rule:jubao-drama:' + 'a'.repeat(32), description: '请确认核心期待', command: CANARY, choices: ['once', 'always', 'deny'] } })
  await client.rpc('gateway.ping')
  const gate = client.frames.find(frame => frame.id === 'gate')
  assert.ok(gate); assert.deepEqual(gate.params.choices, ['once', 'deny']); assert.ok(!gate.params.command)
  assert.ok(!client.frames.some(frame => ['secret', 'system'].includes(frame.id)))
  assert.ok(!JSON.stringify(client.frames).includes(CANARY))
  client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'gate', result: { choice: 'once', all: true } }))
  await client.rpc('gateway.ping')
  assert.deepEqual(f.responses.find(row => row.id === 'gate').result, { choice: 'once' })
  const sidebar = await f.request('/studio/sidebar', user)
  assert.equal(sidebar.data.canReveal, false)
  assert.equal((await f.request('/studio/sidebar/project/reveal', user, {})).status, 403)
  const manager = await f.connect(f.manager)
  const managerCatalog = await manager.rpc('model.options', { include_unconfigured: true })
  const managerSession = await manager.rpc('session.create', { model: managerCatalog.result.model, provider: managerCatalog.result.provider })
  const managerHistory = await f.request(`/api/sessions/${f.manager.user.profile}-stored/messages`, f.manager)
  assert.ok(!JSON.stringify([managerCatalog, managerSession, managerHistory.data]).includes(CANARY))
  assert.equal((await f.request('/studio/sidebar', f.manager)).data.canReveal, false)
  assert.equal((await f.request('/studio/sidebar/project/reveal', f.manager, {})).status, 403)
  assert.equal((await f.request('/studio/admin/users', f.manager, { username: 'new-staff', display_name: '新员工', password: 'staff-password', role: 'employee' })).status, 201)
  assert.equal((await f.request('/studio/admin/users', f.manager, { username: 'peer-admin', display_name: '非法提权', password: 'staff-password', role: 'admin' })).status, 403)
  f.historyOverrides.set(user.user.profile, [{ role: 'tool', tool_call_id: 'spillover', name: 'drama_project_status', content: `<persisted-output>\nFull output saved to: ${f.home(user.user.profile)}/cache/spillover/call_fixture.txt\n</persisted-output>` }])
  const spillover = await f.request(`/api/sessions/${user.user.profile}-stored/messages`, user)
  assert.equal(spillover.data.messages[0].content.project.id, 'project-a', '恢复回执只能经过隔离工作进程读取')
  const segments = ['我使用 Her', 'mes Agent，来自 No', 'us Research。工作路径：', ...f.home(user.user.profile).split(''), '/workspace/草稿.md，继续写作。']
  const original = segments.join(''), projected = '我使用 创作引擎，来自 创作团队。工作路径：工作区/workspace/草稿.md，继续写作。'
  const firstFrame = client.frames.length
  for (const text of segments) send({ method: 'event', params: { type: 'message.delta', session_id: sid, payload: { text } } })
  send({ method: 'event', params: { type: 'message.interim', session_id: sid, payload: { text: original, already_streamed: true } } })
  send({ method: 'event', params: { type: 'tool.start', session_id: sid, payload: { name: 'drama_rules_read', tool_id: 'rules' } } })
  send({ method: 'event', params: { type: 'message.delta', session_id: sid, payload: { text: '正文保留尾字H' } } })
  send({ method: 'event', params: { type: 'message.complete', session_id: sid, payload: { status: 'complete' } } })
  await client.rpc('gateway.ping')
  const visible = client.frames.slice(firstFrame).filter(frame => frame.method === 'event')
  assert.equal(visible.filter(frame => frame.params.type === 'message.delta').slice(0, segments.length).map(frame => frame.params.payload.text).join(''), projected)
  assert.equal(visible.find(frame => frame.params.type === 'message.interim').params.payload.text, projected)
  assert.equal(visible.find(frame => frame.params.type === 'tool.start').params.payload.name, 'drama_rules_read')
  assert.equal(visible.find(frame => frame.params.type === 'message.complete').params.payload.text, '正文保留尾字H')
  f.historyOverrides.set(user.user.profile, [{ role: 'user', content: original }, { role: 'assistant', content: original }])
  const full = await f.request(`/api/sessions/${user.user.profile}-stored/messages`, user)
  assert.equal(full.data.messages[0].content, original)
  assert.equal(full.data.messages[1].content, projected)
  send({ method: 'event', params: { type: 'message.delta', session_id: sid, payload: { text: '直播：Her' } } })
  f.replayOverrides.set(sid, { latest_seq: 8, epoch: 'fixture-epoch', truncated: false, events: [
    { type: 'message.delta', session_id: sid, seq: 6, payload: { text: '回放：No' } },
    { type: 'message.delta', session_id: sid, seq: 7, payload: { text: 'us Research。' } },
    { type: 'message.complete', session_id: sid, seq: 8, payload: { text: '回放：Nous Research。', status: 'complete' } }
  ], open_requests: [] })
  const brandedReplay = await client.rpc('session.events.since', { session_id: sid, last_seen: 5 })
  assert.equal(brandedReplay.result.events.filter(row => row.type === 'message.delta').map(row => row.payload.text).join(''), '回放：创作团队。')
  const managerPeer = [...f.peers][1]
  managerPeer.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: managerSession.result.session_id, payload: { text: 'mes是剧本里的片段。' } } }))
  send({ method: 'event', params: { type: 'message.delta', session_id: sid, payload: { text: 'mes。' } } })
  send({ method: 'event', params: { type: 'message.complete', session_id: sid, payload: { status: 'complete' } } })
  await client.rpc('gateway.ping'); await manager.rpc('gateway.ping')
  assert.equal(client.frames.findLast(frame => frame.params?.type === 'message.complete').params.payload.text, '直播：创作引擎。')
  assert.equal(manager.frames.findLast(frame => frame.params?.type === 'message.delta').params.payload.text, 'mes是剧本里的片段。')
})

test('员工文件句柄只解析已登记资料并绑定账号，原路径及伪造引用不能绕过', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees, a = await f.connect(alice), b = await f.connect(bravo)
  const own = await a.rpc('session.create'), other = await b.rpc('session.create')
  const imagePath = path.join(f.home(alice.user.profile), 'cache/generated/images/result.png')
  await mkdir(path.dirname(imagePath), { recursive: true }); await writeFile(imagePath, 'fixture-image-bytes')
  const peer = [...f.peers][0]
  peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', session_id: own.result.session_id, payload: { tool_id: 'image', name: 'image_generate', result: { success: true, image: imagePath, api_key: CANARY } } } }))
  await a.rpc('gateway.ping')
  const imageResult = a.frames.find(frame => frame.params?.payload?.tool_id === 'image').params.payload.result
  assert.match(imageResult.image, /^\/assets-data\//)
  assert.ok(!JSON.stringify(imageResult).includes(CANARY))
  const imageRoute = '/api/fs/download?path=' + encodeURIComponent(imageResult.image)
  assert.equal((await f.request(imageRoute, alice)).status, 200)
  assert.equal((await f.request(imageRoute, bravo)).status, 403)
  f.historyOverrides.set(alice.user.profile, [{ role: 'tool', tool_name: 'image_generate', tool_call_id: 'image', content: JSON.stringify({ success: true, image: imagePath }) }])
  const restoredImage = await f.request(`/api/sessions/${alice.user.profile}-stored/messages`, alice)
  assert.equal(restoredImage.data.messages[0].name, 'image_generate')
  assert.equal(restoredImage.data.messages[0].content.image, imageResult.image)
  f.historyOverrides.delete(alice.user.profile)
  const attached = await a.rpc('file.attach', { session_id: own.result.session_id, name: '原稿.txt', data_url: 'data:text/plain;base64,5Y6f56i/' })
  assert.match(attached.result.path, /^\/assets-data\/[A-Za-z0-9_-]+\/[^/]+\.txt$/)
  assert.ok(!JSON.stringify(attached).includes('.hermes'))
  for (const invalid of [f.file(alice.user.profile), path.join(f.home(alice.user.profile), 'workspace/内部数据库.db')]) assert.equal((await f.request('/api/fs/download?path=' + encodeURIComponent(invalid), alice)).status, 403)
  const route = '/api/fs/download?path=' + encodeURIComponent(attached.result.path)
  assert.equal((await f.request(route, alice)).data, '原稿内容')
  assert.equal((await f.request(route, bravo)).status, 403)
  const preview = await f.request('/api/fs/read-text?path=' + encodeURIComponent(attached.result.path), alice)
  assert.equal(preview.data.text, '原稿内容'); assert.ok(!JSON.stringify(preview).includes(CANARY)); assert.ok(!JSON.stringify(preview).includes('.hermes'))
  await a.rpc('prompt.submit', { session_id: own.result.session_id, text: attached.result.ref_text })
  assert.ok(f.requests.findLast(row => row.method === 'prompt.submit').params.text.includes(await realpath(f.file(alice.user.profile))))
  assert.equal((await b.rpc('prompt.submit', { session_id: other.result.session_id, text: attached.result.ref_text })).error.code, 403)
  assert.equal((await a.rpc('prompt.submit', { session_id: own.result.session_id, text: '@file:/assets-data/forged/原稿.txt' })).error.code, 403)
  assert.equal((await a.rpc('prompt.submit', { session_id: own.result.session_id, text: '@file:' + f.file(alice.user.profile) })).error.code, 403)
  const blockedCommands = ['/config show', ' \t\n/TOOLS enable terminal', '///plugins install external', '/model\nlist', '\u001b[200~/terminal ls\u001b[201~', '^[[200~/any-new-command x^[[201~', '[200~/skills list[201~', '【本轮语言偏好】\n中文\n\n【用户本轮消息】\n本次任务：完整改编。\n\n/config show']
  for (const text of blockedCommands) assert.equal((await a.rpc('prompt.submit', { session_id: own.result.session_id, text })).error?.code, 403, '原生控制命令不能借创作消息进入后端')
  for (const text of ['第 1 场 / 夜 / 内景\n人物说：这是 /config 示例。', '/演员/场景/分镜', '访问 https://example.invalid/剧本']) assert.equal((await a.rpc('prompt.submit', { session_id: own.result.session_id, text })).result.accepted, true)
  for (const method of ['slash.exec', 'command.dispatch']) assert.equal((await a.rpc(method, { session_id: own.result.session_id, command: '/config', name: 'config' })).error.code, 403)
  assert.equal((await f.request(route, alice)).status, 200)
})

test('空会话尚未持久化时已上传附件可下载，其他账号和伪造会话仍被拒绝', async t => {
  const f = await fixture(t, { emptySessionDatabase: true }), [alice, bravo] = f.employees
  const client = await f.connect(alice)
  const session = (await client.rpc('session.create')).result
  const upload = (await client.rpc('file.attach', { session_id: session.session_id, name: '原稿.txt', data_url: 'data:text/plain;base64,5Y6f56i/' })).result
  assert.equal(upload.attached, true)
  assert.equal((await client.rpc('session.resume', { session_id: session.stored_session_id })).result?.session_id, session.session_id)
  const other = await f.connect(bravo)
  assert.equal((await other.rpc('session.resume', { session_id: session.stored_session_id })).error?.code, 404)
  const route = '/api/fs/download?path=' + encodeURIComponent(upload.path) + '&session_id='
  const downloaded = await f.request(route + encodeURIComponent(session.stored_session_id), alice)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.data, '原稿内容')
  assert.equal((await f.request(route + encodeURIComponent(session.stored_session_id), bravo)).status, 403)
  assert.equal((await f.request(route + 'unknown-session', alice)).status, 404)
  assert.equal((await f.request('/api/fs/download?path=' + encodeURIComponent(f.file(alice.user.profile)), alice)).status, 403)
})

test('正文导出链接在实时、恢复和历史中转换为可下载句柄，超级管理员同样可用', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees
  for (const auth of [alice, f.admin]) {
    const file = path.join(f.home(auth.user.profile), 'workspace/Hermes 交付 成稿?#.docx')
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '当前账号交付正文')
    const connection = await f.connect(auth), session = (await connection.rpc('session.create')).result
    const peer = [...f.peers].at(-1)
    const text = `[下载成稿](sandbox:${file})`
    const push = (type, payload) => peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: session.session_id, payload } }))
    push('message.start', {})
    for (const fragment of [text.slice(0, 18), text.slice(18, 37), text.slice(37)]) push('message.delta', { text: fragment })
    push('message.complete', { status: 'completed' })
    await connection.rpc('gateway.ping')
    const projected = connection.frames.find(frame => frame.params?.type === 'message.complete').params.payload.text
    const target = projected.match(/\[下载成稿\]\((\/assets-data\/[^)]+)\)/)?.[1]
    assert.ok(target, '没有最终全文时也需使用原始增量还原下载目标')
    assert.ok(!projected.includes(f.home(auth.user.profile)))
    assert.ok(target.includes('%20') && target.includes('%3F') && target.includes('%23'))
    push('message.start', {})
    push('message.complete', { status: 'completed', text: `[下载成稿](sandbox:${encodeURIComponent(file)})` })
    await connection.rpc('gateway.ping')
    assert.equal(connection.frames.findLast(frame => frame.params?.type === 'message.complete').params.payload.text, projected)
    const handle = decodeURIComponent(target)
    const route = '/api/fs/download?path=' + encodeURIComponent(handle) + '&session_id=' + session.stored_session_id
    assert.equal((await f.request(route, auth)).data, '当前账号交付正文')
    assert.equal((await f.request(route, bravo)).status, 403)
    f.historyOverrides.set(auth.user.profile, [{ role: 'assistant', content: text }])
    const restored = (await connection.rpc('session.resume', { session_id: session.stored_session_id })).result
    assert.equal(restored.messages[0].content, projected)
    const history = await f.request(`/api/sessions/${session.stored_session_id}/messages`, auth)
    assert.equal(history.data.messages[0].content, projected)
    f.replayOverrides.set(session.session_id, { events: [{ type: 'message.complete', session_id: session.session_id, payload: { text } }] })
    const replay = (await connection.rpc('session.events.since', { session_id: session.session_id, last_seen: 0 })).result
    assert.equal(replay.events[0].payload.text, projected)
    if (auth === f.admin) assert.equal((await f.request('/api/fs/download?path=' + encodeURIComponent(file), auth)).data, '当前账号交付正文')
  }
})

test('正文下载链接不把缺失文件、跨账号路径或越界符号链接登记成句柄', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees, client = await f.connect(alice)
  const session = (await client.rpc('session.create')).result
  const foreign = path.join(f.home(bravo.user.profile), 'workspace/交付.docx')
  const escaped = path.join(f.home(alice.user.profile), 'workspace/别人的稿件.docx')
  await symlink(foreign, escaped)
  for (const target of [foreign, escaped, path.join(f.home(alice.user.profile), 'workspace/缺失.docx'), 'workspace/交付.docx', '%ZZ']) {
    f.historyOverrides.set(alice.user.profile, [{ role: 'assistant', content: `[下载成稿](sandbox:${target})` }])
    const result = await f.request(`/api/sessions/${session.stored_session_id}/messages`, alice)
    assert.equal(result.status, 200)
    assert.equal(result.data.messages[0].content, '下载成稿')
  }
  assert.equal((await f.request('/api/fs/download?path=' + encodeURIComponent('/assets-data/' + 'a'.repeat(32) + '/交付.docx'), f.admin)).status, 403)
})

test('真实绝对图片链接沿用图片句柄，可从正文下载并保持外部链接和预览语法', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees
  for (const auth of [alice, f.admin]) {
    const image = path.join(f.home(auth.user.profile), 'cache/generated/images/海报 原图.png')
    await mkdir(path.dirname(image), { recursive: true }); await writeFile(image, 'fixture-actual-image')
    const client = await f.connect(auth), session = (await client.rpc('session.create')).result
    const peer = [...f.peers].at(-1)
    const text = `[下载图片文件](${image})\n[外部说明](https://example.com/help)\n![图片预览](https://example.com/preview.png)`
    peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: session.session_id, payload: { text } } }))
    await client.rpc('gateway.ping')
    const projected = client.frames.findLast(frame => frame.params?.type === 'message.complete').params.payload.text
    const target = projected.match(/\[下载图片文件\]\((\/assets-data\/[^)]+)\)/)?.[1]
    assert.ok(target, '图片绝对路径须在展示脱敏前注册为真实账号句柄')
    assert.ok(projected.includes('[外部说明](https://example.com/help)'))
    assert.ok(projected.includes('![图片预览](https://example.com/preview.png)'))
    const route = '/api/fs/download?path=' + encodeURIComponent(decodeURIComponent(target)) + '&session_id=' + session.stored_session_id
    assert.equal((await f.request(route, auth)).data, 'fixture-actual-image')
    assert.equal((await f.request(route, bravo)).status, 403)
    f.historyOverrides.set(auth.user.profile, [{ role: 'assistant', content: `[下载图片文件](sandbox:${image})` }])
    assert.equal((await f.request(`/api/sessions/${session.stored_session_id}/messages`, auth)).data.messages[0].content, `[下载图片文件](${target})`)
  }
})

test('绝对本地链接不公开敏感文件，不将脱敏别名猜测为真实图片', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees, client = await f.connect(alice)
  const session = (await client.rpc('session.create')).result
  const home = f.home(alice.user.profile), privateFile = path.join(home, 'cache/spillover/call_fixture.txt')
  for (const target of [privateFile, path.join(home, 'config.yaml'), path.join(f.home(bravo.user.profile), 'workspace/交付.docx'), '工作区/cache/generated/images/猜测.png']) {
    f.historyOverrides.set(alice.user.profile, [{ role: 'assistant', content: `[下载资料](${target})` }])
    const result = await f.request(`/api/sessions/${session.stored_session_id}/messages`, alice)
    assert.equal(result.status, 200)
    assert.equal(result.data.messages[0].content, '下载资料')
  }
})

test('三种角色的明确相对稿件链接按自身工作区下载，拒绝穿越与协议伪装', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees
  for (const auth of [alice, f.manager, f.admin]) {
    const file = path.join(f.home(auth.user.profile), 'workspace/修订版.xlsx')
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '相对引用的真实修订稿')
    const client = await f.connect(auth), session = (await client.rpc('session.create')).result
    let handle
    for (const target of ['./修订版.xlsx', '修订版.xlsx']) {
      f.historyOverrides.set(auth.user.profile, [{ role: 'assistant', content: `[下载修订稿](${target})` }])
      const reply = await f.request(`/api/sessions/${session.stored_session_id}/messages`, auth)
      const link = reply.data.messages[0].content.match(/\[下载修订稿\]\((\/assets-data\/[^)]+)\)/)?.[1]
      assert.ok(link, '只能从当前账号的真实 workspace 解析相对文件')
      handle ??= link
      assert.equal(link, handle)
      const route = '/api/fs/download?path=' + encodeURIComponent(decodeURIComponent(link)) + '&session_id=' + session.stored_session_id
      assert.equal((await f.request(route, auth)).data, '相对引用的真实修订稿')
      assert.equal((await f.request(route, bravo)).status, 403)
    }
    for (const target of ['./../config.yaml', './%2E%2E/attachments/原稿.txt', './config.yaml', './file:修订版.docx', 'file:///tmp/修订版.docx']) {
      f.historyOverrides.set(auth.user.profile, [{ role: 'assistant', content: `[下载修订稿](${target})` }])
      const reply = await f.request(`/api/sessions/${session.stored_session_id}/messages`, auth)
      assert.equal(reply.status, 200)
      assert.equal(reply.data.messages[0].content, '下载修订稿')
    }
  }
})

test('历史与恢复按原生逻辑身份折叠压缩副本并保序，保留真实重复发送', async t => {
  const f = await fixture(t), [alice] = f.employees
  const uid = '3607ffb986d045848d6502c285a18a2b'
  const messages = [
    { id: 72, role: 'user', message_uid: uid, timestamp: 1791263762.999628, active: 0, compacted: 1, content: '首轮真实要求\n' },
    { id: 80, role: 'assistant', content: '首轮答复' },
    { id: 146, role: 'user', message_uid: uid, timestamp: 1791263762.999628, active: 1, content: '更早活跃副本' },
    { id: 148, role: 'user', message_uid: uid, timestamp: 1791263762.999628, active: 1, compacted: 0, content: '首轮真实要求' },
    { id: 160, role: 'user', message_uid: uid, timestamp: 1791263762.999628, active: 0, compacted: 1, content: '较晚归档副本' },
    { id: 161, role: 'user', timestamp: 20, content: '再次确认' },
    { id: 162, role: 'user', timestamp: 20, content: '再次确认' },
    { id: 163, role: 'user', message_uid: 'different-a', timestamp: 20, content: '再次确认' },
    { id: 164, role: 'user', message_uid: 'different-b', timestamp: 20, content: '再次确认' },
    { id: 165, role: 'assistant', message_uid: uid, content: '角色不同仍保留' }
  ]
  for (const auth of [alice, f.manager, f.admin]) {
    const client = await f.connect(auth), session = (await client.rpc('session.create')).result
    f.historyOverrides.set(auth.user.profile, messages)
    const history = (await f.request(`/api/sessions/${session.stored_session_id}/messages`, auth)).data.messages
    const restored = (await client.rpc('session.resume', { session_id: session.stored_session_id })).result.messages
    for (const rows of [history, restored]) {
      assert.deepEqual(rows.map(row => row.id), [148, 80, 161, 162, 163, 164, 165])
      assert.deepEqual(rows.map(row => row.content), ['首轮真实要求', '首轮答复', '再次确认', '再次确认', '再次确认', '再次确认', '角色不同仍保留'])
    }
  }
})

test('管理员通过真实HTTP读取员工图片和稿件，移除或停用后拒绝旧句柄及跨会话发送', async t => {
  const f = await fixture(t), [alice, bravo] = f.employees
  const image = path.join(f.home(alice.user.profile), 'cache/generated/images/scene.png')
  await mkdir(path.dirname(image), { recursive: true })
  const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  await writeFile(image, Buffer.from(encoded, 'base64'))
  f.historyOverrides.set(alice.user.profile, [
    { role: 'user', row_id: 1, content: `原稿 @file:\`${f.file(alice.user.profile)}\`` },
    { role: 'tool', row_id: 2, name: 'image_generate', content: JSON.stringify({ success: true, image }) },
    { role: 'assistant', row_id: 3, content: `![员工图片](${image})` },
    { role: 'tool', row_id: 4, name: 'drama_export', content: JSON.stringify({ ok: true, project: f.project(alice.user.profile) }) }
  ])
  const route = `/studio/employee-conversations/${alice.user.id}/sessions/${alice.user.profile}-stored/messages`
  assert.equal((await f.request(route, f.manager)).status, 403)
  const granted = await f.request('/studio/employee-conversations', f.manager, { employee_id: alice.user.id })
  const observed = await f.request(route, f.manager)
  assert.equal(observed.status, 200)
  assert.ok(!JSON.stringify(observed.data).includes(f.home(alice.user.profile)))
  const rows = observed.data.messages, imageHandle = rows[1].content.image
  const sourceHandle = rows[0].text.match(/@file:`([^`]+)`/)[1]
  const exportHandle = rows[3].content.project.exports[0].path
  const download = handle => '/api/fs/download?path=' + encodeURIComponent(handle)
  assert.equal((await f.request(download(sourceHandle), f.manager)).data, '原稿内容')
  assert.equal((await f.request(download(exportHandle), f.manager)).data, '交付内容')
  assert.equal((await f.request('/api/fs/read-text?path=' + encodeURIComponent(sourceHandle), f.manager)).data.text, '原稿内容')
  const imageResult = await f.request(download(imageHandle), f.manager)
  assert.equal(imageResult.status, 200)
  for (const auth of [alice, bravo, f.admin]) assert.equal((await f.request(download(imageHandle), auth)).status, 403)
  const client = await f.connect(f.manager), session = (await client.rpc('session.create')).result
  assert.equal((await client.rpc('prompt.submit', { session_id: session.session_id, text: '@file:`' + sourceHandle + '`' })).error?.code, 403)
  await f.request(`/studio/employee-conversations/assignments/${granted.data.assignment.id}`, f.manager, {}, 'DELETE')
  assert.equal((await f.request(download(imageHandle), f.manager)).status, 403)
  await f.request('/studio/employee-conversations', f.manager, { employee_id: alice.user.id })
  const freshHandle = (await f.request(route, f.manager)).data.messages[1].content.image
  await f.request(`/studio/admin/users/${alice.user.id}`, f.admin, { enabled: false }, 'PATCH')
  assert.equal((await f.request(download(freshHandle), f.manager)).status, 404)
})
