/** Isolated demonstration: synthetic accounts and the existing UI fixture; never calls a model provider. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AccountStore } from '../server/accounts.mjs'
import { startStudioServer } from '../server/serve.mjs'

const app = fileURLToPath(new URL('..', import.meta.url)), repo = path.resolve(app, '../..')
const directory = path.join(repo, '.cache/company-preview'), home = path.join(directory, 'state'), dataDir = path.join(home, 'studio')
const origin = 'http://192.168.10.36:10669', accountOrigin = 'http://192.168.10.36:10670'
const callback = origin + '/auth/company/callback', appId = 'web-store-isolated-company-preview'
const secret = randomBytes(32).toString('hex'), password = 'isolated-preview-password'
const provision = profile => mkdir(path.join(home, 'studio-workers', profile, 'workspace'), { recursive: true })
await mkdir(directory, { recursive: true })
const store = await AccountStore.open(dataDir, provision, undefined, { organizations: true })
await store.seedRoot(password)
const rootLogin = await store.login('root', password), auth = { ...store.authenticate(rootLogin.token), token: rootLogin.token }
if (!store.listUsers().some(user => user.username === 'branch-admin')) {
  for (const [username, display_name, role] of [['branch-admin', '重庆管理员示例', 'admin'], ['branch-writer', '重庆员工示例', 'employee']]) {
    await store.create(auth, { username, display_name, role, password, organization: 'chongqing' })
    await store.login(username, password, (await store.generateActivationCode(auth)).code)
  }
  const saved = JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8'))
  const template = saved.users.find(user => user.username === 'branch-admin')
  saved.users.push({ ...template, id: '18311314-470b-471f-a907-199af477d6cb', username: 'company-preview-manager', display_name: '李茂申（隔离示例）',
    profile: 'studio-isolated-hq-manager', organization: 'hangzhou', auth_source: 'company', employee_id: '104', managed_organizations: ['chongqing'], conversation_organizations: [] })
  await writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify(saved), { mode: 0o600 })
}
const previewAccounts = JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8'))
if (!previewAccounts.users.some(user => user.employee_id === '9002')) {
  const template = previewAccounts.users.find(user => user.username === 'branch-writer')
  previewAccounts.users.push({ ...template, id: randomUUID(), username: 'company-preview-writer', display_name: '横店员工示例',
    profile: 'studio-isolated-hq-writer', organization: 'hangzhou', auth_source: 'company', employee_id: '9002', managed_organizations: [] })
  await writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify(previewAccounts), { mode: 0o600 })
}
await store.revoke(null)
await writeFile(path.join(directory, 'test-accounts.json'), JSON.stringify({ username: 'root', branchAdmin: 'branch-admin', branchEmployee: 'branch-writer', password }), { mode: 0o600 })

// Reuse the product's existing UI protocol fixture, with its model directory initialized for the current model-branding contract.
let runtime = await readFile(path.join(app, 'scripts/fixture-server.mjs'), 'utf8')
runtime = runtime.replace("server.listen(10621, '127.0.0.1'", "server.listen(10671, '127.0.0.1'")
runtime = runtime.replaceAll('test-model', 'gpt-6.1-sol')
runtime = runtime.replace("if (url.pathname === '/fixture/receipts')", "if (url.pathname === '/api/studio/model-endpoints') { json(res, { endpoints: [{ id: 'fixture', name: '隔离演示模型', is_current: true, models: ['gpt-6.1-sol'] }] }); return }\n  if (url.pathname === '/fixture/receipts')")
runtime = runtime.replace("slug: 'fixture', name: '隔离验收'", "slug: params.profile === 'jubao-drama' ? 'fixture' : 'studio-inference', name: '隔离验收'")
runtime += '\nexport { server, ws };\n'
await writeFile(path.join(directory, 'runtime.mjs'), runtime)
const fixture = await import(pathToFileURL(path.join(directory, 'runtime.mjs')).href)

const tickets = new Map(), sessions = new Map(), people = new Map([['104', '李茂申（隔离示例）'], ['9001', '横店新员工示例'], ['9002', '横店员工示例'], ['81', '杜松']])
const account = createServer(async (req, res) => {
  const url = new URL(req.url, accountOrigin)
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  if (url.pathname === '/sso/login.html' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>隔离公司登录演示</title><body><h1>隔离公司登录演示</h1><p>仅使用测试数据，不连接真实公司账号。</p><form><label>测试身份<select name="employee"><option value="104">横店经理：负责重庆</option><option value="9001">横店新员工：首次激活</option><option value="9002">横店普通员工</option><option value="81">杜松：重新创建账号</option></select></label><button>进入测试账号</button></form><script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const params=new URLSearchParams(location.hash.slice(1));const response=await fetch('/fixture/ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee:document.querySelector('select').value,challenge:params.get('challenge'),state:params.get('state'),appId:params.get('appId')})});const data=await response.json();location.assign(data.url)}</script></body></html>`); return
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { json(400, { ok: false }); return }
  if (url.pathname === '/fixture/ticket' && req.headers.origin === accountOrigin && body.appId === appId && people.has(body.employee) && /^[a-f0-9]{64}$/.test(body.challenge) && /^[A-Za-z0-9_-]{43}$/.test(body.state)) {
    const ticket = randomUUID(); tickets.set(ticket, { id: body.employee, state: body.state, challenge: body.challenge, expires: Date.now() + 60000 })
    json(200, { url: callback + '#' + new URLSearchParams({ ticket, state: body.state }) }); return
  }
  if (req.headers['x-sso-secret'] !== secret || body.appId !== appId) { json(401, { ok: false }); return }
  if (url.pathname === '/sso/exchange') {
    const ticket = tickets.get(body.ticket); tickets.delete(body.ticket)
    if (!ticket || ticket.expires < Date.now() || ticket.state !== body.state || ticket.challenge !== createHash('sha256').update(body.verifier || '').digest('hex')) { json(401, { ok: false }); return }
    const session = 'jbs_' + randomBytes(32).toString('base64url'); sessions.set(session, ticket.id)
    json(200, { ok: true, data: { session, employeeId: ticket.id, employee: { employeeId: ticket.id, name: people.get(ticket.id), account: 'preview_' + ticket.id }, expiresIn: 3600 } }); return
  }
  if (url.pathname === '/sso/session' && sessions.has(body.session)) {
    const id = sessions.get(body.session)
    json(200, { ok: true, data: { employeeId: id, employee: { employeeId: id, name: people.get(id), account: 'preview_' + id } } }); return
  }
  json(401, { ok: false })
})
account.listen(10670, '0.0.0.0'); await once(account, 'listening')
const previewApp = path.join(directory, 'app')
await cp(path.join(app, 'dist'), path.join(previewApp, 'dist'), { recursive: true, force: true })
const index = path.join(previewApp, 'dist/index.html')
await writeFile(index, (await readFile(index, 'utf8')).replace(/<title>.*?<\/title>/, '<title>智能体公司接入 · 隔离测试</title>'))
const backend = 'http://127.0.0.1:10671'
const service = await startStudioServer({ repoRoot: repo, appRoot: previewApp, hermesHome: home, dataDir, host: '0.0.0.0', port: 10669, publicOrigin: origin,
  cookieName: 'jubao_company_isolated_preview', backend, backendToken: 'studio-ui-fixture',
  workerPool: { provision, get: async user => ({ endpoint: backend, profile: user.profile, token: 'studio-ui-fixture' }), homeFor: user => path.join(home, 'studio-workers', user.profile), revoke: async () => {}, close: async () => {} },
  identity: { enabled: true, company: { appId, serverUrl: accountOrigin, callbackUrl: callback, secret } } })
console.log('Isolated preview: ' + origin + '; account fixtures: ' + accountOrigin + '; no production accounts or model calls.')
const close = async () => {
  await service.close(); account.closeAllConnections(); account.close()
  for (const client of fixture.ws.clients) client.terminate()
  fixture.ws.close(); fixture.server.close(); process.exit(0)
}
process.once('SIGTERM', () => { void close() }); process.once('SIGINT', () => { void close() })
