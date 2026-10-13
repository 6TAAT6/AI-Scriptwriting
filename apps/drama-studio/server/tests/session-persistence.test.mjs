import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AccountStore } from '../accounts.mjs'
import { createStudioEdge } from '../index.mjs'

test('HTTP 登录跨过十二小时仍有效，重启保留七天固定期限且到期不能恢复', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-session-lifetime-'))
  const dataDir = path.join(root, 'state')
  const edge = await createStudioEdge({ repoRoot: root, dataDir, backend: 'http://127.0.0.1:1', provisionProfile: async () => {} })
  let middleware
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  edge.install({ middlewares: { use(handler) { middleware = handler } }, httpServer: server })
  t.after(async () => {
    await edge.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  await edge.seedRoot('root-test-password')
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const issuedAt = Date.now()
  let currentTime = issuedAt
  t.mock.method(Date, 'now', () => currentTime)
  const response = await fetch(`${origin}/studio/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'root-test-password' })
  })
  assert.equal(response.status, 200)
  const login = await response.json()
  const cookieHeader = response.headers.get('set-cookie')
  const cookie = cookieHeader.split(';')[0]
  const token = cookie.slice(cookie.indexOf('=') + 1)
  const cookieLifetime = Number(cookieHeader.match(/; Max-Age=(\d+)/)[1]) * 1000
  const issued = edge.store.authenticate(token)
  assert.equal(issued.expires, issuedAt + cookieLifetime)
  assert.equal(login.expiresAt, issued.expires)

  currentTime = issuedAt + 13 * 60 * 60 * 1000
  const later = await fetch(`${origin}/studio/auth/me`, { headers: { cookie } })
  assert.equal(later.status, 200)
  const current = await later.json()
  assert.equal(current.user?.id, login.user.id, '登录十三小时后应保持登录')
  assert.equal(current.expiresAt, issued.expires)
  assert.equal(later.headers.get('set-cookie'), null)
  assert.equal(edge.store.authenticate(token).expires, issued.expires)
  await edge.close()

  currentTime = issuedAt + 7 * 24 * 60 * 60 * 1000 - 1
  const reopened = await AccountStore.open(dataDir, async () => {})
  const restored = reopened.authenticate(token)
  assert.ok(restored, '七天期限届满前应恢复有效登录')
  assert.equal(restored.expires, issued.expires)
  assert.equal(restored.expires, currentTime + 1)

  currentTime += 1
  assert.equal(reopened.authenticate(token), null, '七天期限届满时应要求重新登录')
  const reopenedExpired = await AccountStore.open(dataDir, async () => {})
  assert.equal(reopenedExpired.authenticate(token), null, '重启不能恢复或延长过期登录')
})

test('服务重启后恢复未过期会话并重新生成 CSRF，不落盘明文 token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-session-persistence-'))
  try {
    const dataDir = path.join(root, 'state')
    const store = await AccountStore.open(dataDir, async () => {})
    await store.seedRoot('root-test-password')
    const login = await store.login('root', 'root-test-password')
    const before = store.authenticate(login.token)
    assert.ok(before)

    const sessionPath = path.join(dataDir, 'studio-sessions.json')
    const saved = await readFile(sessionPath, 'utf8')
    assert.match(saved, /"sessions"/)
    assert.ok(!saved.includes(login.token))
    assert.ok(!saved.includes(login.csrfToken))
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600)

    const reopened = await AccountStore.open(dataDir, async () => {})
    const after = reopened.authenticate(login.token)
    assert.ok(after)
    assert.equal(after.user.id, before.user.id)
    assert.equal(after.version, before.version)
    assert.notEqual(after.csrfToken, before.csrfToken)
    assert.notEqual(after.csrfToken, login.csrfToken)

    await reopened.logout(login.token)
    const reopenedAgain = await AccountStore.open(dataDir, async () => {})
    assert.equal(reopenedAgain.authenticate(login.token), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('账号撤销会持久化，重启后不能恢复被撤销账号会话', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-session-revoke-'))
  try {
    const dataDir = path.join(root, 'state')
    const store = await AccountStore.open(dataDir, async () => {})
    await store.seedRoot('root-test-password')
    const login = await store.login('root', 'root-test-password')
    const auth = { ...store.authenticate(login.token), token: login.token }

    await store.setPassword(auth, auth.user.id, 'new-root-password')
    assert.equal(store.authenticate(login.token), null)

    const reopened = await AccountStore.open(dataDir, async () => {})
    assert.equal(reopened.authenticate(login.token), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
