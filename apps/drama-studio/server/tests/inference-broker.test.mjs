import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInferenceBroker } from '../inference-broker.mjs'

const CANARY = 'fixture-upstream-private-85632'
async function fixture(t) {
  const received = [], releases = [], heldEvents = new EventEmitter()
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    received.push({ url: req.url, headers: req.headers, body })
    if (req.url === '/v1/images/generations') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })); return }
    if (body.metadata?.test === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:1/' + CANARY }); return res.end(CANARY) }
    if (body.metadata?.test === 'error') { res.writeHead(500, { 'x-private-key': CANARY, 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: CANARY } })) }
    if (body.metadata?.test === 'rate-limit') { res.writeHead(429, { 'retry-after': '30' }); return res.end(CANARY) }
    if (body.metadata?.test === 'json-error') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: CANARY } })) }
    if (body.metadata?.test === 'hold') await new Promise(resolve => { releases.push(resolve); heldEvents.emit('held') })
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-private-key': CANARY })
      res.write(': private-debug=' + CANARY + '\r\n')
      res.write('data: {"choices":[{"delta":{"content":"正常"}}]}\r')
      await new Promise(resolve => setImmediate(resolve))
      res.write('\n\r\n')
      if (body.metadata?.test === 'stream-error') { res.write('event: error\ndata: {"error":{"message":"' + CANARY + '"}}\n\n') }
      else { res.write('data: {"choices":[{"delta":{"content":"回复"}}]}\n\n') }
      if (body.metadata?.test === 'stream-truncated') return res.end()
      if (body.metadata?.test === 'responses-completed') return res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n')
      if (body.metadata?.test === 'chat-completed') return res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      return res.end('data: [DONE]\n\n')
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-private-key': CANARY })
    res.end(JSON.stringify({ id: 'fixture', model: body.model, choices: [{ message: { content: '正常回复' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const broker = await createInferenceBroker({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: CANARY, models: ['model-a', 'model-b'], defaultModel: 'model-a', apiMode: 'chat_completions' })
  t.after(async () => { for (const release of releases) release(); await broker.close(); await new Promise(resolve => upstream.close(resolve)) })
  const request = async (scope, route = '/chat/completions', body = { model: 'model-a', messages: [{ role: 'user', content: '你好' }] }, headers = {}) => {
    const res = await fetch(scope.base_url + route, { method: body === null ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + scope.token, ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === null ? undefined : JSON.stringify(body), redirect: 'manual' })
    return { status: res.status, headers: res.headers, text: await res.text() }
  }
  const waitHeld = async count => { while (releases.length < count) await once(heldEvents, 'held', { signal: AbortSignal.timeout(5000) }) }
  const startRequest = (scope, route = '/chat/completions', body = { model: 'model-a', messages: [] }) => {
    const ready = Promise.withResolvers(), done = Promise.withResolvers()
    const req = httpRequest(scope.base_url + route, { method: 'POST', headers: {
      authorization: 'Bearer ' + scope.token, 'content-type': 'application/json', expect: '100-continue'
    } }, response => { response.resume(); response.once('end', () => done.resolve(response.statusCode)) })
    req.once('continue', () => { req.end(JSON.stringify(body)); ready.resolve() })
    req.once('error', error => { ready.reject(error); done.reject(error) })
    req.setTimeout(5000, () => req.destroy(new Error('验收请求超时')))
    void ready.promise.catch(() => {}); void done.promise.catch(() => {})
    t.after(async () => { req.destroy(); await Promise.allSettled([ready.promise, done.promise]) })
    req.flushHeaders()
    return { ready: ready.promise, done: done.promise, cancel: () => req.destroy() }
  }
  return { broker, received, releases, request, waitHeld, startRequest, upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1` }
}

test('带多张截图的原生视觉请求可通过代理，超出输入总量仍被拒绝', async t => {
  const f = await fixture(t), scope = f.broker.scope('images')
  const url = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024)
  const content = [{ type: 'text', text: '对照截图找不同' }, { type: 'image_url', image_url: { url } }]
  const response = await f.request(scope, '/chat/completions', { model: 'model-a', messages: [{ role: 'user', content }], stream: true })
  assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'))
  assert.deepEqual(f.received[0].body.messages[0].content, content)
  assert.equal((await f.request(scope, '/responses', { model: 'model-a', input: 'A'.repeat(33 * 1024 * 1024) })).status, 413)
  assert.equal(f.received.length, 1)
})

test('推理代理固定上游凭证并保留正常JSON和SSE，每个账号独立授权及撤销', async t => {
  const f = await fixture(t), a = f.broker.scope('alice'), b = f.broker.scope('bravo')
  assert.notEqual(a.token, b.token); assert.notEqual(a.base_url, b.base_url); assert.equal(f.broker.scope('alice').token, a.token)
  const models = await f.request(a, '/models', null)
  assert.equal(models.status, 200); assert.deepEqual(JSON.parse(models.text).data.map(row => row.id), ['model-a', 'model-b']); assert.equal(f.received.length, 0)
  const normal = await f.request(a, '/chat/completions', { model: 'model-b', messages: [{ role: 'user', content: '你好' }], tools: [{ type: 'function', function: { name: 'drama_review', parameters: { type: 'object' } } }] }, { 'x-api-key': 'caller-key', 'x-provider-url': 'https://ignored.invalid' })
  assert.equal(normal.status, 200); assert.equal(JSON.parse(normal.text).choices[0].message.content, '正常回复')
  assert.equal(f.received[0].headers.authorization, 'Bearer ' + CANARY); assert.equal(f.received[0].headers['x-api-key'], undefined); assert.equal(f.received[0].headers['x-provider-url'], undefined)
  assert.equal(normal.headers.get('x-private-key'), null)
  const stream = await f.request(b, '/responses', { model: 'model-a', input: '写作', stream: true, tools: [{ type: 'function', name: 'drama_review', parameters: { type: 'object' } }] })
  assert.equal(stream.status, 200); assert.ok(stream.text.includes('正常') && stream.text.includes('回复') && stream.text.includes('[DONE]'))
  f.broker.revoke('alice')
  assert.equal((await f.request(a)).status, 401); assert.equal((await f.request(b)).status, 200)
  const fresh = f.broker.scope('alice'); assert.notEqual(fresh.token, a.token); assert.equal((await f.request(fresh)).status, 200)
  assert.ok(!JSON.stringify([a, b, fresh]).includes(CANARY))
})

test('无网络容器通过私有 Unix 套接字访问同一账号模型目录，撤销和关闭同时生效', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-ipc-'))
  const unixSocket = path.join(root, 'broker.sock')
  const broker = await createInferenceBroker({ unixSocket, baseUrl: 'http://127.0.0.1:1/v1', apiKey: CANARY,
    models: ['fixture-model'], defaultModel: 'fixture-model', apiMode: 'chat_completions' })
  t.after(async () => { await broker.close(); await rm(root, { recursive: true, force: true }) })
  const a = broker.scope('alice'), b = broker.scope('bravo')
  const request = scope => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: unixSocket, path: new URL(scope.base_url).pathname + '/models',
      headers: { authorization: 'Bearer ' + scope.token } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }))
    }); req.once('error', reject); req.end()
  })
  assert.equal((await request(a)).status, 200)
  assert.equal((await stat(unixSocket)).mode & 0o777, 0o600)
  assert.equal((await request({ ...a, token: b.token })).status, 401)
  broker.revoke('alice')
  assert.equal((await request(a)).status, 401)
  assert.equal((await request(b)).status, 200)
  await broker.close()
  await assert.rejects(request(b))
})

test('推理代理拒绝越权及越界请求，上游异常和SSE错误不会泄露运营凭证', async t => {
  const f = await fixture(t), a = f.broker.scope('alice'), b = f.broker.scope('bravo')
  assert.equal((await f.request({ ...a, token: b.token })).status, 401)
  assert.equal((await f.request({ ...a, token: 'invalid' })).status, 401)
  for (const route of ['/files', '/../../models', '/chat/completions?url=https://evil.invalid']) assert.ok([400, 403, 404].includes((await f.request(a, route)).status))
  const invalid = [
    { model: 'unapproved', messages: [] }, { model: 'model-a', max_tokens: 131073 }, { model: 'model-a', max_output_tokens: -1 },
    { model: 'model-a', base_url: 'https://evil.invalid' }, { model: 'model-a', api_key: 'override' },
    { model: 'model-a', tools: [{ type: 'web_search_preview' }] }, { model: 'model-a', tools: [{ type: 'mcp', server_url: 'https://evil.invalid' }] },
    { model: 'model-a', input: 'x'.repeat(8 * 1024 * 1024) }, { model: 'model-a', store: true },
    { model: 'model-a', previous_response_id: 'foreign-session' }, { model: 'model-a', messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'foreign-file' } }] }] }
  ]
  for (const body of invalid) assert.ok([400, 403, 413].includes((await f.request(a, '/chat/completions', body)).status))
  assert.equal(f.received.length, 0)
  for (const name of ['error', 'json-error', 'redirect', 'stream-error']) {
    const result = await f.request(a, '/chat/completions', { model: 'model-a', messages: [], stream: name === 'stream-error', metadata: { test: name } })
    assert.ok(!result.text.includes(CANARY)); assert.equal(result.headers.get('x-private-key'), null); assert.equal(result.headers.get('location'), null)
    assert.ok(result.text.includes('"type":"studio_inference_error"'), '两种传输都必须返回可识别且已脱敏的错误协议')
  }
  const limited = await f.request(a, '/chat/completions', { model: 'model-a', metadata: { test: 'rate-limit' } })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '30')
  assert.equal(JSON.parse(limited.text).error.code, 'provider_rate_limited')
  assert.ok(!limited.text.includes(CANARY))
  const held = Array.from({ length: 10 }, () => f.request(a, '/chat/completions', { model: 'model-a', metadata: { test: 'hold' } }))
  await f.waitHeld(10)
  const queued = f.startRequest(a)
  await queued.ready
  assert.equal((await f.request(b)).status, 200)
  for (const release of f.releases) release()
  assert.ok((await Promise.all(held)).every(result => result.status === 200))
  assert.equal(await queued.done, 200, '第十一条请求等待账号空位后执行，不消耗模型重试次数')
})

test('多模型接入按供应商路由和密钥隔离，新增或轮换凭证不重启代理', async t => {
  const f = await fixture(t), original = f.broker.scope('alice')
  const secondaryRequests = [], liveReleases = []
  let observeLive
  const secondary = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    secondaryRequests.push({ authorization: req.headers.authorization, model: body.model })
    if (body.metadata?.hold) await new Promise(resolve => { liveReleases.push(resolve); observeLive?.() })
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '第二模型' } }] }))
  })
  secondary.listen(0, '127.0.0.1'); await once(secondary, 'listening')
  t.after(() => { for (const release of liveReleases) release(); secondary.closeAllConnections(); return new Promise(resolve => secondary.close(resolve)) })
  const endpoint = { id: 'additional', name: '第二接入', baseUrl: `http://127.0.0.1:${secondary.address().port}/v1`, apiKey: 'second-secret', models: ['model-c'], defaultModel: 'model-c', apiMode: 'responses' }
  f.broker.updateProviders([endpoint])
  const updated = f.broker.scope('alice'), other = f.broker.scope('bravo')
  assert.equal(updated.base_url, original.base_url); assert.equal(updated.token, original.token)
  assert.equal(updated.providers.length, 1)
  const extra = updated.providers[0]
  assert.equal(new URL(extra.base_url).port, new URL(original.base_url).port)
  assert.equal(extra.api_mode, 'responses')
  assert.equal((await f.request(extra, '/responses', { model: 'model-c', input: '写作' })).status, 200)
  assert.equal((await f.request({ ...extra, token: other.token }, '/responses', { model: 'model-c', input: '写作' })).status, 401)
  assert.equal((await f.request(extra, '/responses', { model: 'model-a', input: '写作' })).status, 403)
  assert.deepEqual(secondaryRequests, [{ authorization: 'Bearer second-secret', model: 'model-c' }])
  f.broker.updateProviders([{ ...endpoint, apiKey: 'rotated-secret' }])
  assert.equal((await f.request(extra, '/responses', { model: 'model-c', input: '写作' })).status, 200)
  assert.equal(secondaryRequests[1].authorization, 'Bearer rotated-secret')
  assert.equal((await f.request(original)).status, 200)
  assert.equal(JSON.stringify(updated).includes('second-secret'), false)
  const held = Array.from({ length: 10 }, () => f.request(original, '/chat/completions', { model: 'model-a', metadata: { test: 'hold' } }))
  await f.waitHeld(10)
  const queued = f.startRequest(extra, '/responses', { model: 'model-c', input: '写作' })
  await queued.ready
  for (const release of f.releases) release()
  await Promise.all(held)
  assert.equal(await queued.done, 200)
  const partial = () => {
    const text = JSON.stringify({ model: 'model-c', input: '写作' })
    const done = Promise.withResolvers(), ready = Promise.withResolvers()
    const request = httpRequest(extra.base_url + '/responses', { method: 'POST', headers: {
      authorization: 'Bearer ' + extra.token, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(text), expect: '100-continue'
    } }, response => {
      response.resume(); response.once('end', () => done.resolve(response.statusCode))
    })
    request.once('continue', () => { request.write(text.slice(0, 10)); ready.resolve() })
    request.once('error', error => { ready.reject(error); done.reject(error) })
    request.setTimeout(5000, () => request.destroy(new Error('测试请求未及时结束')))
    // 断言失败也要观察清理阶段的请求拒绝，避免退出测试后产生未处理错误。
    void done.promise.catch(() => {})
    void ready.promise.catch(() => {})
    t.after(async () => { request.destroy(); await Promise.allSettled([done.promise, ready.promise]) })
    request.flushHeaders()
    return { done: done.promise, ready: ready.promise, finish: () => request.end(text.slice(10)) }
  }
  const changes = [[], [{ ...endpoint, apiKey: 'new-secret' }], [{ ...endpoint, models: ['model-d'], defaultModel: 'model-d' }]]
  for (const changed of changes) {
    f.broker.updateProviders([endpoint])
    const uploads = [partial(), partial()]
    // 上传尚未完成时不能占用供应商执行名额，但仍受轮换与撤销约束。
    await Promise.all(uploads.map(upload => upload.ready))
    assert.equal((await f.request(extra, '/responses', { model: 'model-c', input: '屏障' })).status, 200)
    const before = secondaryRequests.length
    f.broker.updateProviders(changed)
    for (const upload of uploads) upload.finish()
    assert.ok((await Promise.all(uploads.map(upload => upload.done))).every(status => status >= 400), '旧配置请求不能在撤销或轮换后继续发送')
    assert.equal(secondaryRequests.length, before, '未上传完的请求不能使用已撤销的接入、模型或密钥')
  }
  for (const changed of [[], [{ ...endpoint, apiKey: 'another-secret' }]]) {
    f.broker.updateProviders([endpoint])
    const entered = new Promise(resolve => { observeLive = resolve })
    const running = f.request(extra, '/responses', { model: 'model-c', input: '写作', metadata: { hold: true } })
    await entered
    f.broker.updateProviders(changed)
    const cancelled = await running
    assert.ok(cancelled.status >= 400); assert.ok(!cancelled.text.includes('second-secret'))
    liveReleases.at(-1)()
  }
})

test('账号队列有上限，等待请求随账号撤销取消，不会在释放槽位后执行', async t => {
  const f = await fixture(t), account = f.broker.scope('alice')
  const running = Array.from({ length: 10 }, () => f.request(account, '/chat/completions', { model: 'model-a', metadata: { test: 'hold' } }))
  void Promise.allSettled(running)
  await f.waitHeld(10)
  const queued = Array.from({ length: 40 }, () => f.startRequest(account))
  const prematurelyFinished = []
  for (const request of queued) void request.done.then(code => prematurelyFinished.push(code), () => {})
  await Promise.all(queued.map(request => request.ready))
  assert.equal((await f.request(account)).status, 429, '满队列才返回过载，不无限积压请求')
  assert.equal(prematurelyFinished.length, 0, '已入队请求应保持等待，不立即被限流拒绝')
  assert.equal(f.received.length, 10)
  f.broker.revoke('alice')
  assert.ok((await Promise.all(queued.map(request => request.done))).every(code => code >= 400))
  for (const release of f.releases) release()
  await Promise.all(running)
  assert.equal(f.received.length, 10, '已撤销的排队请求不能使用旧账号或凭证进入上游')
  const fresh = f.broker.scope('alice')
  assert.equal((await f.request(fresh)).status, 200)
})

test('图片模型走专用接口，账号不能换密钥、请求外部图片或把图片模型当聊天模型', async t => {
  const f = await fixture(t)
  f.broker.updateProviders([], { baseUrl: f.upstreamBase, apiKey: CANARY, models: ['model-a'], defaultModel: 'model-a', apiMode: 'chat_completions', imageModels: ['image-a'], imageModel: 'image-a' })
  // 使用真实受控上游，图片调用与聊天继续共用账号凭证和并发队列。
  const settings = f.received
  const a = f.broker.scope('alice'), b = f.broker.scope('bravo')
  expectImage(a)
  function expectImage(scope) { assert.deepEqual(scope.image_models, ['image-a']); assert.equal(scope.image_model, 'image-a') }
  for (const body of [{ model: 'image-a', prompt: '测试', n: 2 }, { model: 'model-a', prompt: '测试' }, { model: 'image-a', prompt: '测试', image: 'http://private.invalid' }]) {
    assert.ok([400, 403].includes((await f.request(a, '/images/generations', body)).status))
  }
  assert.equal((await f.request({ ...a, token: b.token }, '/images/generations', { model: 'image-a', prompt: '测试' })).status, 401)
  assert.equal((await f.request(a, '/chat/completions', { model: 'image-a', messages: [] })).status, 403)
  assert.equal(settings.length, 0)
  const image = await f.request(a, '/images/generations', { model: 'image-a', prompt: '一座山', n: 1, size: '1024x1024' })
  assert.equal(image.status, 200)
  assert.deepEqual(JSON.parse(image.text).data, [{ b64_json: 'aW1hZ2U=' }])
  assert.equal(f.received[0].headers.authorization, 'Bearer ' + CANARY)
  assert.equal(f.received[0].body.store, undefined)
})

test('上游流缺少完成回执时返回明确错误，两种协议的正常结束仍保留', async t => {
  const f = await fixture(t), scope = f.broker.scope('truncated-stream')
  for (const [route, input, completed] of [
    ['/chat/completions', { messages: [] }, 'chat-completed'],
    ['/responses', { input: '写完本场戏' }, 'responses-completed']
  ]) {
    const truncated = await f.request(scope, route, { model: 'model-a', ...input, stream: true, metadata: { test: 'stream-truncated' } })
    assert.match(truncated.text, /event: error/, '收到部分正文后直接 EOF 不能被当成本轮成功')
    assert.ok(truncated.text.includes('正常') && truncated.text.includes('回复') && truncated.text.indexOf('回复') < truncated.text.indexOf('event: error'), '失败回执须保留之前已收到的正文')
    assert.ok(!truncated.text.includes(CANARY))
    const normal = await f.request(scope, route, { model: 'model-a', ...input, stream: true, metadata: { test: completed } })
    assert.equal(normal.status, 200)
    assert.ok(normal.text.includes('正常') && normal.text.includes('回复'))
    assert.ok(!normal.text.includes('event: error'), '原生完成回执无需额外伪造 [DONE]')
  }
})
