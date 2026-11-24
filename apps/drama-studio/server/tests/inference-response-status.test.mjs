import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createInferenceBroker } from '../inference-broker.mjs'

const PRIVATE = 'fixture-private-provider-detail'

async function fixture(t) {
  let response, event, payloadType, flat
  const diagnostics = []
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"保留正文"}\n\n')
      res.end(`event: ${event}\ndata: ${JSON.stringify({ ...(payloadType === null ? {} : { type: payloadType }), ...(flat ? response : { response }) })}\n\n`)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    }
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const broker = await createInferenceBroker({
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: PRIVATE,
    models: ['fixture'], defaultModel: 'fixture', apiMode: 'responses',
    onDiagnostic: row => diagnostics.push(row)
  })
  t.after(async () => {
    await broker.close()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  })
  const scope = broker.scope('fixture-account')
  return {
    diagnostics,
    async request(value, stream, eventType = 'response.' + value.status, dataType = eventType, flatPayload = false) {
      response = value
      event = eventType
      payloadType = dataType
      flat = flatPayload
      const result = await fetch(scope.base_url + '/responses', {
        method: 'POST', headers: { authorization: 'Bearer ' + scope.token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fixture', input: '受控状态回放', stream }),
        signal: AbortSignal.timeout(10000)
      })
      return { status: result.status, text: await result.text() }
    }
  }
}

test('长度上限与内容过滤保留原生未完成回执，不能误报服务故障或伪装完成', async t => {
  const f = await fixture(t)
  for (const reason of ['max_output_tokens', 'content_filter']) {
    const response = { id: 'response-fixture', object: 'response', status: 'incomplete', error: null,
      incomplete_details: { reason }, output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: '保留正文', annotations: [] }] }] }
    for (const stream of [true, false]) {
      const result = await f.request(response, stream)
      assert.equal(result.status, 200)
      if (stream) {
        assert.ok(result.text.includes('保留正文'))
        const frames = result.text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
        assert.deepEqual(frames.at(-1), { type: 'response.incomplete', response })
        assert.ok(!result.text.includes('response.completed'))
        assert.ok(!result.text.includes('event: error'))
      } else assert.deepEqual(JSON.parse(result.text), response)
    }
  }
  assert.equal(f.diagnostics.filter(row => row.event === 'studio.inference.failure').length, 0, '正常未完成状态不能计入提供商不可用')
})

test('异常或矛盾的未完成回执仍拒绝，诊断只保留允许的状态字段', async t => {
  const f = await fixture(t)
  const scenarios = [
    { response: { status: 'failed', error: { code: 'server_error', message: PRIVATE } }, code: 'provider_unavailable', reason: undefined },
    { response: { status: 'incomplete', error: null, incomplete_details: { reason: PRIVATE } }, code: 'provider_stream_incomplete', reason: undefined },
    { response: { status: 'incomplete', error: { code: 'server_error', message: PRIVATE }, incomplete_details: { reason: 'max_output_tokens' } }, code: 'provider_unavailable', reason: 'max_output_tokens' },
    { response: { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } }, event: 'response.failed', code: 'provider_unavailable', reason: 'max_output_tokens' },
    { response: { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } }, event: 'response.failed', dataType: 'response.incomplete', code: 'provider_unavailable', reason: 'max_output_tokens' },
    { response: { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } }, event: 'response.completed', dataType: 'response.incomplete', code: 'provider_unavailable', reason: 'max_output_tokens' },
    { response: { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } }, event: 'response.incomplete', dataType: null, code: 'provider_stream_incomplete', reason: 'max_output_tokens' },
    { response: { status: 'incomplete', error: null, incomplete_details: { reason: 'content_filter' } }, event: 'response.incomplete', flat: true, code: 'provider_stream_incomplete', reason: 'content_filter' }
  ]
  for (const scenario of scenarios) {
    for (const stream of scenario.event ? [true] : [true, false]) {
      const result = await f.request(scenario.response, stream, scenario.event, scenario.dataType, scenario.flat)
      assert.equal(result.status, stream ? 200 : 502)
      assert.ok(result.text.includes(scenario.code))
      assert.ok(!result.text.includes(PRIVATE))
      if (stream) assert.ok(result.text.includes('保留正文'))
      const diagnostic = f.diagnostics.at(-1)
      assert.equal(diagnostic.code, scenario.code)
      assert.equal(diagnostic.upstreamStatus, 200)
      assert.equal(diagnostic.upstreamIncompleteReason, scenario.reason)
      if (stream) assert.equal(diagnostic.upstreamEventType, scenario.event ?? 'response.' + scenario.response.status)
      assert.ok(!JSON.stringify(diagnostic).includes(PRIVATE))
    }
  }
})
