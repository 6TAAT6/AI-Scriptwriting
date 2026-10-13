import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { AccountStore } from '../accounts.mjs'
import { EmployeeAccess } from '../employee-access.mjs'

test('管理员可以持久化指定员工查看授权，员工账号和其他管理员不能作为查看目标', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-employee-access-'))
  const store = await AccountStore.open(path.join(root, 'state'), async () => {})
  await store.seedRoot('root-test-password')
  const rootLogin = await store.login('root', 'root-test-password')
  const rootAuth = { ...store.authenticate(rootLogin.token), token: rootLogin.token }
  const employee = await store.create(rootAuth, { username: 'writer', display_name: '编剧甲', password: 'writer-test-password', role: 'employee' })
  const admin = await store.create(rootAuth, { username: 'manager', display_name: '组长', password: 'manager-test-password', role: 'admin' })
  const managerCode = await store.generateActivationCode(rootAuth)
  const managerLogin = await store.login('manager', 'manager-test-password', managerCode.code)
  const managerAuth = { ...store.authenticate(managerLogin.token), token: managerLogin.token }
  const service = {
    async fetch(route, user) {
      assert.equal(user.id, employee.id)
      if (route === '/api/sessions') return Response.json({ sessions: [{ id: 'chat-1', title: '第一场', preview: '你好', started_at: 1, message_count: 2 }] })
      return Response.json({ messages: [{ role: 'user', row_id: 'm1', text: '员工消息' }] })
    },
    async session(user, id) { assert.equal(user.id, employee.id); assert.equal(id, 'chat-1') },
    presentation: { async messages(_user, messages) { return messages }, async messagesAs(_viewer, _source, messages) { return messages } }
  }
  const access = await EmployeeAccess.open(path.join(root, 'state'), store, service)

  const assignment = await access.add(managerAuth, employee.id)
  assert.equal(assignment.employee.id, employee.id)
  assert.equal(access.list(managerAuth).length, 1)
  assert.equal(access.canView(managerAuth, employee.id), true)
  assert.deepEqual(await access.sessions(managerAuth.user, employee), [{ id: 'chat-1', title: '第一场', preview: '你好', started_at: 1, message_count: 2, archived: false }])
  const call = async (auth, method, url, body) => {
    const output = { statusCode: 200, headers: {}, text: '' }
    const response = { setHeader(key, value) { output.headers[key] = value }, end(value = '') { output.text = value } }
    await access.handle({ method }, response, new URL(url, 'http://test'), auth, body, service)
    return { ...output, data: output.text ? JSON.parse(output.text) : null }
  }
  assert.equal((await call(managerAuth, 'GET', '/studio/employee-conversations')).data.groups[0].sessions[0].id, 'chat-1')
  assert.deepEqual((await call(managerAuth, 'GET', `/studio/employee-conversations/${employee.id}/sessions/chat-1/messages`)).data.messages[0].text, '员工消息')
  await assert.rejects(() => access.add(managerAuth, admin.id), error => error.status === 404)

  const reopened = await EmployeeAccess.open(path.join(root, 'state'), store, service)
  assert.equal(reopened.list(managerAuth).length, 1)
  await reopened.remove(managerAuth, assignment.id)
  assert.equal(reopened.list(managerAuth).length, 0)
  await t.test('普通员工没有授权管理能力', async () => {
    const employeeCode = await store.generateActivationCode(rootAuth)
    const login = await store.login('writer', 'writer-test-password', employeeCode.code)
    const auth = { ...store.authenticate(login.token), token: login.token }
    assert.throws(() => reopened.list(auth), error => error.status === 403)
    await assert.rejects(() => reopened.handle({ method: 'GET' }, { setHeader() {}, end() {} }, new URL('http://test/studio/employee-conversations'), auth, undefined, service), error => error.status === 403)
  })
  await store.logout(rootLogin.token)
  await store.logout(managerLogin.token)
  await rm(root, { recursive: true, force: true })
})

test('员工停用后不再列入可查看对话，也不触发其工作区读取', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-employee-access-disabled-'))
  const store = await AccountStore.open(path.join(root, 'state'), async () => {})
  await store.seedRoot('root-test-password')
  const rootLogin = await store.login('root', 'root-test-password')
  const rootAuth = { ...store.authenticate(rootLogin.token), token: rootLogin.token }
  const employee = await store.create(rootAuth, { username: 'writer', display_name: '编剧甲', password: 'writer-test-password', role: 'employee' })
  const admin = await store.create(rootAuth, { username: 'manager', display_name: '组长', password: 'manager-test-password', role: 'admin' })
  const managerCode = await store.generateActivationCode(rootAuth)
  const managerLogin = await store.login('manager', 'manager-test-password', managerCode.code)
  const managerAuth = { ...store.authenticate(managerLogin.token), token: managerLogin.token }
  let reads = 0
  const service = {
    async fetch() { reads++; return Response.json({ sessions: [{ id: 'chat-1', title: '第一场' }] }) },
    presentation: { async messagesAs(_viewer, _source, messages) { return messages } }
  }
  const access = await EmployeeAccess.open(path.join(root, 'state'), store, service)
  await access.add(managerAuth, employee.id)
  await store.update(rootAuth, employee.id, { enabled: false })

  const output = { statusCode: 200, headers: {}, text: '' }
  const response = { setHeader(key, value) { output.headers[key] = value }, end(value = '') { output.text = value } }
  await access.handle({ method: 'GET' }, response, new URL('http://test/studio/employee-conversations'), managerAuth, undefined, service)
  assert.deepEqual(JSON.parse(output.text).groups, [])
  assert.equal(reads, 0)
  await store.update(rootAuth, employee.id, { enabled: true })
  assert.equal(access.list(managerAuth).length, 1)
  await t.after(() => rm(root, { recursive: true, force: true }))
})
