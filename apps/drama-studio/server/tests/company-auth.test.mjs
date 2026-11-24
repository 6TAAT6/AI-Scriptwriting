import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync, createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { CompanySso } from '../company-sso.mjs'
import { createStudioEdge } from '../index.mjs'
import { previewIdentityMigration } from '../identity-migration.mjs'
import { AccountStore } from '../accounts.mjs'
import { syncCompanyAccounts } from '../company-employees.mjs'

const opaque = () => randomBytes(32).toString('base64url')
const hash = value => createHash('sha256').update(value).digest('hex')
const password = 'isolated-test-password'
const managerId = '18311314-470b-471f-a907-199af477d6cb'
const oldDuId = '98697a06-648b-4dfa-be0b-2fbc0aef92fa'
function record(id, username, name, role, extra) {
  const salt = randomBytes(16)
  return { id, username, display_name: name, role, enabled: true, activated_at: '2026-10-01T00:00:00Z',
    profile: 'studio-' + id.replaceAll('-', '').slice(0, 20), version: 1, created_at: '2026-10-01T00:00:00Z',
    passwordHash: salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex'), ...extra }
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-company-'))
  const root = record(randomUUID(), 'root', '系统管理员', 'super_admin', { profile: 'jubao-drama', organization: 'unassigned', auth_source: 'local', managed_organizations: [], conversation_organizations: [] })
  const manager = record(managerId, 'legacy-manager', '横店经理', 'admin', { organization: 'hangzhou', auth_source: 'company', employee_id: '104', managed_organizations: ['chongqing'], conversation_organizations: [] })
  const oldDu = record(oldDuId, 'admin6', '杜松', 'employee', { organization: 'unassigned', auth_source: 'local', managed_organizations: [] })
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify({ version: 2, users: [root, manager, oldDu], activation_codes: [] }))
  const launches = new Map(), tickets = new Map(), sessions = new Map(), revoked = new Set(), workerRevocations = []
  const employees = new Map([['104', '横店经理'], ['9001', '新员工'], ['9002', '另一员工'], ['81', '杜松']])
  // 员工 81 的公司账号与旧本地账号 admin6 同名，用来构造“已有账号尚待身份绑定”。
  const accounts = new Map([['81', 'admin6']])
  // 能公司登录的员工都在应用授权目录里；登录触发的同步据此判断，不能用空目录。
  const companyDirectory = [...employees].map(([employeeId, name]) => ({ employeeId, name, account: accounts.get(employeeId) ?? 'company-' + employeeId, departmentId: 'd0', departmentName: '默认部门' }))
  const directoryControl = { totalOffset: 0 }
  const secret = 'fixture-company-secret-not-for-production'
  let callback, middleware
  const account = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const reject = () => { res.statusCode = 401; res.end(JSON.stringify({ ok: false })) }
    if (req.headers['x-sso-secret'] !== secret) return reject()
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const data = JSON.parse(Buffer.concat(chunks).toString())
    if (data.appId !== 'web-store-fixture-company') return reject()
    let output
    if (req.url === '/sso/launch') {
      const id = launches.get(data.code); launches.delete(data.code)
      if (!id || revoked.has(id)) return reject()
      const ticket = randomUUID().replaceAll('-', '')
      tickets.set(ticket, { id, state: data.state, challenge: data.challenge })
      output = { url: callback + '#ticket=' + ticket + '&state=' + data.state }
    } else if (req.url === '/sso/exchange') {
      const saved = tickets.get(data.ticket); tickets.delete(data.ticket)
      if (!saved || saved.state !== data.state || saved.challenge !== hash(data.verifier) || revoked.has(saved.id)) return reject()
      const session = 'jbs_' + opaque(); sessions.set(session, saved.id)
      output = { session, employeeId: saved.id, employee: { employeeId: saved.id, name: employees.get(saved.id), account: accounts.get(saved.id) ?? 'company-' + saved.id }, expiresIn: 3600 }
    } else if (req.url === '/sso/session') {
      const id = sessions.get(data.session)
      if (!id || revoked.has(id)) return reject()
      output = { employeeId: id, employee: { employeeId: id, name: employees.get(id), account: 'company-account' } }
    } else if (req.url === '/sso/employees') {
      const rows = companyDirectory.slice((data.page - 1) * data.pageSize, data.page * data.pageSize)
      output = { employees: rows, page: data.page, pageSize: data.pageSize, total: companyDirectory.length + directoryControl.totalOffset, hasMore: data.page * data.pageSize < companyDirectory.length }
    } else return reject()
    res.end(JSON.stringify({ ok: true, code: 0, data: output }))
  })
  account.listen(0, '127.0.0.1'); await once(account, 'listening')
  const runtime = createServer((_req, res) => res.end('{}'))
  const native = new WebSocketServer({ server: runtime })
  native.on('connection', socket => socket.on('message', raw => {
    const call = JSON.parse(raw)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { sessions: [] } }))
  }))
  runtime.listen(0, '127.0.0.1'); await once(runtime, 'listening')
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  callback = origin + '/auth/company/callback'
  const company = new CompanySso({ serverUrl: `http://127.0.0.1:${account.address().port}`, callbackUrl: callback, appId: 'web-store-fixture-company', secret,
    organizationByEmployee: { 104: 'hangzhou', 9001: 'hangzhou', 9002: 'hangzhou', 81: 'hangzhou' } })
  const backend = `http://127.0.0.1:${runtime.address().port}`
  const edge = await createStudioEdge({ backend, backendToken: 'fixture-runtime', repoRoot: directory, dataDir: directory, publicOrigin: origin,
    cookieName: 'fixture_company_session', identity: { enabled: true }, companySso: company,
    workerPool: { provision: async () => {}, get: async user => ({ endpoint: backend, profile: user.profile, token: 'fixture-runtime' }), revoke: async profile => { workerRevocations.push(profile) }, close: async () => {} } })
  edge.install({ middlewares: { use(handler) { middleware = handler } }, httpServer: server })
  async function request(route, { body, session, cookie, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(origin + '/studio' + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...((session?.cookie || cookie) ? { Cookie: session?.cookie || cookie } : {}), ...(session?.csrf ? { 'X-Studio-CSRF': session.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
    return { status: response.status, data, cookie: cookies.find(value => value.startsWith('fixture_company_session=') && !value.endsWith('=')) || cookies.find(value => value.includes('_company=')), csrf: data.csrfToken }
  }
  const loginCompany = id => { const code = opaque(); launches.set(code, id); return request('/auth/company/launch', { body: { code } }) }
  t.after(async () => {
    await edge.close()
    for (const socket of native.clients) socket.terminate()
    native.close()
    await Promise.all([server, account, runtime].map(value => new Promise(resolve => { value.closeAllConnections(); value.close(resolve) })))
    await rm(directory, { recursive: true, force: true })
  })
  return { request, loginCompany, edge, directory, root, manager, revoked, workerRevocations, origin, tickets, company, employees, companyDirectory, directoryControl }
}

test('公司身份、原本地创建/激活/改密、管理员全员可见和原角色权限、连接撤权', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  const root = await f.request('/auth/login', { body: { username: 'root', password } })
  const create = async (username, role = 'employee', organization = 'chongqing') => f.request('/admin/users', { session: root, body: { username, display_name: username, password, role, organization } })
  const branch = await create('branch-writer')
  assert.equal(branch.status, 201)
  const code = await f.request('/admin/activation-codes', { session: root, body: {} })
  const local = await f.request('/auth/login', { body: { username: 'branch-writer', password, activation_code: code.data.code } })
  assert.equal(local.status, 200)
  const originalProfile = local.data.user.profile
  let manager = await f.loginCompany('104')
  assert.equal(manager.status, 200)
  assert.equal(manager.data.user.id, managerId)
  assert.equal(manager.data.user.organization, 'hangzhou')
  assert.deepEqual(manager.data.user.managed_organizations, ['chongqing'])
  const hqEmployee = await f.loginCompany('9002')
  assert.equal(hqEmployee.status, 200)
  const allUsers = (await f.request('/admin/users', { session: manager })).data.users
  assert.ok(allUsers.some(user => user.id === branch.data.user.id))
  assert.ok(allUsers.some(user => user.id === hqEmployee.data.user.id))
  assert.equal((await f.request('/auth/login', { body: { username: 'legacy-manager', password } })).status, 403)
  const allowed = await f.request('/admin/users', { session: manager, body: { username: 'new-branch', display_name: '新重庆员工', password, role: 'employee', organization: 'chongqing' } })
  assert.equal(allowed.status, 201)
  assert.equal((await f.request('/admin/users', { session: manager, body: { username: 'company-through-password', display_name: '公司员工', password, role: 'employee', organization: 'hangzhou' } })).status, 400)
  assert.equal((await f.request('/admin/users', { session: manager, body: { username: 'wrong-role', display_name: '越权', password, role: 'admin', organization: 'chongqing' } })).status, 403)
  assert.equal((await f.request(`/admin/users/${managerId}`, { method: 'PATCH', session: manager, body: { managed_organizations: ['hangzhou'] } })).status, 403)
  assert.deepEqual((await f.request('/employee-conversations', { session: manager })).data.groups, [])
  assert.equal((await f.request('/employee-conversations', { session: manager, body: { employee_id: branch.data.user.id } })).status, 201)
  assert.equal((await f.request('/employee-conversations', { session: manager, body: { employee_id: hqEmployee.data.user.id } })).status, 201)
  assert.equal((await f.request(`/admin/users/${hqEmployee.data.user.id}`, { method: 'PATCH', session: manager, body: { enabled: false } })).status, 200)
  assert.equal((await f.request(`/admin/users/${hqEmployee.data.user.id}`, { method: 'PATCH', session: manager, body: { enabled: true } })).status, 200)
  assert.equal((await f.request('/admin/models', { session: manager })).status, 403)
  assert.equal((await f.request(`/admin/users/${branch.data.user.id}/password`, { session: manager, body: { password: 'changed-branch-password' } })).status, 200)
  assert.equal((await f.request('/auth/me', { session: local })).data.user, null)
  const relogin = await f.request('/auth/login', { body: { username: 'branch-writer', password: 'changed-branch-password' } })
  assert.equal(relogin.status, 200)
  assert.equal(relogin.data.user.profile, originalProfile)
  assert.equal((await f.request(`/admin/users/${managerId}`, { method: 'PATCH', session: root, body: { managed_organizations: ['hangzhou'] } })).status, 200)
  assert.equal((await f.request('/bootstrap', { session: manager })).status, 200)
  assert.equal((await f.request('/employee-conversations', { session: manager })).data.groups.length, 2)
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'employee-conversation-access.json'), 'utf8')).assignments.length, 2)
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/ws', { headers: { Origin: f.origin, Cookie: manager.cookie } })
  await once(ws, 'open')
  const replies = []
  ws.on('message', raw => replies.push(JSON.parse(raw)))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'session.list', params: {} }))
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WS reply timeout')), 2000); ws.on('message', () => { clearTimeout(timer); resolve() }) })
  assert.equal(replies[0].id, 'list')
  const revokedWorkersBefore = f.workerRevocations.length
  f.revoked.add('104')
  const closed = once(ws, 'close')
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'blocked', method: 'session.list', params: {} }))
  await closed
  assert.equal((await f.request('/bootstrap', { session: manager })).status, 401)
  assert.ok(f.workerRevocations.length > revokedWorkersBefore)
  assert.equal((await f.request('/bootstrap', { session: relogin })).status, 200)
  const saved = await readFile(path.join(f.directory, 'studio-sessions.json'), 'utf8')
  assert.ok(!saved.includes('jbs_') && !saved.includes(password))
})

test('新员工首次公司登录无需激活码直接进入工作区、浏览器事务及一次性凭证，迁移预览保持业务字段', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  const fresh = await f.loginCompany('9001')
  assert.equal(fresh.status, 200)
  assert.equal(fresh.data.user.activation_required, false)
  assert.equal((await f.request('/bootstrap', { session: fresh })).status, 200)
  assert.equal((await f.request('/auth/company/activate', { session: fresh, body: { activation_code: 'JB-UNUSED' } })).status, 400)
  const root = await f.request('/auth/login', { body: { username: 'root', password } })
  assert.equal((await f.loginCompany('9001')).data.user.id, fresh.data.user.id)
  const start = await f.request('/auth/company/start', { body: {} })
  const url = new URL(start.data.url), params = new URLSearchParams(url.hash.slice(1))
  const ticket = 'browser-' + randomUUID()
  f.tickets.set(ticket, { id: '104', challenge: params.get('challenge'), state: params.get('state') })
  assert.equal((await f.request('/auth/company/complete', { cookie: start.cookie, body: { ticket, state: 'wrong' } })).status, 401)
  const browser = await f.request('/auth/company/complete', { cookie: start.cookie, body: { ticket, state: params.get('state') } })
  assert.equal(browser.status, 200)
  assert.equal((await f.request('/auth/company/complete', { cookie: start.cookie, body: { ticket, state: params.get('state') } })).status, 401)
  assert.equal((await f.loginCompany('81')).status, 409)
  const oldProfile = f.edge.store.user(oldDuId).profile
  assert.equal((await f.request(`/admin/users/${oldDuId}`, { method: 'DELETE', session: root, body: {} })).status, 200)
  assert.equal((await f.request('/auth/login', { body: { username: 'admin6', password } })).status, 401)
  const freshDu = await f.loginCompany('81')
  assert.equal(freshDu.status, 200)
  assert.notEqual(freshDu.data.user.id, oldDuId)
  assert.notEqual(freshDu.data.user.profile, oldProfile)
  assert.equal(freshDu.data.user.activation_required, false)
  const testUsers = [
    record('d8ad984a-dad3-41ca-a1a2-2ceb65a8c764', 'test1', '测试1', 'employee'),
    record('50b60813-3e2d-4eba-9dcc-083294603ea9', 'audit_admin_1011', '长测管理员', 'admin'),
    record('cca3cc27-e330-4037-8770-9caf4f150158', 'admin2', '测试管理员', 'admin'),
    record('7b60d6ab-6dce-4730-96d5-78e5a3b90c15', 'tya', 'tya', 'employee')
  ]
  const legacy = { version: 2, users: [record(managerId, 'old-manager', '原姓名', 'admin'), record('a3b2bbd8-5946-4c00-b5d2-4e24876bf622', 'admin1', '重庆', 'admin'),
    record(oldDuId, 'admin6', '杜松', 'employee'), record('55bc4397-264f-46ee-aa87-e96603799359', 'floor-user', '楼佳伟', 'employee'), ...testUsers], activation_codes: [{ id: 'existing-code', used_by: oldDuId }] }
  const before = structuredClone(legacy), migration = previewIdentityMigration(legacy)
  assert.deepEqual(legacy, before)
  assert.equal(migration.next.users[0].organization, 'hangzhou')
  assert.deepEqual(migration.next.users[0].managed_organizations, ['chongqing'])
  assert.equal(migration.next.users[1].organization, 'chongqing')
  assert.deepEqual(migration.retired.map(user => user.id), [])
  assert.equal(migration.next.users.some(user => user.id === oldDuId), true)
  const lou = migration.next.users.find(user => user.display_name === '楼佳伟')
  assert.equal(lou.organization, 'hangzhou')
  assert.equal(lou.auth_source, 'company')
  assert.equal(lou.employee_id, '249')
  for (const original of before.users.filter(user => user.id !== oldDuId)) {
    const next = migration.next.users.find(user => user.id === original.id)
    for (const key of ['id', 'profile', 'passwordHash', 'activated_at', 'role', 'enabled']) assert.equal(next[key], original[key])
  }
  for (const original of testUsers) assert.equal(migration.next.users.find(user => user.id === original.id).auth_source, 'local')
  assert.deepEqual(migration.next.activation_codes, before.activation_codes)
  assert.deepEqual(previewIdentityMigration(migration.next).next, migration.next)
  const migratedDirectory = await mkdtemp(path.join(tmpdir(), 'studio-retained-logins-'))
  t.after(() => rm(migratedDirectory, { recursive: true, force: true }))
  await writeFile(path.join(migratedDirectory, 'accounts.json'), JSON.stringify(migration.next))
  const migratedStore = await AccountStore.open(migratedDirectory, async () => {})
  for (const original of testUsers) {
    const result = await migratedStore.login(original.username, password)
    assert.equal(result.user.role, original.role)
    assert.equal(result.user.profile, original.profile)
    if (result.user.role === 'admin') assert.ok(migratedStore.listUsers({ ...migratedStore.authenticate(result.token), token: result.token }).some(user => user.id === managerId))
  }
  assert.equal((await migratedStore.login('admin6', password)).user.id, oldDuId)
  await assert.rejects(migratedStore.login('old-manager', password), error => error.status === 403)
})

test('公司目录同步：按部门普通员工定归属自动建号（管理员不参与），首次登录实时建号，混合/新部门由管理员分配，目录删除停用保留资料，重新出现恢复', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  for (const [id, name] of [['9100', '新编剧'], ['9200', '混合部门新人'], ['9300', '重庆员工'], ['9400', '新部门员工'], ['9600', '重庆部门新人'], ['9700', '混合横店'], ['9800', '混合重庆'], ['9900', '刚建号员工']]) f.employees.set(id, name)
  const row = (employeeId, departmentId, departmentName, extra = {}) => ({ employeeId, name: f.employees.get(employeeId), account: 'company-' + employeeId, departmentId, departmentName, ...extra })
  f.companyDirectory.splice(0, f.companyDirectory.length,
    row('9002', 'd1', '编剧一部'),
    { ...row('9100', 'd1', '编剧一部'), account: '18200000000' },
    row('104', 'd2', '编剧七部'),
    row('9300', 'd2', '编剧七部', { organization: 'chongqing' }),
    row('9600', 'd2', '编剧七部'),
    row('9700', 'd3', '混合部', { organization: 'hangzhou' }),
    row('9800', 'd3', '混合部', { organization: 'chongqing' }),
    row('9200', 'd3', '混合部'),
    row('9400', 'd9', '新部门'))
  const root = await f.request('/auth/login', { body: { username: 'root', password } })
  const manager = await f.loginCompany('104')
  assert.equal((await f.loginCompany('9400')).data.error, '你的公司账号还没有分配所属公司（横店或重庆），请联系管理员在人员管理中分配后再登录。')
  const byEmployee = () => new Map(f.edge.store.listUsers().filter(user => user.auth_source === 'company').map(user => [user.employee_id, user]))
  // 9400 登录触发的同步已按部门建号：编剧一部→横店，编剧七部的横店管理员不参与推断→重庆。
  assert.equal(byEmployee().get('9100').organization, 'hangzhou')
  assert.equal(byEmployee().get('9100').username, '18200000000')
  assert.equal(byEmployee().get('9600').organization, 'chongqing')
  assert.equal(byEmployee().get('9300').organization, 'chongqing')
  assert.equal(byEmployee().get('9002').organization, 'hangzhou')
  const listed = await f.request('/admin/company-employees', { session: manager })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.data.employees.map(item => item.employee_id), ['9200', '9400'])
  assert.deepEqual(listed.data.employees[0].department_organizations, ['chongqing', 'hangzhou'])
  const writer = await f.loginCompany('9100')
  assert.equal(writer.status, 200)
  assert.equal(writer.data.user.id, byEmployee().get('9100').id)
  assert.equal(writer.data.user.activation_required, false)

  // 公司后台刚新建、还没等到定时同步的员工，首次登录当场按部门建号。
  f.companyDirectory.push(row('9900', 'd1', '编剧一部'))
  const instant = await f.loginCompany('9900')
  assert.equal(instant.status, 200)
  assert.equal(instant.data.user.organization, 'hangzhou')
  assert.equal(instant.data.user.employee_id, '9900')

  assert.equal((await f.request('/admin/company-employees', { session: manager, body: { employee_id: '9999', organization: 'hangzhou' } })).status, 404)
  assert.equal((await f.request('/admin/company-employees', { session: manager, body: { employee_id: '9200', organization: 'unassigned' } })).status, 400)
  const assigned = await f.request('/admin/company-employees', { session: manager, body: { employee_id: '9200', organization: 'chongqing' } })
  assert.equal(assigned.status, 201)
  assert.equal(assigned.data.user.organization, 'chongqing')
  assert.equal(assigned.data.user.auth_source, 'company')
  assert.equal((await f.request('/admin/company-employees', { session: manager, body: { employee_id: '9200', organization: 'chongqing' } })).status, 409)
  const mixed = await f.loginCompany('9200')
  assert.equal(mixed.status, 200)
  assert.equal(mixed.data.user.id, assigned.data.user.id)
  assert.deepEqual((await f.request('/admin/company-employees', { session: root })).data.employees.map(item => item.employee_id), ['9400'])
  assert.equal((await f.request(`/admin/users/${byEmployee().get('9100').id}`, { method: 'PATCH', session: root, body: { organization: 'chongqing' } })).status, 200)
  assert.equal((await f.request(`/admin/users/${byEmployee().get('9100').id}`, { method: 'PATCH', session: root, body: { organization: 'hangzhou' } })).status, 200)

  // 管理员手动停用的账号：目录删除只做标记，重新出现时也不自动启用。
  assert.equal((await f.request(`/admin/users/${byEmployee().get('9300').id}`, { method: 'PATCH', session: manager, body: { enabled: false } })).status, 200)
  const keep = f.companyDirectory.splice(0)
  f.companyDirectory.push(...keep.filter(item => !['9100', '9300'].includes(item.employeeId)))
  const workersBefore = f.workerRevocations.length
  const removed = await f.edge.companySync.run()
  assert.deepEqual(removed.removed.sort(), ['9100', '9300'])
  const gone = byEmployee().get('9100')
  assert.equal(gone.enabled, false)
  assert.ok(gone.company_removed_at)
  assert.equal(gone.company_sync_disabled, true)
  assert.ok(f.edge.store.user(gone.id), '停用不删除账号和工作区')
  assert.ok(f.workerRevocations.length > workersBefore)
  assert.equal(byEmployee().get('9300').company_sync_disabled, undefined)
  assert.equal((await f.request('/auth/me', { session: writer })).data.user, null)
  f.companyDirectory.splice(0, f.companyDirectory.length, ...keep)
  const restored = await f.edge.companySync.run()
  assert.deepEqual(restored.restored.sort(), ['9100', '9300'])
  assert.equal(byEmployee().get('9100').enabled, true)
  assert.equal(byEmployee().get('9100').company_removed_at, undefined)
  assert.equal(byEmployee().get('9300').enabled, false)
  assert.equal((await f.loginCompany('9100')).data.user.id, gone.id)

  // 目录条数与 total 不符时整次放弃，账号不变。
  f.directoryControl.totalOffset = 1
  f.companyDirectory.splice(1)
  assert.equal(await f.edge.companySync.run(), null)
  assert.equal(byEmployee().get('9100').enabled, true)
  assert.equal((await f.request('/admin/company-employees', { session: manager })).status, 503)
})

test('同步单次停用超过上限时只记录不停用', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-company-sync-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const users = Array.from({ length: 12 }, (_, index) => record(randomUUID(), `company-${index}`, `员工${index}`, 'employee',
    { organization: 'hangzhou', auth_source: 'company', employee_id: String(500 + index), managed_organizations: [], conversation_organizations: [] }))
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify({ version: 2, users, activation_codes: [] }))
  const store = await AccountStore.open(directory, async () => {}, undefined, { organizations: true, company: {} })
  const summary = await syncCompanyAccounts(store, [{ id: '500', name: '员工0', account: 'company-0', departmentId: 'd1' }])
  assert.equal(summary.removal_blocked, 11)
  assert.deepEqual(summary.removed, [])
  assert.ok(store.listUsers().every(user => user.enabled && !user.company_removed_at))
})

test('公司目录为空时不停用任何账号', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-company-empty-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const users = Array.from({ length: 3 }, (_, index) => record(randomUUID(), `company-${index}`, `员工${index}`, 'employee',
    { organization: 'hangzhou', auth_source: 'company', employee_id: String(600 + index), managed_organizations: [], conversation_organizations: [] }))
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify({ version: 2, users, activation_codes: [] }))
  const store = await AccountStore.open(directory, async () => {}, undefined, { organizations: true, company: {} })
  const summary = await syncCompanyAccounts(store, [])
  assert.equal(summary.removal_blocked, 3)
  assert.ok(store.listUsers().every(user => user.enabled && !user.company_removed_at))
})
