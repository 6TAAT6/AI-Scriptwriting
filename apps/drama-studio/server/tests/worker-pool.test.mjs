import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkerPool } from '../worker-pool.mjs'

const PROFILE = 'studio-' + 'a'.repeat(20)
const CANARY = 'fixture-parent-only-model-key-34768'
const native = { skip: !['darwin', 'linux'].includes(process.platform) ? '员工进程支持 macOS 和 Linux。' : false }
const linuxWorkerImage = 'sha256:' + 'a'.repeat(64)

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-pool-'))
  let upstreamCalls = 0
  const upstream = createServer((_req, res) => { upstreamCalls++; res.writeHead(500); res.end('本测试不应调用模型') })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const settings = () => ({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: CANARY,
    models: ['fixture-model'], defaultModel: 'fixture-model', apiMode: 'chat_completions', python: process.execPath, pythonPath: root, pythonPaths: [root] })
  return { root, settings, upstreamCalls: () => upstreamCalls }
}

test('关闭发生在设置加载期间时，不允许延迟初始化留下模型代理或启动员工进程', native, async t => {
  const f = await fixture(t)
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const brokerPort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  let releaseSettings, entered
  const started = new Promise(resolve => { entered = resolve })
  const loader = new Promise(resolve => { releaseSettings = resolve })
  const pool = new WorkerPool({ repoRoot: f.root, hermesHome: path.join(f.root, 'state'), linuxWorkerImage, settingsLoader: () => { entered(); return loader } })
  t.after(() => pool.close())
  const initializing = pool.initialize()
  const rejected = assert.rejects(initializing, /已关闭/)
  await started
  const closing = pool.close()
  releaseSettings({ ...f.settings(), port: brokerPort })
  await Promise.all([closing, rejected])
  await assert.rejects(fetch(`http://127.0.0.1:${brokerPort}/`, { signal: AbortSignal.timeout(1500) }))
  await assert.rejects(pool.initialize(), /已关闭/)
  await assert.rejects(pool.get({ id: 'alice', profile: PROFILE, role: 'employee' }), /已关闭/)
  await assert.rejects(pool.provision(PROFILE), error => error.status === 503)
  assert.equal(f.upstreamCalls(), 0)
})

test('并发初始化只建立一个父进程代理，重复关闭会收回实际监听且不会暴露上游密钥', native, async t => {
  const f = await fixture(t)
  let loads = 0
  const pool = new WorkerPool({ repoRoot: f.root, hermesHome: path.join(f.root, 'state'), linuxWorkerImage, settingsLoader: async () => { loads++; return f.settings() } })
  t.after(() => pool.close())
  await Promise.all([pool.initialize(), pool.initialize(), pool.initialize()])
  assert.equal(loads, 1)
  const scoped = pool.broker.scope(PROFILE)
  assert.ok(!JSON.stringify(scoped).includes(CANARY))
  const response = await fetch(scoped.base_url + '/models', { headers: { authorization: 'Bearer ' + scoped.token }, signal: AbortSignal.timeout(1500) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data.map(model => model.id), ['fixture-model'])
  await Promise.all([pool.close(), pool.close()])
  await pool.close()
  await assert.rejects(fetch(scoped.base_url + '/models', { headers: { authorization: 'Bearer ' + scoped.token }, signal: AbortSignal.timeout(1500) }))
  await assert.rejects(pool.initialize(), /已关闭/)
  assert.equal(f.upstreamCalls(), 0)
})
