import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkerPool } from '../worker-pool.mjs'
import { createStudioEdge } from '../index.mjs'

const native = { skip: !['darwin', 'linux'].includes(process.platform) ? '此验收验证真实 macOS 或 Linux 员工进程生命周期。' : false }
const pause = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, settingsLoader) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-revoke-'))
  let calls = 0, entered, release
  const held = new Promise(resolve => { entered = resolve })
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const data = JSON.parse(Buffer.concat(chunks)); calls++
    if (data.metadata?.hold) { entered(); await new Promise(resolve => { release = resolve }) }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '假模型回执' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const launcher = path.join(root, 'worker-fixture.mjs')
  await writeFile(launcher, `#!${process.execPath}
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
let text = ''; for await (const chunk of process.stdin) text += chunk
const options = JSON.parse(text)
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
await once(child.stdout, 'data')
while (existsSync(options.repoRoot + '/hold-start')) await new Promise(resolve => setTimeout(resolve, 10))
const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ service: 'studio-runtime', descendant: child.pid })) })
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`, { mode: 0o700 })
  await mkdir(path.join(root, 'scripts'))
  await writeFile(path.join(root, 'scripts/run-in-hermes-env'), `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';let value='';for await(const chunk of process.stdin)value+=chunk;JSON.parse(value);if(existsSync('hold-refresh')){writeFileSync('refresh-entered','');while(existsSync('hold-refresh'))await new Promise(resolve=>setTimeout(resolve,10))}console.log('{}');`, { mode: 0o700 })
  const settings = () => ({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'FAKE_PARENT_ONLY_KEY', models: ['fake-model'], defaultModel: 'fake-model', apiMode: 'chat_completions', python: launcher, pythonPath: root, pythonPaths: [root] })
  const pool = new WorkerPool({ repoRoot: root, hermesHome: path.join(root, 'state'), linuxWorkerImage: 'sha256:' + 'a'.repeat(64), settingsLoader: settingsLoader ? () => settingsLoader(settings()) : settings })
  const edge = await createStudioEdge({ repoRoot: root, hermesHome: pool.home, dataDir: path.join(root, 'accounts'), backend: `http://127.0.0.1:${upstream.address().port}`, backendToken: 'fixture-backend-token', workerPool: pool,
    provisionProfile: async profile => { const home = path.join(pool.home, 'studio-workers', profile); await mkdir(path.join(home, 'workspace'), { recursive: true, mode: 0o700 }); return { profile, home } } })
  t.after(async () => { release?.(); await edge.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const request = async (scope, hold = false) => {
    const response = await fetch(scope.base_url + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + scope.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-model', messages: [], ...(hold ? { metadata: { hold: true } } : {}) }), signal: AbortSignal.timeout(5000) })
    await response.text(); return response.status
  }
  await edge.seedRoot('root-fixture-password')
  const login = await edge.store.login('root', 'root-fixture-password')
  const admin = { ...edge.store.authenticate(login.token), token: login.token }
  const create = username => edge.store.create(admin, { username, display_name: username, role: 'employee', password: `${username}-fixture-password` })
  return { root, pool, edge, admin, create, request, held, release: () => release?.(), calls: () => calls }
}

test('停用改密和角色变更立即撤销单账号scope并停止工作进程，退出登录保留后台创作', native, async t => {
  const f = await fixture(t), alice = await f.create('alice'), bravo = await f.create('bravo')
  const workerA = await f.pool.get(alice), workerB = await f.pool.get(bravo)
  const descendant = (await (await fetch(workerA.endpoint)).json()).descendant
  const scopeA = f.pool.broker.scope(alice.profile), scopeB = f.pool.broker.scope(bravo.profile)
  const logged = await f.edge.store.login('alice', 'alice-fixture-password', await fixtureActivationCode(f.edge.store, 'alice', 'root-fixture-password'))
  await f.edge.store.logout(logged.token)
  assert.equal((await fetch(workerA.endpoint)).status, 200)
  assert.equal(await f.request(scopeA), 200)
  const running = f.request(scopeA, true); await f.held
  await f.edge.store.update(f.admin, alice.id, { enabled: false })
  assert.equal(await f.request(scopeA), 401)
  assert.ok((await running) >= 400)
  await f.pool.revoke(alice.profile)
  const stoppedBy = Date.now() + 2000
  while (Date.now() < stoppedBy) {
    try { process.kill(descendant, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
    await pause()
  }
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  await assert.rejects(fetch(workerA.endpoint, { signal: AbortSignal.timeout(1500) }))
  assert.equal(await f.request(scopeB), 200)
  assert.equal((await fetch(workerB.endpoint)).status, 200)
  const calls = f.calls(); assert.equal(await f.request(scopeA), 401); assert.equal(f.calls(), calls)
  await f.edge.store.update(f.admin, alice.id, { enabled: true })
  for (const mutate of [() => f.edge.store.setPassword(f.admin, alice.id, 'alice-updated-password'), () => f.edge.store.update(f.admin, alice.id, { role: 'admin' })]) {
    const worker = await f.pool.get(f.edge.store.user(alice.id)), scope = f.pool.broker.scope(alice.profile)
    assert.notEqual(worker.token, workerA.token); assert.notEqual(scope.token, scopeA.token)
    await mutate()
    assert.equal(await f.request(scope), 401)
    await Promise.all([f.pool.revoke(alice.profile), f.pool.revoke(alice.profile)])
    await assert.rejects(fetch(worker.endpoint, { signal: AbortSignal.timeout(1500) }))
    assert.equal(await f.request(scopeB), 200)
  }
  f.release()
})

test('初始化和启动期间的账号撤销使旧generation失效，新登录等待清理后独立启动且关闭可并发', native, async t => {
  let entered, release
  const loading = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, async settings => { entered(); await gate; return settings })
  const alice = await f.create('alice')
  const stale = f.pool.get(alice), rejected = assert.rejects(stale, /撤销|变化/)
  await loading
  const revoking = f.pool.revoke(alice.profile)
  const fresh = f.pool.get(alice)
  release()
  await Promise.all([rejected, revoking])
  const worker = await fresh, scope = f.pool.broker.scope(alice.profile)
  assert.equal((await fetch(worker.endpoint)).status, 200)
  assert.equal(await f.request(scope), 200)
  await f.pool.revoke(alice.profile)
  await writeFile(path.join(f.root, 'hold-refresh'), '')
  const refreshing = f.pool.get(alice), refreshRejected = assert.rejects(refreshing, /撤销/)
  const refreshedBy = Date.now() + 5000
  const { existsSync } = await import('node:fs')
  while (!existsSync(path.join(f.root, 'refresh-entered')) && Date.now() < refreshedBy) await pause()
  assert.ok(existsSync(path.join(f.root, 'refresh-entered')))
  const staleScope = f.pool.broker.scope(alice.profile)
  const refreshCleanup = f.pool.revoke(alice.profile)
  assert.equal(await f.request(staleScope), 401)
  await rm(path.join(f.root, 'hold-refresh'))
  await Promise.all([refreshCleanup, refreshRejected])
  await writeFile(path.join(f.root, 'hold-start'), '')
  const starting = f.pool.get(alice)
  const startupRejected = assert.rejects(starting, /撤销|已关闭|隔离|无法启动/)
  const spawnedBy = Date.now() + 5000
  while (!f.pool.startingChildren.has(alice.profile) && Date.now() < spawnedBy) await pause()
  assert.ok(f.pool.startingChildren.has(alice.profile))
  const cleanup = f.pool.revoke(alice.profile)
  await Promise.all([cleanup, f.pool.close(), startupRejected])
  await f.pool.close()
  assert.equal(await f.request(scope).catch(() => 401), 401)
  await assert.rejects(f.pool.get(alice), /已关闭/)
})
