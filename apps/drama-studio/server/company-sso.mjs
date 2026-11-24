import { randomBytes, createHash } from 'node:crypto'
import { fail } from './accounts.mjs'
import { validOrganization } from '../shared/organizations.mjs'

const random = () => randomBytes(32).toString('base64url')
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const validTicket = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value)
const identifier = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
const now = () => Date.now()
const text = (value, size) => typeof value === 'string' && value.trim() ? value.trim().slice(0, size) : null

/** Fixed application configuration and browser-bound, one-use company login transactions. */
export class CompanySso {
  constructor(config, { fetcher = fetch, clock = now } = {}) {
    const server = new URL(config.serverUrl)
    const switchServer = config.switchServerUrl ? new URL(config.switchServerUrl) : null
    const callback = new URL(config.callbackUrl)
    if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== '/') throw new Error('公司账号服务地址无效。')
    if (switchServer && (!['http:', 'https:'].includes(switchServer.protocol) || switchServer.username || switchServer.password || switchServer.search || switchServer.hash || switchServer.pathname !== '/')) throw new Error('公司切换账号服务地址无效。')
    if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash) throw new Error('公司登录回调地址无效。')
    if (typeof config.appId !== 'string' || !/^web-[A-Za-z0-9-]{1,80}$/.test(config.appId) || typeof config.secret !== 'string' || config.secret.length < 16) throw new Error('公司登录配置不完整。')
    this.server = server.origin; this.switchServer = switchServer?.origin || null; this.callback = callback.href; this.appId = config.appId
    this.secret = config.secret; this.fetcher = fetcher; this.clock = clock; this.transactions = new Map(); this.inflight = new Map()
    this.organizationByDepartment = config.organizationByDepartment && typeof config.organizationByDepartment === 'object'
      ? { ...config.organizationByDepartment } : {}
    this.organizationByEmployee = config.organizationByEmployee && typeof config.organizationByEmployee === 'object'
      ? { ...config.organizationByEmployee } : {}
  }
  async request(route, data, server = this.server) {
    let response, envelope
    try {
      response = await this.fetcher(server + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'X-SSO-Secret': this.secret }, body: JSON.stringify({ ...data, appId: this.appId }) })
      const body = await response.text()
      if (body.length > 128_000) throw new Error('oversized response')
      envelope = JSON.parse(body)
    } catch { fail(503, '暂时无法验证公司身份，请稍后重试。') }
    if (!response.ok || envelope?.ok !== true) {
      if (response.status >= 500 || response.status === 429) fail(503, '暂时无法验证公司身份，请稍后重试。')
      fail(401, '公司登录或应用授权已失效，请重新登录。')
    }
    if (!envelope.data || typeof envelope.data !== 'object') fail(503, '公司身份响应无效，请稍后重试。')
    return envelope.data
  }
  begin({ switchAccount = false } = {}) {
    for (const [key, value] of this.transactions) if (value.expires <= this.clock()) this.transactions.delete(key)
    if (this.transactions.size >= 1000) fail(429, '登录请求较多，请稍后重试。')
    const transaction = random(), state = random(), verifier = random()
    const challenge = createHash('sha256').update(verifier).digest('hex')
    const server = switchAccount && this.switchServer ? this.switchServer : this.server
    this.transactions.set(transaction, { state, verifier, server, expires: this.clock() + 120_000 })
    const fragment = new URLSearchParams({ appId: this.appId, challenge, state })
    return { transaction, state, challenge, url: server + '/sso/login.html#' + fragment }
  }
  async complete(transaction, ticket, state) {
    const saved = opaque(transaction) && this.transactions.get(transaction)
    if (!saved || saved.expires <= this.clock() || saved.state !== state || !validTicket(ticket)) fail(401, '公司登录事务已失效，请重新发起登录。')
    this.transactions.delete(transaction)
    return this.exchange(ticket, saved.verifier, state, saved.server)
  }
  async launch(code) {
    if (!opaque(code)) fail(400, '工作台启动凭证格式不正确。')
    const value = this.begin(), saved = this.transactions.get(value.transaction)
    this.transactions.delete(value.transaction)
    const result = await this.request('/sso/launch', { code, challenge: value.challenge, state: value.state }, value.server)
    let callback
    try { callback = new URL(result.url) } catch { fail(401, '公司登录回调不匹配。') }
    if (callback.origin + callback.pathname + callback.search !== this.callback || callback.username || callback.password) fail(401, '公司登录回调不匹配。')
    const params = new URLSearchParams(callback.hash.slice(1))
    if (params.get('state') !== value.state || !validTicket(params.get('ticket'))) fail(401, '公司登录事务不匹配。')
    return this.exchange(params.get('ticket'), saved.verifier, value.state, value.server)
  }
  configuredOrganization(employeeId, departmentId) {
    return this.organizationByEmployee[employeeId] ?? this.organizationByDepartment[departmentId]
  }
  /** 公司后台已授权本应用的员工目录，只读；管理员据此给尚未分配所属公司的新员工建号。 */
  async directory() {
    const rows = []
    let received = 0
    try {
      for (let page = 1; page <= 50; page++) {
        const data = await this.request('/sso/employees', { page, pageSize: 200 })
        if (!Array.isArray(data.employees)) fail(503, '公司员工目录响应无效，请稍后重试。')
        received += data.employees.length
        const last = data.hasMore === false || data.hasMore === undefined && data.employees.length < 200
        // 同步会按目录停用账号，目录必须完整：条数与上游 total 不符时整次放弃。
        if (last && Number.isInteger(data.total) && data.total !== received) fail(503, '公司员工目录不完整，请稍后重试。')
        for (const employee of data.employees) {
          if (!identifier(employee?.employeeId)) continue
          rows.push({ id: employee.employeeId, name: text(employee.name, 80) ?? text(employee.account, 80) ?? `员工${employee.employeeId}`, account: text(employee.account, 64) ?? '',
            departmentId: text(employee.departmentId, 128), departmentName: text(employee.departmentName, 128), positionName: text(employee.positionName, 128),
            organization: employee.organization ?? this.configuredOrganization(employee.employeeId, employee.departmentId) })
        }
        if (last) return rows
      }
    } catch (error) {
      // 目录由服务端密钥读取，上游 401 表示应用授权问题，不能当成管理员本人登录失效。
      if (error?.status === 401) fail(503, '暂时无法读取公司员工目录，请检查公司后台应用授权。')
      throw error
    }
    fail(503, '公司员工目录过大，请联系管理员。')
  }
  identity(data) {
    const employee = data?.employee
    if (!identifier(data?.employeeId) || employee?.employeeId !== data.employeeId || typeof employee?.name !== 'string' || !employee.name.trim()) fail(503, '公司员工资料不完整，请联系管理员。')
    const organization = employee.organization ?? this.configuredOrganization(data.employeeId, employee.departmentId)
    if (organization !== undefined && (!['hangzhou', 'chongqing'].includes(organization) || !validOrganization(organization))) fail(503, '公司员工组织资料不完整，请联系管理员。')
    const identity = { id: data.employeeId, name: employee.name.trim().slice(0, 80), account: typeof employee.account === 'string' ? employee.account.slice(0, 64) : '', ...(organization ? { organization } : {}) }
    for (const field of ['departmentId', 'departmentName', 'positionId', 'positionName', 'positionLevel', 'position']) {
      if (typeof employee[field] === 'string' && employee[field].trim()) identity[field] = employee[field].trim().slice(0, 128)
    }
    return identity
  }
  async exchange(ticket, verifier, state, server = this.server) {
    const data = await this.request('/sso/exchange', { ticket, verifier, state }, server)
    const employee = this.identity(data)
    if (typeof data.session !== 'string' || !/^jbs_[A-Za-z0-9_-]{43}$/.test(data.session) || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0) fail(503, '公司登录响应无效，请重新登录。')
    return { employee, upstream: data.session, server, expires: this.clock() + Math.min(data.expiresIn, 28800) * 1000 }
  }
  async verify(upstream, employeeId, server = this.server) {
    let request = this.inflight.get(upstream)
    if (!request) {
      request = this.request('/sso/session', { session: upstream }, server).then(data => this.identity(data))
      this.inflight.set(upstream, request)
    }
    try {
      const identity = await request
      if (identity.id !== employeeId) fail(401, '公司身份已变化，请重新登录。')
      return identity
    } finally { if (this.inflight.get(upstream) === request) this.inflight.delete(upstream) }
  }
  close() { this.transactions.clear(); this.inflight.clear() }
}
