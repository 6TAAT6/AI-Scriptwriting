import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { AccountStore } from '../accounts.mjs'

test('账号密码允许最低 6 个字符，并继续拒绝 5 个字符', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-password-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await AccountStore.open(path.join(root, 'state'), async () => {}, async () => {})
  await store.seedRoot('root-test-password')
  const login = await store.login('root', 'root-test-password')
  const auth = { ...store.authenticate(login.token), token: login.token }
  const created = await store.create(auth, { username: 'sixchar', display_name: '六位密码', password: '123456', role: 'employee' })
  assert.equal(created.username, 'sixchar')
  await assert.rejects(() => store.create(auth, { username: 'fivechar', display_name: '五位密码', password: '12345', role: 'employee' }), error => error.status === 400 && /密码长度应为 6 至 256 个字符/.test(error.message))
})
