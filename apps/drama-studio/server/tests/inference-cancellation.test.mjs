import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { createInferenceBroker } from '../inference-broker.mjs'

test('十个流式响应写入受阻后同时断开，全部名额可供下一批十个并发请求复用', async t => {
  // 共享验收主机需要调度十条大帧；护栏用于终止挂死，不把机器吞吐当业务时限。
  const waitMs = 30_000, started = Date.now()
  const parallelism = 10, beginLargeFrames = Promise.withResolvers(), resumed = Promise.withResolvers()
  let resumedCount = 0
  const chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '稿'.repeat(2_400_000) } }] }) + '\n\n'
  const upstream = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts))
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n')
      await beginLargeFrames.promise
      res.end(chunk + 'data: [DONE]\n\n')
    } else {
      resumedCount++
      if (resumedCount === parallelism) resumed.resolve()
      await resumed.promise
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: `后续请求 ${body.metadata.sequence} 已完成` } }] }))
    }
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const broker = await createInferenceBroker({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'fixture-only-key', models: ['writer'], defaultModel: 'writer', apiMode: 'chat_completions' })
  t.after(async () => { beginLargeFrames.resolve(); resumed.resolve(); await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  const scope = broker.scope('slow-reader')
  const headers = { authorization: 'Bearer ' + scope.token, 'content-type': 'application/json' }
  const pauseDuringWrite = () => new Promise((resolve, reject) => {
    const request = httpRequest(scope.base_url + '/chat/completions', { method: 'POST', headers }, response => {
      assert.equal(response.statusCode, 200)
      // 连接开始的超时不能继续计入故意暂停读取的大帧阶段。
      request.setTimeout(0)
      response.once('error', reject)
      response.once('data', () => { response.pause(); resolve(response) })
    })
    t.after(() => request.destroy())
    request.once('error', reject)
    request.setTimeout(waitMs, () => request.destroy(new Error('测试流未按时开始')))
    request.end(JSON.stringify({ model: 'writer', messages: [], stream: true }))
  })
  const streams = await Promise.all(Array.from({ length: parallelism }, pauseDuringWrite))
  t.diagnostic(`十条响应已就绪：${Date.now() - started} ms；单阶段等待护栏 ${waitMs} ms。`)
  const backpressured = streams.map(response => once(response, 'readable', { signal: AbortSignal.timeout(waitMs) }))
  beginLargeFrames.resolve()
  await Promise.all(backpressured)
  t.diagnostic(`十条暂停响应均收到大帧：${Date.now() - started} ms。`)
  assert.ok(streams.every(response => response.readableLength > 0), '每条暂停响应都须实际收到大帧，不能在背压发生前取消')
  const disconnected = streams.map(response => once(response, 'close'))
  for (const response of streams) response.destroy()
  await Promise.all(disconnected)
  const outputs = await Promise.all(Array.from({ length: parallelism }, async (_, sequence) => {
    const response = await fetch(scope.base_url + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify({ model: 'writer', messages: [], metadata: { sequence } }), signal: AbortSignal.timeout(waitMs)
    })
    assert.equal(response.status, 200)
    return (await response.json()).choices[0].message.content
  }))
  assert.equal(resumedCount, parallelism, '上游须同时收到下一批全部请求，不能只回收部分名额')
  assert.deepEqual(outputs, Array.from({ length: parallelism }, (_, sequence) => `后续请求 ${sequence} 已完成`))
})
