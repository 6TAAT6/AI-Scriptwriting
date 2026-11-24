import { timingSafeEqual } from 'node:crypto'
import { forwardBody } from './response-forwarding.mjs'
import path from 'node:path'
import { AccountStore, SESSION_TTL, StudioError, fail } from './accounts.mjs'
import { StudioBackend } from './backend.mjs'
import { profileProvisioner } from './provision.mjs'
import { createSocketBridge } from './socket.mjs'
import { createSidebarService } from './sidebar.mjs'
import { isEmployee } from './file-handles.mjs'
import { createModelSettingsService } from './model-settings.mjs'
import { createEmployeeAccess } from './employee-access.mjs'
import { rm } from 'node:fs/promises'
import { createOriginPolicy } from './origin-policy.mjs'
import { sessionDocuments } from './session-documents.mjs'
import { creativeMemory, editCreativeMemory } from './creative-memory.mjs'
import { ModelDisplayNames, createModelDisplayNamesService } from './model-display-names.mjs'
import { createMaintenance } from './maintenance.mjs'
import { CompanySso } from './company-sso.mjs'
import { handleCompanyEmployees, startCompanySync } from './company-employees.mjs'

// 登录 Cookie 名按部署配置区分：同一台机器上的几套环境端口不同，但浏览器按主机共用 Cookie，名字相同会互相顶掉登录。
const DEFAULT_COOKIE = 'drama_studio_refactor_session'
function readCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';').map(value => value.trim())
  const value = cookies.find(value => value.startsWith(name + '='))?.slice(name.length + 1) || ''
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
}
function json(res, status, data) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}
async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(400, '请求应使用 JSON 格式。')
  let size = 0, chunks = []
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) fail(413, '请求内容过大。'); chunks.push(chunk) }
  let data
  try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { fail(400, '请求内容不是有效 JSON。') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '请求内容应为对象。')
  return data
}
function keys(body, fields) { if (Object.keys(body).some(key => !fields.includes(key))) fail(400, '请求包含不支持的字段。') }
function writeCookie(name, res, secure, token, expires = SESSION_TTL / 1000) {
  res.setHeader('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expires}${secure ? '; Secure' : ''}`)
}

/** 账号边缘服务：浏览器始终使用账号 Cookie，后端万能凭证只留在此进程。 */
export async function createStudioEdge({ backend, dataDir, repoRoot, hermesHome = path.join(repoRoot, '.hermes'), provisionProfile, backendToken, workerPool, publicOrigin, cookieName, identity = {}, companySso }) {
  const COOKIE = cookieName || DEFAULT_COOKIE
  if (!/^[A-Za-z0-9_]{1,80}$/.test(COOKIE)) throw new Error('登录 Cookie 名称无效。')
  const cookieToken = req => readCookie(req, COOKIE)
  const setCookie = (...args) => writeCookie(COOKIE, ...args)
  const { sameOrigin, cookieSecure } = createOriginPolicy(publicOrigin)
  const provision = provisionProfile ?? workerPool?.provision ?? profileProvisioner(repoRoot, hermesHome)
  const removeProfile = async profile => {
    await workerPool?.revoke?.(profile)
    await Promise.all([
      rm(path.join(hermesHome, 'profiles', profile), { recursive: true, force: true }),
      rm(path.join(hermesHome, 'studio-workers', profile), { recursive: true, force: true })
    ])
  }
  const company = companySso ?? (identity.company ? new CompanySso(identity.company) : null)
  if (company && identity.enabled !== true) throw new Error('公司登录需要启用组织身份配置。')
  if (company && (!publicOrigin || new URL(company.callback).origin !== new URL(publicOrigin).origin)) throw new Error('公司回调必须与工作区公开入口同源。')
  const store = await AccountStore.open(dataDir, provision, removeProfile, { organizations: identity.enabled === true, company })
  const maintenance = await createMaintenance({ dataDir, store })
  const companySync = store.organizations && company ? startCompanySync({ store, company }) : null
  const service = new StudioBackend({ backend, repoRoot, hermesHome, backendToken, workerPool })
  const sidebar = await createSidebarService({ dataDir, store, service })
  const employeeAccess = await createEmployeeAccess(dataDir, store, service)
  const modelSettings = createModelSettingsService({ service, store, workerPool, endpointImpact: id => modelNames.disableImpact(id), onChanged: () => socket.modelsChanged() })
  const modelNames = await ModelDisplayNames.open(dataDir, () => modelSettings.managedEndpoints())
  service.modelNames = modelNames
  const displayNames = createModelDisplayNamesService({ modelNames, store, onChanged: () => socket.modelsChanged() })
  const attempts = new Map()
  const installed = new Set()
  const authenticateRequest = async (req, required = true, { activation = false } = {}) => {
    const token = cookieToken(req), auth = store.authenticate(token, { activation })
    if (!auth && required) fail(401, '请先登录巨豹智能体。')
    return auth ? store.verifyActor({ ...auth, token }, { activation }) : null
  }
  const socket = createSocketBridge({ backend: service, store, authenticateRequest, sameOrigin, maintenance })
  // 可选的外部运维采集器；加载失败不会阻断业务服务。
  if (process.env.JUBAO_STUDIO_OBSERVER) {
    try {
      const { attach } = await import(process.env.JUBAO_STUDIO_OBSERVER)
      attach({ store, backend: service, socket })
    } catch (error) { console.error('运维采集器未加载：' + error.name) }
  }
  const workerRevocations = new Set()
  const revokeWorker = userId => {
    const user = userId && store.user(userId)
    if (!user || !workerPool?.revoke) return
    // 账号权限撤销同时停止后台工作；单个浏览器退出仅关闭它自己的连接。
    const cleanup = workerPool.revoke(user.profile)
    workerRevocations.add(cleanup)
    void cleanup.then(() => workerRevocations.delete(cleanup), () => {
      workerRevocations.delete(cleanup)
      console.error('账号工作进程撤销未完成，请检查本机服务。')
    })
  }
  store.revoked.add(revokeWorker)
  store.onCompanyInvalidated = revokeWorker
  const csrf = (req, auth) => {
    const supplied = req.headers['x-studio-csrf']
    if (typeof supplied !== 'string' || supplied.length !== auth.csrfToken.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(auth.csrfToken))) fail(403, '页面验证已过期，请刷新后重试。')
  }
  const checkLoginRate = req => {
    const key = req.socket.remoteAddress || 'local', time = Date.now()
    const row = attempts.get(key)
    if (!row || row.reset <= time) { attempts.set(key, { count: 1, reset: time + 60_000 }); return }
    if (++row.count > 20) fail(429, '登录尝试过于频繁，请一分钟后重试。')
  }
  async function studio(req, res, url) {
    if (url.pathname === '/studio/maintenance' && req.method === 'GET') { json(res, 200, maintenance.snapshot()); return }
    const sessionResponse = result => {
      setCookie(res, cookieSecure(req), result.token, Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000)))
      json(res, 200, { user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt })
    }
    if (url.pathname === '/studio/auth/options' && req.method === 'GET') {
      json(res, 200, { company: Boolean(company), organizations: store.organizations }); return
    }
    if (url.pathname === '/studio/auth/logout' && req.method === 'POST') {
      const token = cookieToken(req), auth = store.authenticate(token, { activation: true })
      if (!auth) fail(401, '登录已失效，请重新登录。')
      csrf(req, auth); keys(await bodyJson(req), [])
      await store.logout(token); setCookie(res, cookieSecure(req), '', 0); json(res, 200, { ok: true }); return
    }
    if (['/studio/auth/company/start', '/studio/auth/company/complete', '/studio/auth/company/launch'].includes(url.pathname) && req.method === 'POST') {
      maintenance.assertLogin()
      checkLoginRate(req)
      if (!company) fail(503, '公司登录尚未配置，请联系管理员。')
      const oldToken = cookieToken(req)
      if (oldToken) await store.logout(oldToken)
      setCookie(res, cookieSecure(req), '', 0)
      const body = await bodyJson(req)
      if (url.pathname.endsWith('/start')) {
        keys(body, ['switch_account'])
        if ('switch_account' in body && typeof body.switch_account !== 'boolean') fail(400, '切换账号参数不正确。')
        const result = company.begin({ switchAccount: body.switch_account === true })
        res.setHeader('Set-Cookie', [`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure(req) ? '; Secure' : ''}`, `${COOKIE}_company=${result.transaction}; Path=/studio/auth/company/; HttpOnly; SameSite=Lax; Max-Age=120${cookieSecure(req) ? '; Secure' : ''}`])
        json(res, 200, { url: result.url }); return
      }
      let result
      if (url.pathname.endsWith('/launch')) { keys(body, ['code']); result = await company.launch(body.code) }
      else { keys(body, ['ticket', 'state']); result = await company.complete(readCookie(req, COOKIE + '_company'), body.ticket, body.state) }
      maintenance.assertLogin()
      // 公司后台刚新建的员工：先同步一次目录，按部门定归属建号，再完成首次登录。
      if (companySync && !store.users.some(row => row.auth_source === 'company' && row.employee_id === result.employee.id)) await companySync.run()
      const session = await store.companyLogin(result)
      try { maintenance.assertLogin() }
      catch (error) { await store.logout(session.token); throw error }
      sessionResponse(session); return
    }
    if (url.pathname === '/studio/auth/login' && req.method === 'POST') {
      maintenance.assertLogin()
      checkLoginRate(req)
      const body = await bodyJson(req); keys(body, ['username', 'password', 'activation_code'])
      const result = await store.login(body.username, body.password, body.activation_code, { peer_ip: req.socket.remoteAddress, forwarded_ip: req.headers['x-real-ip'], response: res })
      try { maintenance.assertLogin() }
      catch (error) { await store.logout(result.token); throw error }
      const oldToken = cookieToken(req)
      if (oldToken) await store.logout(oldToken)
      setCookie(res, cookieSecure(req), result.token)
      json(res, 200, { user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt }); return
    }
    const activation = ['/studio/auth/me', '/studio/auth/company/activate'].includes(url.pathname)
    let auth = await authenticateRequest(req, url.pathname !== '/studio/auth/me' || req.method !== 'GET', { activation })
    if (url.pathname === '/studio/auth/me' && req.method === 'GET') {
      json(res, 200, auth ? { user: auth.user, csrfToken: auth.csrfToken, expiresAt: auth.expires } : { user: null }); return
    }
    let body
    if (!['GET', 'HEAD'].includes(req.method)) {
      csrf(req, auth)
      body = await bodyJson(req)
      auth = await authenticateRequest(req, true, { activation })
      csrf(req, auth)
    }
    if (url.pathname === '/studio/auth/company/activate' && req.method === 'POST') {
      maintenance.assertLogin()
      keys(body, ['activation_code'])
      const result = await store.activateCompany(auth, body.activation_code)
      try { maintenance.assertLogin() }
      catch (error) { await store.logout(result.token); throw error }
      sessionResponse(result); return
    }
    const user = auth.user
    if (await sidebar.handle(req, res, url, auth, body)) return
    if (await employeeAccess.handle(req, res, url, auth, body, service)) return
    if (await modelSettings.handle(req, res, url, auth, body)) return
    if (await displayNames.handle(req, res, url, auth, body)) return
    if (url.pathname === '/studio/session-documents' && req.method === 'POST') {
      const result = await sessionDocuments(service, user, body, () => store.requireActor(auth))
      json(res, 200, result); return
    }
    if (url.pathname === '/studio/creative-memory' && req.method === 'POST') {
      json(res, 200, await creativeMemory(service, user, body, () => store.requireActor(auth))); return
    }
    if (url.pathname === '/studio/creative-memory/edit' && req.method === 'POST') {
      json(res, 200, await editCreativeMemory(service, user, body, () => store.requireActor(auth))); return
    }
    if (url.pathname === '/studio/bootstrap' && req.method === 'GET') { json(res, 200, { profile: user.profile, user, csrfToken: auth.csrfToken }); return }
    if (url.pathname === '/studio/account' && req.method === 'PATCH') {
      keys(body, ['display_name'])
      json(res, 200, { user: await store.renameSelf(auth, body) }); return
    }
    if (url.pathname === '/studio/account/password' && req.method === 'POST') {
      keys(body, ['current_password', 'password'])
      if (typeof body.current_password !== 'string') fail(400, '请输入当前密码。')
      await store.setPassword(auth, user.id, body.password, body.current_password)
      setCookie(res, cookieSecure(req), '', 0); json(res, 200, { ok: true }); return
    }
    if (url.pathname === '/studio/admin/activation-codes') {
      if (user.role !== 'super_admin') fail(403, '只有超级管理员可以管理激活码。')
      if (req.method === 'GET') { json(res, 200, { codes: store.listActivationCodes(auth) }); return }
      if (req.method === 'POST') {
        keys(body, [])
        json(res, 201, await store.generateActivationCode(auth)); return
      }
    }
    const activationCode = url.pathname.match(/^\/studio\/admin\/activation-codes\/([a-f0-9-]{36})$/)
    if (activationCode && req.method === 'DELETE') {
      keys(body, [])
      json(res, 200, await store.deleteActivationCode(auth, activationCode[1])); return
    }
    const companyEmployees = await handleCompanyEmployees({ req, url, user, auth, body, store, company })
    if (companyEmployees) { json(res, companyEmployees.status, companyEmployees.data); return }
    if (url.pathname === '/studio/admin/users') {
      if (!['admin', 'super_admin'].includes(user.role)) fail(403, '此操作需要管理员权限。')
      if (req.method === 'GET') { json(res, 200, { users: store.listUsers(auth) }); return }
      if (req.method === 'POST') {
        keys(body, ['username', 'display_name', 'password', 'role', ...(store.organizations ? ['organization'] : [])])
        json(res, 201, { user: await store.create(auth, body) }); return
      }
    }
    const match = url.pathname.match(/^\/studio\/admin\/users\/([a-f0-9-]{36})(\/password)?$/)
    if (match && req.method === 'DELETE' && !match[2]) {
      keys(body, [])
      const result = await store.delete(auth, match[1])
      await employeeAccess.removeUser(match[1])
      json(res, 200, result); return
    }
    if (match && req.method === 'PATCH' && !match[2]) {
      keys(body, ['display_name', 'role', 'enabled', ...(store.organizations ? ['organization', 'managed_organizations'] : [])])
      json(res, 200, { user: await store.update(auth, match[1], body) }); return
    }
    if (match && req.method === 'POST' && match[2]) {
      keys(body, ['password'])
      await store.setPassword(auth, match[1], body.password); json(res, 200, { ok: true }); return
    }
    fail(404, '此功能不存在。')
  }
  async function api(req, res, url) {
    const auth = await authenticateRequest(req), { user } = auth
    let fileSourceId
    const authorizeRead = async () => {
      await store.verifyActor(auth)
      if (fileSourceId && !employeeAccess.canView(auth, fileSourceId)) fail(403, '已停止查看该员工的资料。')
    }
    service.requireEmployeeChannel(user)
    if (req.method !== 'GET') fail(403, '此接口不支持直接修改。')
    service.profile(user, url.searchParams.get('profile'))
    let response
    const sessionPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (sessionPath) {
      await service.session(user, decodeURIComponent(sessionPath[1]))
      response = await service.fetch(url.pathname, user, { limit: Math.min(Number(url.searchParams.get('limit')) || 500, 500), order: 'latest', inline_images: false })
    } else if (['/api/fs/read-text', '/api/fs/download'].includes(url.pathname)) {
      const requested = url.searchParams.get('path')
      const handleRequest = Boolean(requested?.startsWith('/assets-data/'))
      let fileUser = user, candidate
      if (isEmployee(user) || handleRequest) {
        const entry = await service.files.resolveEntry(user, requested)
        candidate = entry.path; fileUser = entry.sourceUser
      } else candidate = await service.file(user, requested)
      const crossProfileHandle = handleRequest && fileUser.profile !== user.profile
      if (crossProfileHandle) { fileSourceId = fileUser.id; await authorizeRead(); fileUser = employeeAccess.employee(fileSourceId) }
      const sessionId = url.searchParams.get('session_id')
      const freshSession = sessionId && service.ownsFreshSession(user, sessionId)
      if (sessionId && !freshSession && !crossProfileHandle) await service.session(user, sessionId)
      // 空会话尚未写入 Hermes 数据库；已由本进程确认归属的会话使用校验后的绝对文件路径。
      response = await service.fetch(url.pathname, fileUser, { path: candidate, session_id: crossProfileHandle || freshSession ? undefined : sessionId })
    } else fail(403, '工作区不支持此接口。')
    if (!response.ok) fail(response.status >= 500 ? 503 : response.status, '暂时无法读取这项资料。')
    if (sessionPath) {
      const data = await response.json()
      const messages = isEmployee(user) ? await service.presentation.messages(user, data.messages) : await service.presentation.nativeMessages(user, data.messages)
      await authenticateRequest(req)
      json(res, 200, isEmployee(user) ? { session_id: decodeURIComponent(sessionPath[1]), messages } : { ...data, messages }); return
    }
    if (isEmployee(user) && url.pathname === '/api/fs/read-text') {
      const data = await response.json()
      await authorizeRead()
      json(res, 200, { path: url.searchParams.get('path'), text: data.binary ? '' : typeof data.text === 'string' ? data.text : '', binary: Boolean(data.binary), truncated: Boolean(data.truncated) }); return
    }
    await authorizeRead()
    res.statusCode = response.status
    for (const header of ['content-type', 'content-disposition', 'content-length']) if (response.headers.has(header)) res.setHeader(header, response.headers.get(header))
    if (response.body) await forwardBody(response.body, res)
    else res.end()
  }
  const middleware = (req, res, next) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { json(res, 400, { error: '地址格式不正确。' }); return }
    const routed = url.pathname.startsWith('/studio/') || url.pathname.startsWith('/api/')
    if (routed) res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    Promise.resolve().then(async () => {
      sameOrigin(req, !['GET', 'HEAD'].includes(req.method))
      if (!routed) { next(); return }
      await (url.pathname.startsWith('/studio/') ? studio : api)(req, res, url)
    }).catch(error => {
      if (res.headersSent) { res.destroy(); return }
      json(res, error instanceof StudioError ? error.status : 503, { error: error instanceof StudioError ? error.message : '服务暂时不可用，请稍后重试。' })
    })
  }
  return {
    store,
    maintenance,
    companySync,
    seedRoot: password => store.seedRoot(password),
    install({ middlewares, httpServer }) {
      middlewares.use(middleware)
      if (httpServer && !installed.has(httpServer)) { httpServer.on('upgrade', socket.upgrade); installed.add(httpServer) }
    },
    async close() { for (const server of installed) server.off('upgrade', socket.upgrade); await companySync?.close(); await maintenance.close(); await socket.close(); await store.queue; await modelNames.queue; company?.close(); store.revoked.delete(revokeWorker); await Promise.allSettled([...workerRevocations]); await workerPool?.close() }
  }
}
