import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises'
import path from 'node:path'
import { activationRequired, activationDigest, loadActivationKey, newActivationCode, publicActivationCode } from './activation-codes.mjs'
import { validOrganization, validScope } from '../shared/organizations.mjs'

const scrypt = promisify(derive)
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000
const SESSION_FILE_VERSION = 1
const SESSION_DIGEST = /^[a-f0-9]{64}$/
export class StudioError extends Error { constructor(status, message) { super(message); this.status = status } }
export const fail = (status, message) => { throw new StudioError(status, message) }
const digest = text => createHash('sha256').update(text).digest('hex')
const now = () => new Date().toISOString()

function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 256) fail(400, '密码长度应为 6 至 256 个字符。')
  return value
}
function nameValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail(400, '请输入 1 至 80 个字符的姓名。')
  return value.trim()
}
async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}
async function matches(password, hash) {
  const [salt, key] = hash.split(':')
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 64)
  return timingSafeEqual(actual, Buffer.from(key, 'hex'))
}
function publicUser(user) {
  const { passwordHash, version, ...data } = user
  return { ...data, activated_at: user.activated_at ?? null, activation_required: activationRequired(user) }
}
export function companyUsername(employee) {
  return typeof employee.account === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(employee.account) ? employee.account.toLowerCase() : `company_${employee.id}`
}
function activate(user, codes, activationCode) {
  if (!activationRequired(user)) return
  if (!activationCode) fail(403, '账号尚未激活，请填写一次性激活码。')
  const hash = activationDigest(activationCode)
  const code = hash && codes.find(row => row.code_hash === hash && !row.used_at && !row.used_by && !row.deleted_at)
  if (!code) fail(403, '激活码无效或已使用，请向超级管理员领取新的激活码。')
  code.used_at = now(); code.used_by = user.id
  user.activated_at = code.used_at; user.updated_at = code.used_at
}

export class AccountStore {
  constructor(file, users, provisionProfile, removeProfile, activationCodes = [], activationKey) {
    this.file = file; this.users = users; this.provisionProfile = provisionProfile; this.removeProfile = removeProfile
    this.activationCodes = activationCodes
    this.activationKey = activationKey
    this.sessionsFile = path.join(path.dirname(file), 'studio-sessions.json')
    this.sessions = new Map(); this.queue = Promise.resolve(); this.revoked = new Set(); this.sessionsDirty = false
  }
  static async open(dataDir, provisionProfile, removeProfile, options = {}) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await chmod(dataDir, 0o700)
    const file = path.join(dataDir, 'accounts.json')
    let users = [], activationCodes = [], persistedSessions = []
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'))
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.users) || saved.version === 2 && !Array.isArray(saved.activation_codes)) throw new Error('账号存储格式不受支持。')
      users = saved.users
      activationCodes = saved.version === 2 ? saved.activation_codes : []
      await chmod(file, 0o600)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const sessionsFile = path.join(dataDir, 'studio-sessions.json')
    try {
      const saved = JSON.parse(await readFile(sessionsFile, 'utf8'))
      if (saved.version !== SESSION_FILE_VERSION || !Array.isArray(saved.sessions)) throw new Error('登录会话存储格式不受支持。')
      persistedSessions = saved.sessions
      await chmod(sessionsFile, 0o600)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const store = new AccountStore(file, users, provisionProfile, removeProfile, activationCodes, await loadActivationKey(dataDir, activationCodes))
    store.organizations = options.organizations === true || users.some(user => Object.hasOwn(user, 'organization'))
    store.company = options.company
    if (store.organizations && users.some(user => !validOrganization(user.organization) || !['local', 'company'].includes(user.auth_source) ||
      !validScope(user.managed_organizations) ||
      user.auth_source === 'company' && !/^[1-9][0-9]{0,19}$/.test(user.employee_id))) throw new Error('账号组织资料不完整，请先预览并确认身份迁移。')
    const employeeIds = users.filter(user => user.auth_source === 'company').map(user => user.employee_id)
    if (new Set(employeeIds).size !== employeeIds.length) throw new Error('公司员工身份存在重复绑定。')
    store.dummyHash = await hashPassword(randomBytes(32).toString('hex'))
    store.restoreSessions(persistedSessions)
    if (store.sessionsDirty) {
      await store.persistSessions()
      store.sessionsDirty = false
    }
    return store
  }
  restoreSessions(rows) {
    const current = Date.now()
    for (const row of rows) {
      const tokenDigest = typeof row?.token_digest === 'string' ? row.token_digest : ''
      const userId = typeof row?.user_id === 'string' ? row.user_id : ''
      const version = Number.isInteger(row?.version) ? row.version : 0
      const expires = Number.isFinite(row?.expires) ? row.expires : 0
      const user = this.users.find(value => value.id === userId)
      if (row.source === 'company' || this.organizations && user?.auth_source === 'company' || !SESSION_DIGEST.test(tokenDigest) || !userId || version < 1 || expires <= current ||
          !user?.enabled || user.version !== version || activationRequired(user)) {
        this.sessionsDirty = true
        continue
      }
      // CSRF token 不跨进程持久化。浏览器必须先从 /studio/auth/me 获取本次启动新生成的值，
      // 再提交会修改状态的请求。
      this.sessions.set(tokenDigest, { userId, version, csrfToken: randomBytes(24).toString('base64url'), expires })
    }
  }
  sessionRows(sessions = this.sessions) {
    return [...sessions.entries()].map(([tokenDigest, session]) => ({
      token_digest: tokenDigest,
      user_id: session.userId,
      version: session.version,
      expires: session.expires,
      ...(session.source === 'company' ? { source: 'company' } : {})
    }))
  }
  async persistSessions(sessions = this.sessions) {
    const temp = `${this.sessionsFile}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify({ version: SESSION_FILE_VERSION, sessions: this.sessionRows(sessions) }), { mode: 0o600, flag: 'wx' })
      await rename(temp, this.sessionsFile)
      await chmod(this.sessionsFile, 0o600)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
  async commitSessions(mutator) {
    const next = new Map(this.sessions)
    const value = await mutator(next)
    await this.persistSessions(next)
    this.sessions = next
    this.sessionsDirty = false
    return value
  }
  serialize(fn) {
    const operation = this.queue.then(fn)
    this.queue = operation.catch(() => {})
    return operation
  }
  requireActor(auth) {
    const current = auth && this.authenticate(auth.token)
    if (!current || current.user.id !== auth.user.id || current.version !== auth.version || current.user.role !== auth.user.role) fail(401, '账号状态已变化，请重新登录。')
    return current.user
  }
  publicUser(user) { return { ...publicUser(user), ...(this.organizations ? { organization_policy: true } : {}) } }
  async verifyActor(auth, { activation = false } = {}) {
    const current = auth && this.authenticate(auth.token, { activation })
    if (!current || current.user.id !== auth.user.id || current.version !== auth.version) fail(401, '登录已失效，请重新登录。')
    if (current.source !== 'company') return { ...current, token: auth.token }
    if (!this.company) fail(503, '公司登录尚未配置，请联系管理员。')
    try {
      const employee = await this.company.verify(current.upstream, current.employeeId)
      const latest = this.authenticate(auth.token, { activation })
      if (!latest || latest.version !== current.version) fail(401, '账号状态已变化，请重新登录。')
      return { ...latest, token: auth.token, user: { ...latest.user, display_name: employee.name } }
    } catch (error) {
      if (error instanceof StudioError && error.status === 401) {
        this.sessions.delete(digest(auth.token)); this.sessionsDirty = true
        for (const fn of this.revoked) fn(null, auth.token)
        this.onCompanyInvalidated?.(current.user.id)
        void this.serialize(() => this.persistSessions()).catch(() => {})
      }
      throw error
    }
  }
  async mutate(fn, auth, afterCommit) {
    return this.serialize(async () => {
      if (auth) await this.verifyActor(auth)
      const actor = auth ? this.requireActor(auth) : null
      const users = structuredClone(this.users)
      const activationCodes = structuredClone(this.activationCodes)
      const value = await fn(users, actor, activationCodes)
      if (auth) await this.verifyActor(auth)
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        // 消耗激活码与账号激活共用一次原子落盘，失败时两者均保持原状态。
        await writeFile(temp, JSON.stringify({ version: 2, users, activation_codes: activationCodes }), { mode: 0o600, flag: 'wx' })
        if (auth) await this.verifyActor(auth)
        await rename(temp, this.file)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
      // 写入成功前不发布副本，避免并发读取观察到尚未落盘的停用或密码版本。
      this.users = users
      this.activationCodes = activationCodes
      await afterCommit?.()
      return value
    })
  }
  async seedRoot(password) {
    return this.mutate(async users => {
      const existing = users.find(user => user.username === 'root')
      if (existing) return this.publicUser(existing)
      const user = { id: randomUUID(), username: 'root', display_name: '系统管理员', role: 'super_admin', enabled: true,
        profile: 'jubao-drama', created_at: now(), updated_at: now(), last_login_at: null, version: 1,
        passwordHash: await hashPassword(passwordValue(password)),
        ...(this.organizations ? { organization: 'unassigned', auth_source: 'local', managed_organizations: [], conversation_organizations: [] } : {}) }
      users.push(user); return this.publicUser(user)
    })
  }
  listUsers(auth) {
    if (auth) this.requireActor(auth)
    return this.users.map(user => this.publicUser(user))
  }
  user(id) { const user = this.users.find(row => row.id === id); return user ? this.publicUser(user) : null }
  listActivationCodes(auth) {
    if (this.requireActor(auth).role !== 'super_admin') fail(403, '只有超级管理员可以管理激活码。')
    return this.activationCodes.filter(row => !row.deleted_at).toReversed().map(row => publicActivationCode(row, this.users, this.activationKey))
  }
  async generateActivationCode(auth) {
    return this.mutate(async (users, actor, codes) => {
      if (actor?.role !== 'super_admin') fail(403, '只有超级管理员可以生成激活码。')
      if (codes.filter(row => !row.used_at && !row.deleted_at).length >= 1000) fail(400, '未使用的激活码已达上限，请先使用或删除现有激活码。')
      const { code, record } = newActivationCode(actor, this.activationKey)
      codes.push(record)
      return { code, activation_code: publicActivationCode(record, users, this.activationKey) }
    }, auth)
  }
  async deleteActivationCode(auth, id) {
    return this.mutate(async (_users, actor, codes) => {
      if (actor?.role !== 'super_admin') fail(403, '只有超级管理员可以删除激活码。')
      const code = codes.find(row => row.id === id)
      if (!code) fail(404, '激活码不存在。')
      if (!code.deleted_at) { code.deleted_at = now(); code.deleted_by = actor.id }
      return { ok: true, deleted: id }
    }, auth)
  }
  manage(actor, target, role = target?.role) {
    if (!actor || !['super_admin', 'admin'].includes(actor.role)) fail(403, '此操作需要管理员权限。')
    if (actor.role !== 'super_admin' && (target?.role !== 'employee' && target || role !== 'employee')) fail(403, '只有系统管理员可以管理管理员账号。')
  }
  async create(auth, body) {
    const role = body.role ?? 'employee'
    if (!['admin', 'employee'].includes(role)) fail(400, '账号角色不正确。')
    if (typeof body.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(body.username)) fail(400, '账号应为 3 至 64 位字母、数字、下划线、点或短横线。')
    const username = body.username.toLowerCase(), display_name = nameValue(body.display_name), password = passwordValue(body.password)
    return this.mutate(async (users, actor) => {
      this.manage(actor, null, role)
      const organization = body.organization ?? 'chongqing'
      if (this.organizations && !validOrganization(organization)) fail(400, '请选择账号所属公司。')
      if (this.organizations && organization === 'hangzhou') fail(400, '横店新员工请使用公司账号首次登录。')
      if (users.some(user => user.username === username)) fail(409, '这个账号已经存在。')
      const id = randomUUID(), profile = `studio-${id.replaceAll('-', '').slice(0, 20)}`
      await this.provisionProfile(profile)
      const user = { id, username, display_name, role, enabled: true, activated_at: null, profile, created_at: now(), updated_at: now(), last_login_at: null, version: 1, passwordHash: await hashPassword(password),
        ...(this.organizations ? { organization, auth_source: 'local', managed_organizations: role === 'admin' ? [organization] : [], conversation_organizations: [] } : {}) }
      users.push(user); return this.publicUser(user)
    }, auth)
  }
  async update(auth, id, body) {
    if ('enabled' in body && typeof body.enabled !== 'boolean') fail(400, '账号状态不正确。')
    if ('display_name' in body) nameValue(body.display_name)
    let invalidate = false
    return this.mutate(async (users, actor) => {
      const user = users.find(row => row.id === id)
      if (!user) fail(404, '账号不存在。')
      this.manage(actor, user, body.role ?? user.role)
      if (this.organizations && ['organization', 'managed_organizations'].some(key => key in body)) {
        if (actor.role !== 'super_admin' || actor.id === user.id || user.role === 'super_admin') fail(403, '只有平台管理员可以配置其他人员的归属。')
        if ('organization' in body && (!validOrganization(body.organization) || user.auth_source === 'company' && !['hangzhou', 'chongqing'].includes(body.organization))) fail(400, '账号公司归属不正确。')
        if (body.organization === 'hangzhou' && user.auth_source !== 'company' && user.organization !== 'hangzhou') fail(400, '横店归属须先确认并绑定公司身份。')
        if ('managed_organizations' in body && !validScope(body.managed_organizations)) fail(400, '负责团队资料不正确。')
        for (const key of ['organization', 'managed_organizations']) if (key in body) {
          user[key] = structuredClone(body[key])
        }
      }
      if (this.organizations && user.auth_source === 'company' && 'display_name' in body && body.display_name.trim() !== user.display_name) fail(400, '公司员工姓名由公司后台维护。')
      if (user.username === 'root' && (body.enabled === false || body.role && body.role !== 'super_admin')) fail(400, '系统管理员不能停用或降低权限。')
      if ('role' in body && !['admin', 'employee'].includes(body.role) && !(user.username === 'root' && body.role === 'super_admin')) fail(400, '账号角色不正确。')
      if ('display_name' in body) user.display_name = body.display_name.trim()
      invalidate ||= 'role' in body && body.role !== user.role || 'enabled' in body && body.enabled !== user.enabled
      if ('role' in body) user.role = body.role
      if ('enabled' in body) user.enabled = body.enabled
      if (invalidate) user.version++
      user.updated_at = now(); return this.publicUser(user)
    }, auth, async () => { if (invalidate) await this.revokeInQueue(id) })
  }
  async delete(auth, id) {
    let deleted
    await this.mutate(async (users, actor) => {
      if (actor?.role !== 'super_admin') fail(403, '只有超级管理员可以删除账号。')
      const index = users.findIndex(user => user.id === id)
      if (index < 0) fail(404, '账号不存在。')
      const user = users[index]
      this.manage(actor, user)
      if (user.username === 'root' || user.role === 'super_admin' || user.id === actor.id) fail(400, '系统管理员账号不能删除。')
      deleted = this.publicUser(user)
      users.splice(index, 1)
      return deleted
    }, auth, async () => {
      await this.revokeInQueue(id)
      await this.removeProfile?.(deleted.profile)
    })
    return { ok: true, deleted: deleted.id }
  }
  async renameSelf(auth, body) {
    const name = nameValue(body.display_name)
    return this.mutate(async (users, actor) => {
      const user = users.find(row => row.id === actor.id)
      if (this.organizations && user.auth_source === 'company') fail(400, '公司员工姓名由公司后台维护。')
      user.display_name = name; user.updated_at = now(); return this.publicUser(user)
    }, auth)
  }
  async setPassword(auth, id, password, currentPassword) {
    passwordValue(password)
    await this.mutate(async (users, actor) => {
      const user = users.find(row => row.id === id)
      if (!user) fail(404, '账号不存在。')
      if (this.organizations && user.auth_source === 'company') fail(400, '该账号通过公司后台管理密码。')
      if (currentPassword !== undefined) {
        if (actor.id !== id || typeof currentPassword !== 'string' || currentPassword.length > 256 || !await matches(currentPassword, user.passwordHash)) fail(400, '当前密码不正确。')
      } else this.manage(actor, user)
      user.passwordHash = await hashPassword(password)
      user.version++; user.updated_at = now()
    }, auth, () => this.revokeInQueue(id))
  }
  async login(username, password, activationCode) {
    if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || password.length > 256) fail(401, '账号或密码不正确。')
    const target = this.users.find(user => user.username === username.toLowerCase())
    const version = target?.version
    const valid = await matches(password, target?.passwordHash ?? this.dummyHash)
    if (!valid || !target?.enabled) fail(401, '账号或密码不正确，或账号已停用。')
    if (this.organizations && target.auth_source === 'company') fail(403, '请使用横店公司账号登录。')
    // 密码校验让出事件循环后再次确认账号版本，避免改密/停用与登录并发时签发旧权限。
    let newSession, token
    return this.mutate(async (users, _actor, codes) => {
      const user = users.find(row => row.id === target.id)
      if (!user?.enabled || user.version !== version) fail(401, '账号状态已变化，请重新登录。')
      activate(user, codes, activationCode)
      user.last_login_at = now()
      token = randomBytes(32).toString('base64url')
      const csrfToken = randomBytes(24).toString('base64url')
      newSession = { userId: user.id, version: user.version, csrfToken, expires: Date.now() + SESSION_TTL }
      return { token, csrfToken, user: this.publicUser(user), expiresAt: newSession.expires }
    }, null, () => this.commitSessions(next => {
      for (const [key, session] of next) if (session.expires <= Date.now()) next.delete(key)
      next.set(digest(token), newSession)
    }))
  }
  authenticate(token, { activation = false } = {}) {
    if (!token) return null
    const key = digest(token), session = this.sessions.get(key)
    const user = session && this.users.find(row => row.id === session.userId)
    if (session?.source === 'company' && session.activationPending && activationRequired(user) && !activation) return null
    if (!session || session.expires <= Date.now() || !user?.enabled || user.version !== session.version ||
        this.organizations && (user.auth_source === 'company') !== (session.source === 'company') ||
        activationRequired(user) && !(activation && session.source === 'company' && session.activationPending)) {
      if (session) { this.sessions.delete(key); this.sessionsDirty = true }
      return null
    }
    return { ...session, user: this.publicUser(user) }
  }
  /** 新建公司员工账号记录并加入 users；首次登录自动建号和管理员预先分配共用。 */
  async companyUser(users, employee, organization) {
    const username = companyUsername(employee)
    if (users.some(row => row.username === username)) fail(409, '已有账号尚待身份绑定，请联系管理员。')
    const id = randomUUID(), profile = `studio-${id.replaceAll('-', '').slice(0, 20)}`
    await this.provisionProfile(profile)
    const user = { id, username, display_name: employee.name, role: 'employee', enabled: true, activated_at: null,
      profile, created_at: now(), updated_at: now(), last_login_at: null, version: 1, organization, auth_source: 'company',
      employee_id: employee.id, managed_organizations: [], conversation_organizations: [], passwordHash: await hashPassword(randomBytes(32).toString('base64url')) }
    users.push(user)
    return user
  }
  /**
   * 公司目录里没有配置归属的新员工，由管理员选横店/重庆后预先建号；员工之后用公司账号首次登录，
   * 按 employee_id 进入这个账号，仍走原激活码流程。employee 由调用方事先从公司目录读取，避免在账号写队列里等上游。
   */
  async assignCompany(auth, employee, organization) {
    if (!['hangzhou', 'chongqing'].includes(organization)) fail(400, '请选择横店或重庆。')
    return this.mutate(async (users, actor) => {
      this.manage(actor, null, 'employee')
      if (users.some(row => row.auth_source === 'company' && row.employee_id === employee.id)) fail(409, '这位员工已有智能体账号，请刷新人员列表。')
      return this.publicUser(await this.companyUser(users, employee, organization))
    }, auth)
  }
  async companyLogin(result) {
    const { employee, upstream, server: companyServer, expires } = result
    if (!this.organizations || !this.company || expires <= Date.now()) fail(401, '公司登录已失效。')
    let newSession, token
    return this.mutate(async users => {
      await this.company.verify(upstream, employee.id, companyServer)
      let user = users.find(row => row.auth_source === 'company' && row.employee_id === employee.id)
      if (!user) {
        if (!validOrganization(employee.organization) || employee.organization === 'unassigned') fail(403, '你的公司账号还没有分配所属公司（横店或重庆），请联系管理员在人员管理中分配后再登录。')
        user = await this.companyUser(users, employee, employee.organization)
      }
      if (!user.enabled || !validOrganization(user.organization) || user.organization === 'unassigned') fail(403, '智能体账号已停用或组织无效，请联系管理员。')
      await this.company.verify(upstream, employee.id, companyServer)
      user.display_name = employee.name; user.last_login_at = now()
      token = randomBytes(32).toString('base64url')
      const csrfToken = randomBytes(24).toString('base64url'), activationPending = activationRequired(user)
      newSession = { userId: user.id, version: user.version, csrfToken, expires: Math.min(expires, Date.now() + (activationPending ? 600_000 : 28800_000)),
        source: 'company', upstream, employeeId: employee.id, companyServer, activationPending, companyExpires: expires }
      return { token, csrfToken, user: this.publicUser(user), expiresAt: newSession.expires }
    }, null, () => this.commitSessions(next => { next.set(digest(token), newSession) }))
  }
  async activateCompany(auth, code) {
    await this.verifyActor(auth, { activation: true })
    if (auth.source !== 'company' || !auth.activationPending) fail(400, '当前账号无需激活。')
    await this.serialize(async () => {
      const current = await this.verifyActor(auth, { activation: true })
      const users = structuredClone(this.users), codes = structuredClone(this.activationCodes)
      const user = users.find(row => row.id === current.user.id)
      activate(user, codes, code)
      await this.verifyActor(auth, { activation: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ version: 2, users, activation_codes: codes }), { mode: 0o600, flag: 'wx' })
        await rename(temp, this.file)
      } catch (error) { await rm(temp, { force: true }); throw error }
      this.users = users; this.activationCodes = codes
    })
    const result = await this.companyLogin({ employee: { id: auth.employeeId, name: this.user(auth.user.id).display_name }, upstream: auth.upstream, expires: auth.companyExpires })
    await this.logout(auth.token)
    return result
  }
  async revokeInQueue(id) {
    await this.commitSessions(next => {
      for (const [key, session] of next) if (id === null || session.userId === id) next.delete(key)
    })
    for (const fn of this.revoked) fn(id)
  }
  async revoke(id) {
    return this.serialize(() => this.revokeInQueue(id))
  }
  async logout(token) {
    return this.serialize(async () => {
      await this.commitSessions(next => { next.delete(digest(token)) })
      for (const fn of this.revoked) fn(null, token)
    })
  }
}
