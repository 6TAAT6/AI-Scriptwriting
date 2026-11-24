import { fail } from './accounts.mjs'

const SESSION = /^[A-Za-z0-9_-]{1,128}$/
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/
const TARGETS = new Set(['requirement', 'bible'])
const ACTIONS = new Set(['add', 'update', 'cancel', 'restore', 'pin', 'unpin', 'lasting', 'local', 'retire', 'revert', 'history', 'confirm', 'reject'])

function scope(body, extra) {
  const allowed = new Set(['session_id', 'project_id', 'standalone', ...extra])
  if (!body || typeof body !== 'object' || Object.keys(body).some(key => !allowed.has(key))
    || typeof body.session_id !== 'string' || !SESSION.test(body.session_id)
    || (body.project_id !== undefined && body.project_id !== null && (typeof body.project_id !== 'string' || !PROJECT.test(body.project_id)))
    || (body.standalone !== undefined && typeof body.standalone !== 'boolean')) {
    fail(400, '创作资料请求只支持当前会话及其项目标识。')
  }
  return { session_id: body.session_id, ...(body.project_id ? { project_id: body.project_id } : {}), ...(body.standalone ? { standalone: true } : {}) }
}

async function forward(service, user, path, payload, authorize) {
  authorize()
  await service.session(user, payload.session_id)
  authorize()
  const transport = await service.transport(user)
  authorize()
  const url = new URL(path, transport.endpoint)
  url.searchParams.set('profile', transport.profile)
  const response = await fetch(url, { method: 'POST', headers: {
    'X-Hermes-Session-Token': transport.token, 'Content-Type': 'application/json'
  }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000), redirect: 'error' })
  const data = await response.json().catch(() => null)
  authorize()
  if (response.status === 400) fail(400, typeof data?.detail === 'string' ? data.detail : '创作资料修改未通过校验。')
  if (!response.ok || data?.ok !== true) fail(response.status === 404 ? 404 : 503, response.status === 404 ? '对话不存在。' : '暂时无法读取创作资料，请稍后重试。')
  return data
}

/** 读取当前会话所属创作范围的要求清单与设定库；范围由账号运行时按会话和项目解析。 */
export async function creativeMemory(service, user, body, authorize) {
  return forward(service, user, '/api/studio/creative-memory', scope(body, []), authorize)
}

/** 用户本人对要求或设定的编辑；正文长度与字段由后端按同一规则校验。 */
export async function editCreativeMemory(service, user, body, authorize) {
  const payload = scope(body, ['target', 'action', 'data'])
  if (!TARGETS.has(body.target) || !ACTIONS.has(body.action) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)
    || JSON.stringify(body.data).length > 20_000) {
    fail(400, '创作资料修改参数不正确。')
  }
  return forward(service, user, '/api/studio/creative-memory/edit', { ...payload, target: body.target, action: body.action, data: body.data }, authorize)
}
