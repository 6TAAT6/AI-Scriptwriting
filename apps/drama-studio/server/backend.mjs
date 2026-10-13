import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { fail } from './accounts.mjs'
import { FileHandles, isEmployee, validateEmployeePrompt } from './file-handles.mjs'
import { StudioPresentation } from './presentation.mjs'
import { supportedEfforts } from './reasoning.mjs'
import { WebSocket } from 'ws'
import { isImageFile, isSupportedFile } from '../shared/attachments.mjs'
import { imagePrompt, validateImageUpload } from './image-attachments.mjs'
import { saveImageSelection } from './image-selection.mjs'
import { validateModelSelection } from './session-model.mjs'

const contains = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep)
const validSessionId = id => typeof id === 'string' && Boolean(id) && id.length <= 256 && !/[/?#\\\x00-\x1f\x7f]/.test(id)
const FRESH_SESSION_TTL = 60 * 60 * 1000
const FRESH_SESSION_LIMIT = 2048
const deletionBusy = () => fail(409, '这段聊天正在创作或等待确认，请先停止创作后再删除。')
async function sessionControl(transport, operation) {
  const url = new URL('/api/ws', transport.endpoint)
  url.protocol = 'ws:'; url.searchParams.set('token', transport.token)
  const socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false })
  const pending = new Map()
  socket.on('message', raw => {
    for (const line of raw.toString().split('\n').filter(Boolean)) {
      let frame; try { frame = JSON.parse(line) } catch { socket.terminate(); return }
      if (!frame.method && pending.has(frame.id)) { pending.get(frame.id).resolve(frame); pending.delete(frame.id) }
    }
  })
  const lost = () => { for (const waiter of pending.values()) waiter.reject(new Error('创作连接已关闭。')); pending.clear() }
  socket.on('close', lost); socket.on('error', lost)
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('创作连接已关闭。'))) })
    const call = async (method, params = {}) => {
      const id = randomUUID()
      const frame = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('创作连接等待超时。')) }, 20000)
        timer.unref()
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, profile: transport.profile } }))
      })
      if (frame.error?.code === 4023) deletionBusy()
      if (frame.error?.code === 4007) fail(404, '对话不存在。')
      if (frame.error || !frame.result || typeof frame.result !== 'object') fail(503, '暂时无法删除这段聊天，请稍后重试。')
      return frame.result
    }
    return await operation(call)
  } finally { socket.terminate() }
}
export class StudioBackend {
  constructor({ backend, repoRoot, hermesHome, backendToken, workerPool, modelNames }) {
    this.repoRoot = repoRoot
    this.endpoint = new URL(backend)
    if (this.endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname) || this.endpoint.username || this.endpoint.password) throw new Error('创作服务必须使用本机 HTTP 地址。')
    this.home = hermesHome ?? path.join(repoRoot, '.hermes')
    this.runtimeOwners = new Map()
    this.runtimeStates = new Map()
    this.deletingStored = new Set()
    this.deletingRuntime = new Set()
    this.freshSessions = new Map()
    this.catalogs = new Map()
    this.modelNames = modelNames
    this.requestModelSlots = new WeakMap()
    this.backendToken = typeof backendToken === 'string' ? backendToken : ''
    this.workerPool = workerPool
    this.files = new FileHandles(this)
    this.presentation = new StudioPresentation(this)
    this.tokenValue = ''; this.tokenPromise = null
  }
  async token() {
    if (this.backendToken) return this.backendToken
    if (this.tokenValue) return this.tokenValue
    if (!this.tokenPromise) this.tokenPromise = (async () => {
      const response = await fetch(this.endpoint, { signal: AbortSignal.timeout(5000), redirect: 'error' })
      const html = await response.text()
      const token = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1]
      if (!response.ok || !token) fail(503, '创作服务尚未就绪，请稍后重试。')
      this.tokenValue = token; return token
    })().finally(() => { this.tokenPromise = null })
    return this.tokenPromise
  }
  profile(user, requested) { if (requested && requested !== user.profile) fail(403, '不能访问其他账号的工作区。'); return user.profile }
  homeFor(user) { return isEmployee(user) && this.workerPool ? this.workerPool.homeFor(user) : path.join(this.home, 'profiles', user.profile) }
  async transport(user) {
    if (isEmployee(user) && this.workerPool) return this.workerPool.get(user)
    this.requireEmployeeChannel(user)
    return { endpoint: this.endpoint, token: await this.token(), profile: user.profile }
  }
  requireEmployeeChannel(user) {
    if (isEmployee(user) && !this.backendToken && !this.workerPool) fail(503, '员工创作服务尚未完成安全配置，请联系管理员。')
  }
  async fetch(route, user, params = {}) {
    const transport = await this.transport(user)
    const url = new URL(route, transport.endpoint)
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value))
    url.searchParams.set('profile', transport.profile)
    const timeout = route === '/api/fs/download' ? 120_000 : 20_000
    const response = await fetch(url, { headers: { 'X-Hermes-Session-Token': transport.token }, signal: AbortSignal.timeout(timeout), redirect: 'error' })
    if (response.status === 401 || response.status === 403) this.tokenValue = ''
    return response
  }
  async session(user, id) {
    if (this.deletingStored.has(user.profile + ':' + id)) deletionBusy()
    if (typeof id !== 'string' || !id || id.length > 256 || /[/?#\\]/.test(id)) fail(404, '对话不存在。')
    const response = await this.fetch(`/api/sessions/${encodeURIComponent(id)}`, user)
    if (!response.ok) fail(response.status === 404 ? 404 : 503, response.status === 404 ? '对话不存在。' : '暂时无法验证对话。')
    return response.json()
  }
  async deleteSession(user, id, authorize = () => {}) {
    if (!validSessionId(id)) fail(404, '对话不存在。')
    const detail = await this.session(user, id)
    if (detail.id !== id) fail(404, '对话不存在。')
    const key = user.profile + ':' + id, locked = new Set()
    this.deletingStored.add(key)
    const idle = rows => {
      for (const row of rows) {
        if (!validSessionId(row.id) || row.status !== 'idle' || this.runtimeOwners.get(row.id) !== user.id) deletionBusy()
        const state = this.runtimeStates.get(row.id)
        if (!state || state.running || state.submitting || state.selectingImage || state.switchingModel) deletionBusy()
      }
    }
    try {
      const transport = await this.transport(user)
      authorize()
      await sessionControl(transport, async call => {
        const active = async () => {
          const result = await call('session.active_list')
          if (!Array.isArray(result.sessions)) fail(503, '暂时无法验证聊天状态。')
          return result.sessions.filter(row => row.session_key === id)
        }
        const targets = await active()
        idle(targets)
        for (const row of targets) { locked.add(row.id); this.deletingRuntime.add(row.id) }
        const current = await active()
        idle(current)
        if (current.some(row => !locked.has(row.id))) deletionBusy()
        for (const row of current) {
          authorize(); idle([row])
          await call('session.close', { session_id: row.id })
        }
        authorize()
        const result = await call('session.delete', { session_id: id })
        if (result.deleted !== id) fail(503, '聊天删除结果尚未确认，请刷新后核对。')
      })
      for (const runtimeId of locked) { this.runtimeOwners.delete(runtimeId); this.runtimeStates.delete(runtimeId) }
      this.freshSessions.delete(id)
    } finally {
      this.deletingStored.delete(key)
      for (const runtimeId of locked) this.deletingRuntime.delete(runtimeId)
    }
  }
  pruneFreshSessions() {
    const now = Date.now()
    for (const [id, row] of this.freshSessions) if (row.expiresAt <= now) this.freshSessions.delete(id)
  }
  async projectSessionIds(user, metadata, projectId) {
    const ids = new Set(metadata.filter(row => (row.projectId === undefined ? 'default' : row.projectId) === projectId).map(row => row.id))
    if (projectId !== 'default') return [...ids]
    await sessionControl(await this.transport(user), async call => {
      for (let offset = 0; ; offset += 200) {
        const result = await call('session.list', { limit: 200, offset, include_hidden: true })
        if (!Array.isArray(result.sessions)) fail(503, '暂时无法读取项目聊天。')
        for (const row of result.sessions) if (!metadata.some(item => item.id === row.id)) ids.add(row.id)
        if (result.sessions.length < 200) break
      }
    })
    return [...ids]
  }
  async assertSessionsIdle(user, ids) {
    if (!ids.length) return
    await sessionControl(await this.transport(user), async call => {
      const result = await call('session.active_list')
      if (!Array.isArray(result.sessions)) fail(503, '暂时无法核对创作状态。')
      for (const row of result.sessions.filter(row => ids.includes(row.session_key))) {
        const state = this.runtimeStates.get(row.id)
        if (row.status !== 'idle' || this.runtimeOwners.get(row.id) !== user.id || !state || state.running || state.submitting || state.selectingImage || state.switchingModel) deletionBusy()
      }
      const delegated = await call('delegation.status')
      if (!Array.isArray(delegated.active) || delegated.active.length) deletionBusy()
    })
  }
  async rememberSession(user, result, params = {}, selectedSlot) {
    if (!validSessionId(result.session_id)) return
    this.runtimeOwners.set(result.session_id, user.id)
    const previous = this.runtimeStates.get(result.session_id)
    const modelDisplaySlot = selectedSlot || (previous?.model === result.info?.model ? previous?.modelDisplaySlot : undefined)
      || this.modelNames?.sessionSlot(user, result.stored_session_id, result.info)
      || this.modelNames?.binding(user, result.info, this.catalogs.get(user.id))
    this.runtimeStates.set(result.session_id, { ...result.info, provider: params.provider || result.info?.provider, running: Boolean(result.running ?? result.info?.running), storedSessionId: result.stored_session_id, ...(modelDisplaySlot ? { modelDisplaySlot } : {}) })
    if (!validSessionId(result.stored_session_id)) return
    this.pruneFreshSessions()
    this.freshSessions.delete(result.stored_session_id)
    this.freshSessions.set(result.stored_session_id, { userId: user.id, profile: user.profile, runtimeId: result.session_id, expiresAt: Date.now() + FRESH_SESSION_TTL })
    while (this.freshSessions.size > FRESH_SESSION_LIMIT) this.freshSessions.delete(this.freshSessions.keys().next().value)
    await this.modelNames?.rememberSession(user, result.stored_session_id, modelDisplaySlot, result.info)
  }
  ownsFreshSession(user, id) {
    this.pruneFreshSessions()
    const row = this.freshSessions.get(id)
    return Boolean(row && row.userId === user.id && row.profile === user.profile && this.runtimeOwners.get(row.runtimeId) === user.id)
  }
  noteRequest(call) {
    if (call.method === 'session.resume' && this.deletingStored.has(call.params.profile + ':' + call.params.session_id)) deletionBusy()
    if (this.deletingRuntime.has(call.params?.session_id)) deletionBusy()
    const state = this.runtimeStates.get(call.params?.session_id)
    if (state?.switchingModel && ['prompt.submit', 'config.set', 'file.attach'].includes(call.method)) fail(409, '正在切换模型，请稍候。')
    if (call.method === 'config.set' && call.params.key === 'model') {
      if (!state || state.running || state.submitting || state.selectingImage) fail(409, '本轮尚未结束，请完成后切换模型。')
      state.switchingModel = true
    }
    if (call.method === 'prompt.submit') {
      if (state) { state.running = true; state.submitting = true }
    }
  }
  async noteReply(call, frame, user) {
    const state = this.runtimeStates.get(call.params?.session_id)
    if (!state) return
    if (call.method === 'prompt.submit' && frame.error) { state.running = false; state.submitting = false }
    if (call.method === 'config.set' && call.params.key === 'model') {
      state.switchingModel = false
      if (!frame.error && frame.result?.info) Object.assign(state, frame.result.info, { modelDisplaySlot: this.requestModelSlots.get(call) })
      if (!frame.error && user && state.storedSessionId) await this.modelNames?.rememberSession(user, state.storedSessionId, state.modelDisplaySlot, state)
    }
    if (call.method === 'config.set' && call.params.key === 'reasoning' && frame.result?.value) Object.assign(state, frame.result.info || {}, { reasoning_effort: frame.result.value })
  }
  noteEvent(frame) {
    const event = frame.method === 'event' ? frame.params : null
    const state = event && this.runtimeStates.get(event.session_id)
    if (!state) return
    if (event.type === 'message.start') { state.running = true; state.submitting = false }
    if (event.type === 'message.complete' || event.type === 'error') { state.running = false; state.submitting = false }
    if (event.type === 'session.info') {
      const info = event.payload || {}
      Object.assign(state, info, state.submitting && info.running === false ? { running: true } : {})
    }
  }
  async file(user, rawPath) {
    if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 8192 || rawPath.includes('\0') || !path.isAbsolute(rawPath)) fail(403, '无法访问这个文件。')
    const profileHome = this.homeFor(user)
    const realHome = await realpath(profileHome)
    // 只允许创作数据，永不把配置、凭证、源码或账号数据库作为可预览稿件。
    const allowed = ['attachments', 'workspace', 'plugin-data', 'plugin_data', 'data', 'cache/spillover', 'cache/generated/images']
    if (!allowed.some(name => [profileHome, realHome].some(home => contains(path.join(home, name), path.resolve(rawPath))))) fail(403, '无法访问这个文件。')
    let candidate
    try { candidate = await realpath(rawPath) } catch { fail(404, '文件不存在。') }
    for (const name of allowed) {
      let root
      try { root = await realpath(path.join(profileHome, name)) } catch { continue }
      // 根目录本身也必须位于所属profile，不能通过替换数据目录为符号链接绕过。
      if (contains(realHome, root) && contains(root, candidate)) return candidate
    }
    fail(403, '无法访问这个文件。')
  }
  ownRuntime(user, id) {
    if (this.deletingRuntime.has(id)) deletionBusy()
    if (typeof id !== 'string' || this.runtimeOwners.get(id) !== user.id) fail(403, '不能操作其他账号的对话。')
  }
}

export const RPC_FIELDS = {
  'gateway.ping': [],
  'client.capabilities': ['server_requests', 'declines_not_shown'],
  'session.list': ['profile', 'limit', 'include_hidden', 'offset', 'source', 'title', 'archived'],
  'model.options': ['profile', 'explicit_only', 'include_unconfigured'],
  'config.set': ['profile', 'session_id', 'key', 'value', 'scope'],
  'session.create': ['profile', 'source', 'title', 'model', 'provider', 'reasoning_effort', 'fast', 'close_on_disconnect', 'idempotency_key'],
  'session.resume': ['profile', 'session_id', 'lazy', 'eager_build', 'source', 'close_on_disconnect'],
  'session.interrupt': ['profile', 'session_id'],
  'session.events.since': ['session_id', 'last_seen'],
  'subagent.list': ['profile', 'session_id'],
  'prompt.submit': ['profile', 'session_id', 'text', 'surface', 'image_model', 'image_provider'],
  'file.attach': ['profile', 'session_id', 'data_url', 'name']
}
export async function authorizeRpc(frame, user, backend) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0') fail(400, '请求格式不正确。')
  if (!['string', 'number'].includes(typeof frame.id) || typeof frame.id === 'string' && frame.id.length > 128) fail(400, '请求标识不正确。')
  const fields = Object.hasOwn(RPC_FIELDS, frame.method) && RPC_FIELDS[frame.method]
  if (!fields) fail(403, '工作区不支持此操作。')
  const params = frame.params ?? {}
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields.includes(key))) fail(400, '请求参数不正确。')
  backend.profile(user, params.profile)
  backend.requireEmployeeChannel(user)
  const out = { ...params }
  if (fields.includes('profile')) out.profile = user.profile
  const decodeModel = (kind, selection) => backend.modelNames?.selection(user, backend.catalogs.get(user.id), kind, selection) || selection
  if (frame.method === 'session.create') Object.assign(out, decodeModel('text', out))
  if (frame.method === 'config.set' && out.key === 'model' && out.value && typeof out.value === 'object' && !Array.isArray(out.value)) out.value = decodeModel('text', out.value)
  if (frame.method === 'prompt.submit' && (out.image_model || out.image_provider)) {
    const selection = decodeModel('image', { model: out.image_model, provider: out.image_provider })
    out.image_model = selection.model; out.image_provider = selection.provider
  }
  if (frame.method === 'session.resume') {
    // 仅凭本账号已验证的创建回执，允许断线后恢复尚未首轮落盘的上传会话。
    if (!backend.ownsFreshSession(user, params.session_id)) await backend.session(user, params.session_id)
  }
  else if (fields.includes('session_id')) backend.ownRuntime(user, params.session_id)
  if (frame.method === 'config.set') {
    if (!['reasoning', 'model'].includes(out.key) || out.scope !== 'session') fail(403, '只允许选择当前对话的模型和思考强度。')
    const state = backend.runtimeStates.get(out.session_id)
    if (!state) fail(409, '请重新打开对话后调整设置。')
    if (state.running || state.submitting) fail(409, '生成中不能修改模型或思考强度，请等待本轮完成。')
    if (state.switchingModel || state.selectingImage) fail(409, '正在更新模型选择，请稍候。')
    if (out.key === 'model') out.value = validateModelSelection(backend, user, out.value)
    else if (!supportedEfforts(backend.catalogs.get(user.id), state).includes(out.value)) fail(400, '当前模型未声明支持这个思考档位。')
  }
  if (frame.method === 'session.create' && out.reasoning_effort !== undefined && !supportedEfforts(backend.catalogs.get(user.id), out).includes(out.reasoning_effort)) fail(400, '当前模型未声明支持这个思考档位。')
  if (frame.method === 'session.list') out.limit = Math.min(Math.max(Number(params.limit) || 100, 1), 200)
  if (frame.method === 'session.create') { out.source = 'web'; out.close_on_disconnect = false; out.idempotency_key = `${user.id}:${params.idempotency_key || randomUUID()}` }
  if (isEmployee(user) && frame.method === 'model.options') { out.explicit_only = true; out.include_unconfigured = false }
  if (isEmployee(user) && frame.method === 'session.resume') out.source = 'web'
  if (isEmployee(user) && frame.method === 'session.create' && (out.model || out.provider)) {
    const catalog = backend.catalogs.get(user.id)
    if (!catalog?.providers.some(row => (!out.provider || row.slug === out.provider) && row.models.includes(out.model))) fail(403, '请选择当前工作区提供的创作模型。')
  }
  if (frame.method === 'prompt.submit' && (typeof out.text !== 'string' || out.text.length > 1_000_000)) fail(400, '单条消息最多 100 万字符；长原稿请作为附件上传，支持最多 150 万字符分段读取。')
  if (isEmployee(user) && frame.method === 'prompt.submit') { validateEmployeePrompt(out.text); out.surface = 'web' }
  if (frame.method === 'prompt.submit') out.text = await imagePrompt(backend, user, out.text)
  if (frame.method === 'prompt.submit' && ('image_model' in out || 'image_provider' in out)) {
    await saveImageSelection(backend, user, out)
    delete out.image_model; delete out.image_provider
  }
  if (frame.method === 'file.attach') {
    if (typeof out.name !== 'string' || out.name.length > 240 || out.name !== path.basename(out.name) || !isSupportedFile(out.name)) fail(400, '支持文档以及 PNG、JPG、WebP 图片。')
    if (typeof out.data_url !== 'string' || out.data_url.length > 29_000_000 || !out.data_url.startsWith('data:')) fail(400, '原稿应在 20 MB 以内。')
    if (isImageFile(out.name)) validateImageUpload(out.data_url, out.name)
  }
  const call = { ...frame, params: out }
  const slot = frame.method === 'session.create' ? params.model : frame.method === 'config.set' && params.key === 'model' ? params.value?.model : undefined
  if (backend.modelNames && typeof slot === 'string') backend.requestModelSlots.set(call, slot)
  return call
}
