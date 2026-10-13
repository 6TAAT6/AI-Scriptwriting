import { atom } from 'nanostores'
import { publicError } from '../../shared/public-errors.mjs'

export interface StudioUser {
  id: string
  username: string
  display_name: string
  role: 'super_admin' | 'admin' | 'employee'
  enabled: boolean
  created_at: string
  profile: string
  activated_at?: string | null
  activation_required?: boolean
}
export const $currentUser = atom<StudioUser | null>(null)
export const $authenticationNotice = atom('')
export const roleLabels: Record<StudioUser['role'], string> = { super_admin: '超级管理员', admin: '管理员', employee: '员工' }
let csrfToken = ''
let sessionRevision = 0
let sessionExpiresAt: number | null = null
let logoutPending = false

interface SessionResponse { user: StudioUser | null; csrfToken?: string; expiresAt?: number }
export interface UserInput {
  username: string
  display_name: string
  password: string
  role: 'admin' | 'employee'
}
export interface UserPatch { display_name?: string; role?: 'admin' | 'employee'; enabled?: boolean }

export async function studioRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const revision = sessionRevision
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken && path !== '/auth/login') headers['X-Studio-CSRF'] = csrfToken
  let response: Response
  try {
    response = await fetch(`/studio${path}`, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new Error('暂时无法连接服务，请稍后重试。')
  }
  const data = await response.json().catch(() => null)
  if (revision !== sessionRevision) throw new Error('登录状态已变化，请重试。')
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') expireAuthentication()
    const message = typeof data?.error === 'string' ? data.error : typeof data?.detail === 'string' ? data.detail : null
    const fallback = response.status === 401 ? '登录已失效，请重新登录。' : response.status === 403 ? '没有权限执行此操作。' : '操作暂未完成，请稍后重试。'
    throw new Error(publicError(message, fallback))
  }
  return data as T
}

function setSession(data: SessionResponse) {
  if ($currentUser.get()?.id !== data.user?.id || csrfToken !== (data.csrfToken || '')) sessionRevision += 1
  csrfToken = data.csrfToken || ''
  sessionExpiresAt = data.user && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : null
  if (data.user) $authenticationNotice.set('')
  $currentUser.set(data.user)
  return data.user
}

/** WebSocket 重连后的 bootstrap 会刷新 CSRF，但不会重新登录账号。 */
export function refreshCsrfToken(next: string) {
  if (csrfToken !== next) sessionRevision += 1
  csrfToken = next
}

export async function loadCurrentUser() { return setSession(await studioRequest<SessionResponse>('/auth/me')) }
export async function login(username: string, password: string, activationCode = '') {
  sessionRevision += 1
  return setSession(await studioRequest<SessionResponse>('/auth/login', 'POST', { username, password, ...(activationCode.trim() ? { activation_code: activationCode.trim() } : {}) }))
}

export interface ActivationCode {
  id: string
  code?: string | null
  suffix: string
  created_at: string
  status: 'unused' | 'used'
  used_at: string | null
  used_by: string | null
  used_by_name?: string | null
}
export async function listActivationCodes() { return (await studioRequest<{ codes: ActivationCode[] }>('/admin/activation-codes')).codes }
export async function generateActivationCode() { return studioRequest<{ code: string; activation_code: ActivationCode }>('/admin/activation-codes', 'POST', {}) }
export async function deleteActivationCode(id: string) { return studioRequest<{ ok: true; deleted: string }>(`/admin/activation-codes/${encodeURIComponent(id)}`, 'DELETE', {}) }
export function clearAuthentication(notice = '') {
  $authenticationNotice.set(notice)
  sessionRevision += 1
  setSession({ user: null })
}
export function expireAuthentication() {
  if (!$currentUser.get()) return
  if (logoutPending) { clearAuthentication(); return }
  const notice = $authenticationNotice.get() || (sessionExpiresAt !== null && Date.now() >= sessionExpiresAt
    ? '你长时间未登录，请重新登录。' : '登录已失效，请重新登录。')
  clearAuthentication(notice)
}
export async function logout() {
  sessionRevision += 1
  logoutPending = true
  try {
    await studioRequest('/auth/logout', 'POST', {})
    clearAuthentication()
  } finally { logoutPending = false }
}
export async function listUsers() { return (await studioRequest<{ users: StudioUser[] }>('/admin/users')).users }
export async function createUser(input: UserInput) { return (await studioRequest<{ user: StudioUser }>('/admin/users', 'POST', input)).user }
export async function updateUser(id: string, patch: UserPatch) {
  const { user } = await studioRequest<{ user: StudioUser }>(`/admin/users/${encodeURIComponent(id)}`, 'PATCH', patch)
  if (user.id === $currentUser.get()?.id) $currentUser.set(user)
  return user
}
export async function deleteUser(id: string) {
  return studioRequest<{ ok: true; deleted: string }>(`/admin/users/${encodeURIComponent(id)}`, 'DELETE', {})
}
export async function resetPassword(id: string, password: string) { await studioRequest(`/admin/users/${encodeURIComponent(id)}/password`, 'POST', { password }) }
export async function updateAccount(display_name: string) {
  const { user } = await studioRequest<{ user: StudioUser }>('/account', 'PATCH', { display_name })
  $currentUser.set(user)
  return user
}
export async function changePassword(current_password: string, password: string) {
  await studioRequest('/account/password', 'POST', { current_password, password })
  clearAuthentication()
}

export function canManageUser(actor: StudioUser, subject: StudioUser) {
  return subject.role !== 'super_admin' && subject.id !== actor.id && (actor.role === 'super_admin' || (actor.role === 'admin' && subject.role === 'employee'))
}

export interface ModelEndpointInput {
  id?: string
  name: string
  base_url: string
  model: string
  models: string[]
  api_mode: 'chat_completions' | 'codex_responses'
  api_key?: string
  image_model?: string
  image_models?: string[]
}
export interface ModelEndpoint extends Omit<ModelEndpointInput, 'api_key'> { id: string; has_api_key: boolean; is_current?: boolean }
export async function listModelEndpoints() { return (await studioRequest<{ endpoints: ModelEndpoint[] }>('/admin/models')).endpoints }
export async function saveModelEndpoint(input: ModelEndpointInput) { return studioRequest<{ ok: boolean; endpoints: ModelEndpoint[]; message: string }>('/admin/models', 'POST', input) }
export async function validateModelEndpoint(input: ModelEndpointInput) { return studioRequest<{ ok: boolean; models: string[]; message: string }>('/admin/models/validate', 'POST', input) }

export interface ModelDisplayName { id: string; kind: 'text' | 'image'; provider: string; model: string; display_name: string; visible: boolean }
export interface ModelTarget { provider: string; provider_name: string; models: string[]; image_models: string[] }
export interface ModelBranding { models: ModelDisplayName[]; targets: ModelTarget[] }
export async function listModelDisplayNames() { return studioRequest<ModelBranding>('/admin/model-names') }
export async function saveModelDisplayNames(models: ModelDisplayName[]) { return studioRequest<ModelBranding>('/admin/model-names', 'POST', { models }) }
