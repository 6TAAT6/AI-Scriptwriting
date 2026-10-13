import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createInferenceBroker } from '../inference-broker.mjs'

async function fixture(t, handler, timeouts) {
  const upstream = createServer(handler), diagnostics = []
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const broker = await createInferenceBroker({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'fixture-secret', models: ['fixture-model'], defaultModel: 'fixture-model', apiMode: 'chat_completions', timeouts, onDiagnostic: row => diagnostics.push(row) })
  t.after(async () => { await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  const scope = broker.scope('fixture-account')
  const request = stream => fetch(scope.base_url + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + scope.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: '仅本地受控响应' }], stream }), signal: AbortSignal.timeout(12000) })
  return { request, diagnostics }
}

test('持续输出超过空闲时限仍能完成，静默停滞返回明确超时且释放名额', async t => {
  let finish = false, count = 0
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n')
    const timer = setInterval(() => {
      if (finish) return
      if (++count <= 4) res.write('data: {"choices":[{"delta":{"content":"继续"}}]}\n\n')
      else { clearInterval(timer); res.end('data: [DONE]\n\n') }
    }, 500)
    res.once('close', () => clearInterval(timer))
  }, { firstResponseMs: 3000, idleMs: 1800, totalMs: 10000 })
  const first = await f.request(true)
  const stream = await first.text()
  assert.ok(stream.includes('[DONE]'))
  assert.ok(!stream.includes('event: error'))
  finish = true
  const stalled = await f.request(true)
  const text = await stalled.text()
  assert.ok(text.includes('provider_idle_timeout'), '静默断流必须携带准确原因，不能无期限挂住')
  assert.equal(f.diagnostics.at(-1)?.code, 'provider_idle_timeout')
  assert.equal(f.diagnostics.at(-1)?.account, 'fixture-account')
  assert.ok(!JSON.stringify(f.diagnostics).includes('fixture-secret'))
})

test('上游拒绝请求与首个响应超时可区分，凭据和原始上游正文不流出', async t => {
  let silent = false, upstreamStatus = 400
  const f = await fixture(t, (req, res) => {
    req.resume()
    if (silent) return
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'fixture-secret private prompt' } }))
  }, { firstResponseMs: 2000, idleMs: 3000, totalMs: 10000 })
  const rejected = await f.request(false), body = await rejected.json()
  assert.equal(rejected.status, 400)
  assert.equal(body.error.code, 'context_length_exceeded')
  assert.ok(!JSON.stringify(body).includes('fixture-secret'))
  assert.equal(f.diagnostics.at(-1)?.upstreamStatus, 400)
  upstreamStatus = 200
  const inBand = await f.request(false)
  assert.equal(inBand.status, 400)
  assert.equal(f.diagnostics.at(-1)?.upstreamStatus, 200, '正文中的失败仍须保留真实 HTTP 状态')
  silent = true
  const timed = await f.request(false), timeout = await timed.json()
  assert.equal(timed.status, 504)
  assert.equal(timeout.error.code, 'provider_first_response_timeout')
})
