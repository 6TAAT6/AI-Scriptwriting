import { fail } from './accounts.mjs'
import { supportedEfforts } from './reasoning.mjs'

export function validateModelSelection(backend, user, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['model', 'provider', 'reasoning_effort'].includes(key))) fail(400, '请选择已接入的文字模型。')
  const { model, provider, reasoning_effort: effort } = value
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/.test(model)
    || typeof provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/.test(provider)) fail(400, '模型选择格式不正确。')
  const catalog = backend.catalogs.get(user.id)
  const row = catalog?.providers.find(row => row.slug === provider || row.aliases?.includes(provider))
  if (!row?.models?.includes(model) || !/^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/.test(row.slug)) fail(403, '请选择当前账号已接入的文字模型。')
  if (effort !== undefined && !supportedEfforts(catalog, { model, provider: row.slug }).includes(effort)) fail(400, '所选模型不支持这个思考档位。')
  return { model, provider: row.slug, ...(effort !== undefined ? { reasoning_effort: effort } : {}) }
}

export function nativeModelRpc(call) {
  if (call.method !== 'config.set' || call.params.key !== 'model') return call
  const target = call.params.value
  // 只从验证过的目录选择构造原生参数，不接受客户端原始命令或全局设置。
  const value = `${target.model} --provider ${target.provider} --session${target.reasoning_effort ? ` --reasoning ${target.reasoning_effort}` : ''}`
  return { ...call, params: { ...call.params, value, confirm_expensive_model: true } }
}

export function modelSwitchReceipt(call, frame) {
  if (call.method !== 'config.set' || call.params.key !== 'model' || frame.error) return frame
  const result = frame.result || {}, target = call.params.value
  const runtime = result.info && typeof result.info === 'object' && !Array.isArray(result.info) ? result.info : null
  // 请求值本身不能证明工作进程已经采用新模型。原生网关必须返回
  // session.info 快照，否则边缘层会根据客户端自己的选择伪造成功标记。
  if (result.confirm_required || result.key !== 'model' || result.value !== target.model || result.scope && result.scope !== 'session'
    || !runtime || runtime.model !== target.model || typeof runtime.provider !== 'string' || !runtime.provider) {
    return { jsonrpc: '2.0', id: frame.id, error: { code: 503, message: '模型切换尚未确认，请重新打开对话核对。' } }
  }
  return { ...frame, result: { ...result, info: runtime } }
}

export function sessionReceipt(call, frame) {
  if (!['session.create', 'session.resume'].includes(call.method) || frame.error || !frame.result?.session_id) return frame
  const stored = frame.result.stored_session_id || frame.result.session_key
  if (typeof stored !== 'string' || !stored) return frame
  return { ...frame, result: { ...frame.result, stored_session_id: stored } }
}
