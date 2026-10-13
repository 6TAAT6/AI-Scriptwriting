import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { AccountStore } from '../accounts.mjs'

test('超级管理员删除账号会撤销登录、持久化移除并清理独立 profile，不能删除 root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-account-delete-'))
  const removed = []
  const store = await AccountStore.open(path.join(root, 'state'), async () => {}, async profile => { removed.push(profile) })
  await store.seedRoot('root-test-password')
  const rootLogin = await store.login('root', 'root-test-password')
  const rootAuth = { ...store.authenticate(rootLogin.token), token: rootLogin.token }
  const rootUser = rootAuth.user
  const employee = await store.create(rootAuth, { username: 'writer', display_name: '编剧甲', password: 'writer-test-password', role: 'employee' })
  const employeeLogin = await store.login('writer', 'writer-test-password', (await store.generateActivationCode(rootAuth)).code)
  const employeeAuth = { ...store.authenticate(employeeLogin.token), token: employeeLogin.token }

  await assert.rejects(() => store.delete(rootAuth, rootUser.id), error => error.status === 400)
  assert.deepEqual((await store.delete(rootAuth, employee.id)).deleted, employee.id)
  assert.equal(store.listUsers().some(user => user.id === employee.id), false)
  assert.equal(store.authenticate(employeeLogin.token), null)
  assert.deepEqual(removed, [employee.profile])
  await assert.rejects(() => store.delete(employeeAuth, employee.id), error => error.status === 401)
  await store.logout(rootLogin.token)
  await rm(root, { recursive: true, force: true })
})
