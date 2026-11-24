import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { AccountStore } from '../accounts.mjs'

test('新建、管理员重置和自助修改接受六位混合密码并拒绝五位密码', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-password-policy-extra-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await AccountStore.open(path.join(root, 'state'), async () => {}, async () => {})
  await store.seedRoot('root-test-password')
  const rootLogin = await store.login('root', 'root-test-password')
  const rootAuth = { ...store.authenticate(rootLogin.token), token: rootLogin.token }

  const created = await store.create(rootAuth, {
    username: 'mixedpass', display_name: '混合密码', password: 'a1!@#$', role: 'employee'
  })
  assert.equal(created.username, 'mixedpass')

  await store.setPassword(rootAuth, created.id, 'a1!xyz')
  const activationCode = (await store.generateActivationCode(rootAuth)).code
  assert.ok((await store.login('mixedpass', 'a1!xyz', activationCode)).token)
  await assert.rejects(() => store.setPassword(rootAuth, created.id, '12345'), error => error.status === 400)

  const employeeLogin = await store.login('mixedpass', 'a1!xyz', (await store.generateActivationCode(rootAuth)).code)
  const employeeAuth = { ...store.authenticate(employeeLogin.token), token: employeeLogin.token }
  await store.setPassword(employeeAuth, created.id, 'Z9$abc', 'a1!xyz')
  assert.ok((await store.login('mixedpass', 'Z9$abc')).token)
  await assert.rejects(() => store.setPassword(employeeAuth, created.id, '12345', 'Z9$abc'), error => error.status === 400)
})
