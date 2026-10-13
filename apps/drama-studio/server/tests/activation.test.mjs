import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStudioEdge } from '../index.mjs'
import { AccountStore } from '../accounts.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-activation-'))
  const edge = await createStudioEdge({ backend: 'http://127.0.0.1:1', dataDir: directory, repoRoot: directory, provisionProfile: async () => ({}) })
  await edge.seedRoot('root-fixture-password')
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(fn) { middleware = fn } }, httpServer: server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, auth, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(origin + route, { method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(auth ? { cookie: auth.cookie, 'x-studio-csrf': auth.csrfToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, ...await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] }
  }
  const root = await request('/studio/auth/login', null, { username: 'root', password: 'root-fixture-password' })
  const create = (username, role = 'employee') => request('/studio/admin/users', root, { username, display_name: username, role, password: 'fixture-password' })
  const login = (username, activation_code, password = 'fixture-password') => request('/studio/auth/login', null, { username, password, ...(activation_code === undefined ? {} : { activation_code }) })
  t.after(async () => { await edge.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return { directory, edge, root, request, create, login }
}

test('员工和普通管理员均需一次性激活，重登与改密保留激活，只有超级管理员能发码', async t => {
  const f = await fixture(t)
  const alice = (await f.create('alice')).user
  await f.create('bravo'); await f.create('manager', 'admin')
  assert.equal((await f.login('alice')).status, 403)
  assert.equal((await f.login('alice')).cookie, undefined)
  assert.equal((await f.login('manager')).status, 403)
  assert.equal((await f.login('manager')).cookie, undefined)
  const managerCode = await f.request('/studio/admin/activation-codes', f.root, {})
  assert.equal((await f.login('manager', 'wrong-code')).status, 403)
  const manager = await f.login('manager', managerCode.code)
  assert.equal(manager.status, 200)
  assert.ok(manager.user.activated_at)
  assert.equal((await f.login('manager')).status, 200)
  assert.equal((await f.login('bravo', managerCode.code)).status, 403)
  await f.request(`/studio/admin/activation-codes/${managerCode.activation_code.id}`, f.root, {}, 'DELETE')
  for (const method of ['GET', 'POST']) {
    assert.equal((await f.request('/studio/admin/activation-codes', manager, method === 'POST' ? {} : undefined)).status, 403)
    assert.equal((await f.request('/studio/admin/activation-codes', null, method === 'POST' ? {} : undefined)).status, 401)
  }
  assert.equal((await f.request('/studio/admin/activation-codes', { ...f.root, csrfToken: '' }, {})).status, 403)
  const issued = await f.request('/studio/admin/activation-codes', f.root, {})
  assert.equal(issued.status, 201)
  assert.equal((await f.login('alice', issued.code, 'wrong-password')).status, 401)
  assert.equal((await f.login('alice', 'wrong-code')).status, 403)
  const activation = await f.login('alice', issued.code.toLowerCase().replaceAll('-', ' '))
  assert.equal(activation.status, 200); assert.ok(activation.user.activated_at)
  assert.equal(activation.user.activation_required, false)
  assert.equal((await f.login('bravo', issued.code)).status, 403)
  assert.equal((await f.login('alice')).status, 200)
  assert.equal((await f.request('/studio/admin/activation-codes', activation, {})).status, 403)
  const rows = (await f.request('/studio/admin/activation-codes', f.root)).codes
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'used'); assert.equal(rows[0].used_by, alice.id)
  assert.equal(rows[0].code, issued.code)
  assert.equal(JSON.stringify(rows).includes('code_hash'), false)
  assert.equal(JSON.stringify(rows).includes('code_ciphertext'), false)
  assert.equal((await f.request(`/studio/admin/activation-codes/${rows[0].id}`, manager, {}, 'DELETE')).status, 403)
  await f.request(`/studio/admin/users/${alice.id}/password`, f.root, { password: 'changed-password' })
  const reopened = await AccountStore.open(f.directory, async () => ({}))
  const newRoot = await reopened.login('root', 'root-fixture-password')
  assert.equal(reopened.listActivationCodes({ ...reopened.authenticate(newRoot.token), token: newRoot.token })[0].code, issued.code)
  assert.equal((await reopened.login('alice', 'changed-password')).user.activation_required, false)
  assert.equal((await reopened.login('manager', 'fixture-password')).user.activation_required, false)
  await assert.rejects(reopened.login('bravo', 'fixture-password', issued.code), { status: 403 })
  assert.equal((await readFile(path.join(f.directory, 'accounts.json'), 'utf8')).includes(issued.code.replaceAll('-', '')), false)
  assert.equal((await readFile(path.join(f.directory, 'accounts.json'), 'utf8')).includes(issued.code), false)
  assert.equal((await f.request(`/studio/admin/activation-codes/${rows[0].id}`, f.root, {}, 'DELETE')).status, 200)
  assert.equal((await f.login('alice', undefined, 'changed-password')).status, 200)
  const unused = await f.request('/studio/admin/activation-codes', f.root, {})
  assert.equal((await f.request(`/studio/admin/activation-codes/${unused.activation_code.id}`, f.root, {}, 'DELETE')).status, 200)
  assert.equal((await f.login('bravo', unused.code)).status, 403)
  assert.deepEqual((await f.request('/studio/admin/activation-codes', f.root)).codes, [])
})

test('未激活的旧账号不自动豁免，两个角色并发兑换同一码只有一个成功，写入失败不消耗码', async t => {
  const f = await fixture(t)
  await f.create('alice'); await f.create('bravo', 'admin')
  const old = JSON.parse(await readFile(path.join(f.directory, 'accounts.json'), 'utf8'))
  for (const user of old.users) delete user.activated_at
  await writeFile(path.join(f.directory, 'accounts.json'), JSON.stringify({ version: 1, users: old.users }))
  const store = await AccountStore.open(f.directory, async () => ({}))
  await assert.rejects(store.login('alice', 'fixture-password'), { status: 403 })
  await assert.rejects(store.login('bravo', 'fixture-password'), { status: 403 })
  const root = await store.login('root', 'root-fixture-password')
  const auth = { ...store.authenticate(root.token), token: root.token }
  const code = (await store.generateActivationCode(auth)).code
  const file = store.file
  store.file = path.join(f.directory, 'missing', 'accounts.json')
  await assert.rejects(store.login('alice', 'fixture-password', code))
  store.file = file
  assert.equal(store.user(old.users.find(row => row.username === 'alice').id).activation_required, true)
  const results = await Promise.allSettled(['alice', 'bravo'].map(name => store.login(name, 'fixture-password', code)))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason.status === 403).length, 1)
  const winner = results.find(row => row.status === 'fulfilled').value.user
  const records = store.listActivationCodes(auth)
  assert.equal(records.find(row => row.status === 'used').used_by, winner.id)
  const otherCode = (await store.generateActivationCode(auth)).code
  await store.update(auth, winner.id, { enabled: false })
  await assert.rejects(store.login(winner.username, 'fixture-password', otherCode), { status: 401 })
  assert.equal(store.listActivationCodes(auth).filter(row => row.status === 'unused').length, 1)
})
