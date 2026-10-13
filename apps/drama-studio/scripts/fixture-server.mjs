// 只供本地界面验收：全部数据保存在内存中，不读取用户配置或调用模型。
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const token = 'studio-ui-fixture'
const receipts = []
const sessions = new Map()
let sequence = 0
const project = {
  id: 'fixture-project', title: '灯火归途 · 界面验收', stage: 'H1',
  source: { content: '女孩为了守住一家旧书店，与多年失联的父亲重新相遇。' },
  core: { content: '## 核心期待\n在守护与重逢中，重新理解家人的选择。' },
  outline_batches: [], script_batches: [], exports: []
}
const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:10621')
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<script>window.__HERMES_SESSION_TOKEN__="${token}"</script>`); return }
  if (url.pathname === '/fixture/receipts') { json(res, receipts); return }
  if (req.headers['x-hermes-session-token'] !== token) { res.statusCode = 401; json(res, { error: '测试鉴权失败' }); return }
  if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
    const session = sessions.get(url.pathname.split('/')[3])
    json(res, { messages: session?.messages ?? [], pagination: { returned: session?.messages.length ?? 0 } }); return
  }
  if (url.pathname === '/api/fs/download') { res.setHeader('Content-Type', 'text/plain'); res.end('这是隔离验收原稿。'); return }
  json(res, { text: '这是隔离验收原稿。', binary: false, truncated: false })
})
const ws = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://127.0.0.1:10621').searchParams.get('token') !== token) { socket.destroy(); return }
  ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client))
})
ws.on('connection', client => {
  const send = value => client.send(JSON.stringify(value))
  const event = (type, session_id, payload = {}) => send({ jsonrpc: '2.0', method: 'event', params: { type, session_id, payload } })
  event('gateway.ready', undefined, { heartbeat: false, replay_epoch: 'fixture' })
  client.on('message', bytes => {
    const frame = JSON.parse(String(bytes))
    if (!frame.method) {
      receipts.push({ method: 'approval.response', result: frame.result })
      const session = [...sessions.values()].find(row => row.approval === frame.id)
      if (!session) return
      const accepted = frame.result?.choice === 'once'
      project.stage = accepted ? 'M2A' : 'H1'
      const content = accepted ? '## 核心期待已确认\n我们将围绕“守护与重逢”展开三个改编方向。\n\n这是协议界面验收回复。' : '已保留草稿，等待你调整创作方向。'
      session.messages.push({ role: 'assistant', content })
      session.running = false
      event('message.delta', session.id, { text: content.slice(0, 15) })
      event('message.delta', session.id, { text: content.slice(15) })
      event('message.complete', session.id, { text: content, status: 'complete' })
      return
    }
    const params = frame.params || {}
    const reply = result => send({ jsonrpc: '2.0', id: frame.id, result })
    if (!['client.capabilities', 'gateway.ping'].includes(frame.method)) receipts.push({ method: frame.method, profile: params.profile, session_id: params.session_id, ...(frame.method === 'prompt.submit' ? { text: params.text } : {}) })
    const handlers = {
      'client.capabilities': () => reply({}), 'gateway.ping': () => reply({ pong: true }),
      'model.options': () => reply({ providers: [{ slug: 'fixture', name: '隔离验收', models: ['test-model'] }], model: 'test-model', provider: 'fixture' }),
      'session.list': () => reply({ sessions: [...sessions.values()].map(row => ({ id: row.id, title: row.title, message_count: row.messages.length, started_at: 1791086400 })) }),
      'session.create': () => {
        const session = { id: `fixture-${++sequence}`, title: params.title, messages: [], running: false }
        sessions.set(session.id, session)
        reply({ session_id: session.id, stored_session_id: session.id, message_count: 0, messages: [], info: { model: 'test-model' } })
      },
      'session.resume': () => {
        const row = sessions.get(params.session_id)
        reply({ session_id: row.id, stored_session_id: row.id, message_count: row.messages.length, messages: row.messages, running: row.running, info: { model: 'test-model' } })
      },
      'file.attach': () => reply({ attached: true, name: params.name, path: `/fixture/${params.name}`, ref_path: `/fixture/${params.name}`, ref_text: `@file:/fixture/${params.name}`, uploaded: true }),
      'prompt.submit': () => {
        const row = sessions.get(params.session_id)
        row.messages.push({ role: 'user', content: params.text })
        row.running = true
        reply({ status: 'streaming' })
        event('message.start', row.id)
        if (params.text.includes('中断测试')) return
        const toolId = `tool-${sequence}`
        event('tool.start', row.id, { tool_id: toolId, name: 'drama_submit', args: { kind: 'core' } })
        event('tool.complete', row.id, { tool_id: toolId, name: 'drama_submit', result: { ok: true, project }, duration_s: 1.2 })
        row.messages.push({ role: 'tool', name: 'drama_submit', content: JSON.stringify({ ok: true, project }) })
        row.approval = `approval-${sequence}`
        send({ jsonrpc: '2.0', id: row.approval, method: 'approval', params: { session_id: row.id, request_id: row.approval, description: '确认以“守护与重逢”作为这个故事的核心期待。', command: '确认核心期待', choices: ['once', 'deny'] } })
      },
      'session.interrupt': () => {
        const row = sessions.get(params.session_id); row.running = false
        reply({ interrupted: true })
        event('message.complete', row.id, { status: 'interrupted', text: '' })
      },
      'session.events.since': () => reply({ events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'fixture', open_requests: [] })
    }
    const handler = handlers[frame.method]
    if (handler) handler()
    else send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: '测试协议未实现此方法' } })
  })
})
server.listen(10621, '127.0.0.1', () => console.log('隔离界面协议服务：http://127.0.0.1:10621；不会调用模型。'))
