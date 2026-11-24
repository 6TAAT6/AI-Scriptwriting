import { randomUUID } from 'node:crypto'
import { fail } from './accounts.mjs'

const fields = new Set(['id', 'name', 'base_url', 'model', 'models', 'api_mode', 'api_key', 'image_model', 'image_models'])
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/.test(value)
const send = (res, data) => { res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)) }
const endpointRow = row => ({ id: String(row.id || ''), name: String(row.name || ''), base_url: String(row.base_url || ''), model: String(row.model || ''), models: Array.isArray(row.models) ? row.models.filter(validModel) : [], image_model: String(row.image_model || ''), image_models: Array.isArray(row.image_models) ? row.image_models.filter(validModel) : [], api_mode: String(row.api_mode || 'chat_completions'), has_api_key: row.has_api_key === true, is_current: row.is_current === true, enabled: row.enabled !== false })

function validate(input) {
  if (!input || Object.keys(input).some(key => !fields.has(key))) fail(400, '请求包含不支持的字段。')
  const text = (field, max) => { const value = input[field]; if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, '模型接入信息不完整或格式不正确。'); return value.trim() }
  const body = { name: text('name', 80), base_url: text('base_url', 2048).replace(/\/+$/, ''), model: text('model', 256), api_mode: input.api_mode }
  if (input.id !== undefined) { if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id)) fail(400, '模型接入标识不正确。'); body.id = input.id }
  let url
  try { url = new URL(body.base_url) } catch { fail(400, '请输入有效的模型服务地址。') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash) fail(400, '模型服务需要 HTTPS 地址；本机服务可使用 HTTP。地址中不能包含凭证或查询参数。')
  if (['zzshu.cc', 'www.zzshu.cc'].includes(url.hostname) && url.pathname.replace(/\/+$/, '') === '/keys') fail(400, '这是密钥管理页面，请将服务地址填写为 https://api.zzshu.cc/v1，再重新检查连接。')
  if (!['chat_completions', 'codex_responses'].includes(body.api_mode)) fail(400, '请选择支持的模型接口协议。')
  if (!validModel(body.model) || !Array.isArray(input.models) || !input.models.length || input.models.length > 100 || input.models.some(value => !validModel(value)) || !input.models.includes(body.model)) fail(400, '请填写有效的模型列表，并将默认模型包含在列表中。')
  body.models = [...new Set(input.models)]
  if (input.image_model !== undefined || input.image_models !== undefined) {
    const models = input.image_models ?? [], model = input.image_model ?? ''
    if (!Array.isArray(models) || models.length > 30 || models.some(value => !validModel(value)) || typeof model !== 'string' || model && !models.includes(model)) fail(400, '请填写有效的图片模型列表和默认图片模型。')
    body.image_models = [...new Set(models)]; body.image_model = model
  }
  if (input.api_key !== undefined) {
    if (typeof input.api_key !== 'string' || !input.api_key.trim() || input.api_key.length > 8192 || /[\x00-\x20\x7f]/.test(input.api_key)) fail(400, 'API Key 格式不正确。编辑时留空可保留已保存的密钥。')
    body.api_key = input.api_key
  }
  if (!body.id && !body.api_key) fail(400, '首次接入需要填写 API Key。')
  return body
}

async function probe(body) {
  if (!body.api_key) fail(400, '连接检查需要重新输入 API Key；留空保存会保留原密钥。')
  let response
  try { response = await fetch(body.base_url + '/models', { headers: { accept: 'application/json', authorization: 'Bearer ' + body.api_key }, signal: AbortSignal.timeout(8000), redirect: 'error' }) }
  catch { return { ok: false, models: [], message: '无法连接模型目录，请检查服务地址和网络。' } }
  // 网页防护层可能先于 API 返回 403；不能据此误报密钥无效，也不回传上游正文。
  const webpage = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') || '')
    || response.headers.get('cf-mitigated') === 'challenge'
  if (webpage || !response.ok) {
    await response.body?.cancel()
    const messages = {
      401: '服务拒绝了 API Key，请检查密钥和权限。',
      403: '模型服务拒绝访问，请检查密钥权限、IP 白名单及站点访问策略；此状态不能单独证明密钥错误。',
      429: '模型服务请求过于频繁或已限流，请稍后重试。'
    }
    return { ok: false, models: [], message: webpage
      ? '服务返回了网页或安全验证页面，尚未验证 API Key。请使用中转站提供的 API 地址，并确认服务器出口可访问。'
      : messages[response.status] || '模型目录未返回成功状态，请检查地址是否包含 /v1。' }
  }
  const chunks = [], reader = response.body?.getReader(); let size = 0
  if (!reader) return { ok: false, models: [], message: '模型目录响应为空。' }
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) fail(502, '模型目录响应过大。'); chunks.push(Buffer.from(value)) }
    const data = JSON.parse(Buffer.concat(chunks).toString())
    const available = (Array.isArray(data.data) ? data.data : []).map(row => row?.id).filter(validModel)
    const models = available.slice(0, 100)
    if (models.length && !available.includes(body.model)) return { ok: false, models, message: `密钥有效，但当前目录未列出默认模型 ${body.model}。请核对型号及分组通道，或选择目录中的模型。` }
    return { ok: models.length > 0, models, message: models.length ? '已验证密钥可读取模型目录。生成能力将在实际创作时验证。' : '服务未返回可用的模型目录。' }
  } catch { return { ok: false, models: [], message: '无法解析模型目录，请检查模型服务协议。' } }
  finally { await reader.cancel().catch(() => {}) }
}

/** 复用 Hermes 配置写入和密钥存储，仅公开必要状态字段。 */
export function createModelSettingsService({ service, store, workerPool, endpointImpact, onChanged }) {
  const authorize = auth => { const current = store.authenticate(auth.token); if (!current) fail(401, '登录已失效，请重新登录。'); if (current.user.role !== 'super_admin') fail(403, '只有超级管理员可以管理模型接入。'); return current.user }
  const call = async (auth, body, route = '/api/studio/model-endpoints') => {
    const user = auth ? authorize(auth) : { profile: 'jubao-drama' }
    const token = await service.token()
    if (auth) authorize(auth)
    const url = new URL(route, service.endpoint); url.searchParams.set('profile', user.profile)
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'X-Hermes-Session-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (!response.ok) {
      // 启停接口的 400/404 说明来自本工作区后端（默认接入、压缩策略等），原样转给管理员；其他错误仍用通用提示。
      const detail = route !== '/api/studio/model-endpoints' && [400, 404].includes(response.status) ? await response.json().then(data => data?.detail, () => undefined) : undefined
      await response.body?.cancel().catch(() => {})
      if (typeof detail === 'string' && detail) fail(response.status, detail)
      fail(503, body ? '模型接入未能保存，请稍后重试。' : '暂时无法读取模型接入信息。')
    }
    const result = await response.json()
    if (auth) authorize(auth)
    return result
  }
  const refresh = async () => { try { await workerPool?.refreshModels?.(); return true } catch { return false } }
  async function toggle(res, auth, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== 'enabled,id'
      || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id) || typeof input.enabled !== 'boolean') fail(400, '请求包含不支持的字段。')
    const existing = (await call(auth)).endpoints?.find(row => row.id === input.id)
    if (!existing) fail(404, '模型接入不存在，请刷新后重试。')
    if (!input.enabled && existing.is_current === true) fail(400, '这是默认接入，员工对话和上下文压缩都依赖它，不能停用。')
    const impact = input.enabled ? {} : (await endpointImpact?.(input.id)) || {}
    if (impact.blocked) fail(400, impact.blocked)
    const saved = await call(auth, { id: input.id, enabled: input.enabled }, '/api/studio/model-endpoints/enabled')
    const refreshed = await refresh()
    onChanged?.()
    authorize(auth)
    const hidden = impact.hidden?.length ? `品牌入口「${impact.hidden.join('」「')}」暂时对员工隐藏，重新启用后恢复。` : ''
    const message = (input.enabled ? `已启用「${existing.name}」，新建对话时可选择。` : `已停用「${existing.name}」，员工新建对话时不再使用它。${hidden}`)
      + (refreshed ? '' : '员工模型目录暂未刷新，请稍后再切换一次。')
    send(res, { ok: true, id: input.id, endpoints: (saved.endpoints || []).map(endpointRow), message })
  }
  return {
    async managedEndpoints() { return (await call(null)).endpoints || [] },
    async handle(req, res, url, auth, input) {
      if (!['/studio/admin/models', '/studio/admin/models/validate', '/studio/admin/models/enabled'].includes(url.pathname)) return false
      authorize(auth)
      if (req.method === 'GET' && url.pathname === '/studio/admin/models') { const result = await call(auth); send(res, { endpoints: (result.endpoints || []).map(endpointRow) }); return true }
      if (req.method !== 'POST') fail(405, '此接口不支持该操作。')
      if (url.pathname === '/studio/admin/models/enabled') { await toggle(res, auth, input); return true }
      const body = validate(input)
      if (url.pathname.endsWith('/validate')) { const result = await probe(body); authorize(auth); send(res, result); return true }
      let makeDefault = false
      if (body.id) {
        const existing = (await call(auth)).endpoints?.find(row => row.id === body.id)
        if (!existing) fail(404, '模型接入不存在，请刷新后重试。')
        makeDefault = existing.is_current === true
        if (!body.api_key && (!existing.has_api_key || existing.base_url.replace(/\/+$/, '') !== body.base_url)) fail(400, '更换服务地址或补全凭证时，请重新填写 API Key。')
      }
      const saved = await call(auth, { ...body, id: body.id || 'studio-' + randomUUID(), discover_models: false, make_default: makeDefault })
      const refreshed = await refresh()
      authorize(auth)
      send(res, { ok: true, id: saved.id, endpoints: (saved.endpoints || []).map(endpointRow), message: refreshed ? '模型接入已保存，新建对话时可选择；正在运行的对话保持当前模型。' : '模型接入已保存，员工模型目录暂未刷新，请稍后重新保存重试。' })
      return true
    }
  }
}
