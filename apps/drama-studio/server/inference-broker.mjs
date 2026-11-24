import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { geminiImageRequest, geminiImageData } from './gemini-images.mjs'
import { geminiStructuredRequest } from './gemini-schema.mjs'
import { once } from 'node:events'
import { chmod } from 'node:fs/promises'
import { InferenceQueue } from './inference-queue.mjs'
import { inferenceDeadline, inferenceTimeouts } from './inference-deadline.mjs'
import { inferenceError, upstreamFailure, publicInferenceError, inferenceDiagnostic, expectedIncompleteResponse, transportCause, admissionRetryAfter } from './inference-errors.mjs'

const BODY_LIMIT = 8 * 1024 * 1024
// 截图会作为原生视觉内容保留在会话中，输入预算包含图片的 base64 开销。
const REQUEST_LIMIT = 32 * 1024 * 1024
const OUTPUT_LIMIT = 131072
// Gemini 输出上限为 65536；codex2api 对更大的 max_tokens 直接回 400（2026-11-17 员工 400 根因）。
const GEMINI_OUTPUT_LIMIT = 65536
const defaultOutputLimit = model => /gemini/i.test(model) ? GEMINI_OUTPUT_LIMIT : OUTPUT_LIMIT
const CONCURRENCY = 10
const QUEUE_CAPACITY = 40
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const requestCodes = { 400: 'request_invalid', 401: 'request_unauthorized', 403: 'request_forbidden',
  404: 'request_not_found', 405: 'request_method_not_allowed', 409: 'request_conflict', 413: 'request_too_large' }
const fail = (status, code = requestCodes[status] || 'provider_unavailable') => { throw inferenceError(status, code) }
const equal = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
const commonFields = ['model', 'stream', 'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls', 'metadata', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'n', 'logprobs', 'top_logprobs', 'reasoning_effort', 'reasoning', 'stream_options', 'store', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention']
const routeFields = {
  '/images/generations': new Set(['model', 'prompt', 'n', 'size', 'quality', 'output_format']),
  '/chat/completions': new Set([...commonFields, 'messages', 'response_format', 'functions', 'function_call', 'verbosity']),
  '/responses': new Set([...commonFields, 'input', 'instructions', 'text', 'truncation', 'include'])
}

function validateBody(body, route, models, defaultModel, cacheScope) {
  if (!object(body) || Object.keys(body).some(key => !routeFields[route].has(key))) fail(400)
  const model = body.model ?? defaultModel
  if (typeof model !== 'string' || !models.includes(model)) fail(403, 'model_not_allowed')
  if (route === '/images/generations') {
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000 || body.n !== undefined && body.n !== 1) fail(400)
    if (body.size !== undefined && !['1024x1024', '1536x1024', '1024x1536'].includes(body.size)) fail(400)
    if (body.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(body.quality)) fail(400)
    if (body.output_format !== undefined && body.output_format !== 'png') fail(400)
    return { ...body, model, n: 1 }
  }
  for (const field of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) {
    if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1 || body[field] > OUTPUT_LIMIT)) fail(400)
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail(400)
  if (body.n !== undefined && body.n !== 1) fail(400)
  if (body.store !== undefined && body.store !== false) fail(400)
  if (body.prompt_cache_key !== undefined && (typeof body.prompt_cache_key !== 'string' || body.prompt_cache_key.length > 256)) fail(400)
  if (body.prompt_cache_retention !== undefined && !['in_memory', '24h'].includes(body.prompt_cache_retention)) fail(400)
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128 || body.tools.some(tool => !object(tool) || tool.type !== 'function' || (route === '/chat/completions' ? !object(tool.function) : typeof tool.name !== 'string')))) fail(403)
  if (body.functions !== undefined && (!Array.isArray(body.functions) || body.functions.some(tool => !object(tool) || typeof tool.name !== 'string'))) fail(400)
  // 账号只能使用本次请求中携带的数据，不能借供应商持久化对象访问其他会话。
  const inspectInput = value => {
    if (Array.isArray(value)) { for (const item of value) inspectInput(item); return }
    if (!object(value)) return
    if (value.file_id || value.type === 'item_reference' || value.type === 'computer_call' || value.type === 'computer_call_output') fail(403)
    for (const [key, item] of Object.entries(value)) if (!['arguments', 'output', 'content', 'text'].includes(key) || typeof item !== 'string') inspectInput(item)
  }
  inspectInput(body.messages ?? body.input)
  const outputField = route === '/responses' ? 'max_output_tokens' : 'max_tokens'
  const hasOutputLimit = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'].some(key => body[key] !== undefined)
  return { ...body, model, store: false, ...(body.prompt_cache_key ? { prompt_cache_key: cacheScope + ':' + body.prompt_cache_key } : {}), ...(!hasOutputLimit ? { [outputField]: defaultOutputLimit(model) } : {}) }
}

async function readBody(req) {
  const declared = Number(req.headers['content-length'])
  if (declared > REQUEST_LIMIT) { req.resume(); fail(413) }
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > REQUEST_LIMIT) fail(413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail(400) }
}

const upstreamError = data => object(data) && !expectedIncompleteResponse(data) && (Boolean(data.error)
  || ['error', 'response.failed', 'response.incomplete', 'response.error'].includes(data.type)
  || ['failed', 'incomplete'].includes((data.response ?? data).status)
  || object(data.response) && Boolean(data.response.error))
const chatReceipt = data => Array.isArray(data?.choices) && data.choices.some(choice => object(choice)
  && (object(choice.message) && (typeof choice.message.content === 'string' || typeof choice.message.refusal === 'string' || Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0)
    || object(choice.delta) && (Object.keys(choice.delta).length > 0 || typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0)))
const responsesReceipt = data => object(data) && ['completed', 'incomplete'].includes(data.status) && Array.isArray(data.output)
async function boundedResponse(upstream, limit = BODY_LIMIT, progress = () => {}) {
  if (!upstream.body) fail(502)
  const reader = upstream.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks).toString('utf8')
      progress()
      size += value.length
      if (size > limit) fail(502)
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
}
async function write(res, chunk, signal) {
  if (res.destroyed) throw new Error('创作连接已关闭。')
  // 断线、撤销或超时后不会再有 drain，必须同时解除背压等待并归还并发名额。
  if (!res.write(chunk)) await once(res, 'drain', { signal })
}

async function streamResponse(upstream, res, signal, progress, redact = [], observe = () => {}) {
  const reader = upstream.body.getReader(), decoder = new TextDecoder()
  let pending = '', completed = false
  const projectEvent = async event => {
    const lines = event.split('\n')
    const dataText = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    const eventTypes = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim())
    let data
    if (dataText && dataText !== '[DONE]') { try { data = JSON.parse(dataText) } catch { throw new Error('创作流格式不正确。') } }
    const incomplete = expectedIncompleteResponse(data)
    const expectedIncomplete = incomplete && data.type === 'response.incomplete' && object(data.response)
      && eventTypes.every(type => type === 'response.incomplete')
    const errorEvent = eventTypes.find(type => ['error', 'response.failed', 'response.error'].includes(type)
      || type === 'response.incomplete' && !expectedIncomplete)
    if (errorEvent || upstreamError(data) || incomplete && !expectedIncomplete) {
      const type = errorEvent || eventTypes.at(-1) || data?.type
      throw upstreamFailure(upstream.status, type ? { ...data, type } : data, { redact })
    }
    observe(data)
    // 长度上限和内容过滤由原生适配器处理，不能改成服务故障或伪装成 completed。
    completed ||= dataText === '[DONE]' || data?.type === 'response.completed'
      || expectedIncomplete
      || Array.isArray(data?.choices) && data.choices.some(choice => typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0)
    // 不转发供应商的调试注释与事件ID；正常模型JSON保持原文。
    const allowed = lines.filter(line => /^(?:event|data):/.test(line))
    if (allowed.length) await write(res, allowed.join('\n') + '\n\n', signal)
    else if (lines.some(line => line.startsWith(':'))) await write(res, ': keepalive\n\n', signal)
    return true
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (!done) progress()
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      if (pending.length > BODY_LIMIT) throw new Error('创作流内容过大。')
      let boundary
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        if (!await projectEvent(event)) return
      }
      if (done) {
        if (pending.trim() && !await projectEvent(pending)) return
        // 网络层正常关闭不代表模型正常完成，必须保留半截正文后的失败信号。
        if (!completed) throw inferenceError(502, 'provider_stream_incomplete')
        return
      }
    }
  } finally { await reader.cancel().catch(() => {}) }
}

function providerSettings({ baseUrl, apiKey, models, defaultModel, apiMode, imageModels = [], imageModel = '', modelMetadata = {}, id = 'primary', name = '团队默认模型' }) {
  let upstreamBase
  try { upstreamBase = new URL(baseUrl) } catch { throw new Error('创作模型服务地址无效。') }
  if (!['http:', 'https:'].includes(upstreamBase.protocol) || upstreamBase.username || upstreamBase.password || upstreamBase.search || upstreamBase.hash) throw new Error('创作模型服务地址无效。')
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) throw new Error('创作模型凭证无效。')
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('创作模型标识无效。')
  if (!Array.isArray(models) || !models.length || models.length > 100 || models.some(model => typeof model !== 'string' || !model || model.length > 256) || !models.includes(defaultModel)) throw new Error('创作模型目录无效。')
  if (!['chat_completions', 'responses'].includes(apiMode)) throw new Error('创作模型协议无效。')
  if (!Array.isArray(imageModels) || imageModels.length > 30 || imageModels.some(value => typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/.test(value)) || imageModel && !imageModels.includes(imageModel)) throw new Error('图片模型目录无效。')
  const metadata = {}
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (!object(modelMetadata)) throw new Error('模型能力配置无效。')
  for (const [model, entry] of Object.entries(modelMetadata)) {
    if (!models.includes(model) || !object(entry) || Object.keys(entry).some(key => !['context_length', 'supported_efforts', 'default_reasoning_effort'].includes(key))) throw new Error('模型能力配置无效。')
    if (entry.context_length !== undefined && (!Number.isSafeInteger(entry.context_length) || entry.context_length <= 0)) throw new Error('模型上下文配置无效。')
    if (entry.supported_efforts !== undefined && (!Array.isArray(entry.supported_efforts) || entry.supported_efforts.some(level => !efforts.includes(level)))) throw new Error('模型思考档位配置无效。')
    if (entry.default_reasoning_effort !== undefined && !entry.supported_efforts?.includes(entry.default_reasoning_effort)) throw new Error('默认思考档位不在允许范围内。')
    metadata[model] = structuredClone(entry)
  }
  return { upstreamBase, apiKey, models: [...new Set(models)], defaultModel, apiMode, imageModels: [...new Set(imageModels)], imageModel, modelMetadata: metadata, id, name: String(name).slice(0, 80) }
}

/** 供应商密钥只存在于此父进程闭包；工作进程只获得账号限定的本机凭证。 */
export async function createInferenceBroker({ host = '127.0.0.1', port = 0, unixSocket, providers = [], timeouts, onDiagnostic = row => console.warn('STUDIO_INFERENCE ' + JSON.stringify(row)), ...primary }) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('创作模型监听地址无效。')
  const timeoutSettings = inferenceTimeouts(timeouts)
  const coverageStartedAt = new Date().toISOString()
  let revision = 1
  let destinations = new Map([['primary', { ...providerSettings({ ...primary, id: 'primary' }), revision }]])
  const activeRequests = new Map()
  const samePolicy = (left, right) => left && left.upstreamBase.href === right.upstreamBase.href && left.apiKey === right.apiKey
    && left.apiMode === right.apiMode && left.defaultModel === right.defaultModel
    && left.models.length === right.models.length && left.models.every(model => right.models.includes(model))
    && left.imageModel === right.imageModel && left.imageModels.length === right.imageModels.length && left.imageModels.every(model => right.imageModels.includes(model))
    && JSON.stringify(left.modelMetadata) === JSON.stringify(right.modelMetadata)
  const updateProviders = (values, nextPrimary) => {
    if (!Array.isArray(values) || values.length > 30) throw new Error('创作模型接入数量无效。')
    const entries = values.map(providerSettings)
    if (entries.some(row => row.id === 'primary') || new Set(entries.map(row => row.id)).size !== entries.length) throw new Error('创作模型接入标识重复。')
    const rows = [nextPrimary ? providerSettings({ ...nextPrimary, id: 'primary' }) : destinations.get('primary'), ...entries]
    const next = new Map(rows.map(row => [row.id, { ...row, revision: samePolicy(destinations.get(row.id), row) ? destinations.get(row.id).revision : ++revision }]))
    destinations = next
    // 接入被移除、权限变化或密钥轮换必须同时撤销正在等待上传与已发出的旧请求。
    for (const [controller, request] of activeRequests) if (next.get(request.providerId)?.revision !== request.revision) controller.abort()
  }
  updateProviders(providers)
  const scopes = new Map(), paths = new Map()
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)) }
  const handler = async (req, res) => {
    let scope, controller, timer, releaseSlot, deadline, model, providerId, endpoint, began, destination
    let responseIdHash
    let validReceipt = false
    const requestId = randomUUID()
    // 只关联上游响应标识的指纹，供应商正文及原始 ID 不进入诊断。
    const observeResponse = data => {
      const id = data?.response?.id ?? (Array.isArray(data?.choices) || data?.object === 'response' ? data?.id : undefined)
      if (typeof id === 'string' && id && id.length <= 1024) responseIdHash = createHash('sha256').update(id).digest('hex')
      validReceipt ||= endpoint === '/chat/completions' ? chatReceipt(data) : endpoint === '/responses' && responsesReceipt(data?.response ?? data)
    }
    try {
      const url = new URL(req.url, 'http://localhost')
      const match = url.pathname.match(/^\/scope\/([A-Za-z0-9_-]{32})\/v1(\/models|\/chat\/completions|\/responses|\/images\/generations)$/)
      if (!match || url.search) fail(404)
      const route = paths.get(match[1])
      scope = route?.account
      if (!scope || !equal(req.headers.authorization, 'Bearer ' + scope.token)) fail(401)
      destination = destinations.get(route.providerId)
      if (!destination) fail(403)
      if (req.headers.origin || req.headers['sec-fetch-site']) fail(403)
      if (req.method === 'GET' && match[2] === '/models') { json(res, 200, { object: 'list', data: destination.models.map(id => ({ id, object: 'model', owned_by: 'studio' })) }); return }
      if (req.method !== 'POST' || !Object.hasOwn(routeFields, match[2])) fail(405)
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(400)
      if (scope.controllers.size >= CONCURRENCY + QUEUE_CAPACITY) throw Object.assign(new Error('queue_full'), { status: 429, code: 'queue_full' })
      controller = new AbortController(); scope.controllers.add(controller)
      activeRequests.set(controller, { providerId: route.providerId, revision: destination.revision })
      timer = setTimeout(() => { controller.abort(); req.destroy() }, 30_000); timer.unref()
      res.once('close', () => { if (!res.writableFinished) controller.abort() })
      const rawBody = await readBody(req)
      clearTimeout(timer)
      if (paths.get(match[1]) !== route) fail(401)
      const current = destinations.get(route.providerId)
      if (!current || current.revision !== destination.revision || controller.signal.aborted) fail(409)
      const imageRequest = match[2] === '/images/generations'
      const { upstreamBase, apiKey } = current
      const modelList = imageRequest ? current.imageModels : current.models
      const defaultModel = imageRequest ? current.imageModel : current.defaultModel
      const body = validateBody(rawBody, match[2], modelList, defaultModel, scope.id)
      model = body.model; providerId = route.providerId; endpoint = match[2]
      releaseSlot = await scope.queue.acquire(controller.signal)
      if (paths.get(match[1]) !== route || controller.signal.aborted) fail(409)
      if (destinations.get(route.providerId)?.revision !== destination.revision) fail(409)
      began = Date.now()
      deadline = inferenceDeadline(controller, timeoutSettings, imageRequest)
      let target = new URL(upstreamBase); target.pathname = upstreamBase.pathname.replace(/\/+$/, '') + match[2]
      let payload = geminiStructuredRequest(body, match[2], upstreamBase)
      const geminiImage = imageRequest && body.model.startsWith('gemini-')
      if (geminiImage) { const native = geminiImageRequest(upstreamBase, body); target = native.target; payload = native.body }
      const upstream = await fetch(target, { method: 'POST', headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: controller.signal })
      deadline.responseStarted(body.stream === true)
      if (!upstream.ok) {
        let details
        try { details = JSON.parse(await boundedResponse(upstream, 16384, deadline.progress)) } catch { details = null }
        const admission = admissionRetryAfter(upstream.status, details)
        if (upstream.status === 429 || admission !== null) {
          const delay = Number(upstream.headers.get('retry-after')) || admission
          res.setHeader('Retry-After', String(Number.isFinite(delay) && delay > 0 ? Math.min(120, Math.ceil(delay)) : 5))
          throw upstreamFailure(429, details, { redact: [apiKey] })
        }
        throw upstreamFailure(upstream.status, details, { redact: [apiKey] })
      }
      if (body.stream) {
        if (!upstream.headers.get('content-type')?.startsWith('text/event-stream') || !upstream.body) { await upstream.body?.cancel(); fail(502) }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        await streamResponse(upstream, res, controller.signal, deadline.progress, [apiKey], observeResponse); res.end()
      } else {
        const text = await boundedResponse(upstream, imageRequest ? 36 * 1024 * 1024 : BODY_LIMIT, deadline.progress)
        let data; try { data = JSON.parse(text) } catch { fail(502) }
        if (upstreamError(data)) throw upstreamFailure(upstream.status, data, { redact: [apiKey] })
        observeResponse(data)
        if (imageRequest) {
          if (geminiImage) data = geminiImageData(data)
          const encoded = data.data?.[0]?.b64_json
          if (typeof encoded !== 'string' || !encoded || encoded.length > 34 * 1024 * 1024) fail(502)
          validReceipt = true
          json(res, 200, { data: [{ b64_json: encoded }] })
        } else json(res, 200, data)
      }
      const observation = { schemaVersion: 2, coverageStartedAt, requestId, account: scope.profile, model, providerId, route: endpoint,
        elapsedMs: Date.now() - began, timestamp: new Date().toISOString(), ...(responseIdHash ? { responseIdHash } : {}) }
      // 转发兼容原有协议处理；HTTP 200 空对象或空流不能提升为权威成功。
      onDiagnostic(validReceipt ? { event: 'studio.inference.success', ...observation }
        : inferenceDiagnostic(inferenceError(502, 'provider_unavailable', 200), observation))
    } catch (error) {
      if (controller?.signal.aborted && controller.signal.reason?.code) error = controller.signal.reason
      if (!error.status && error.name === 'TypeError') error = inferenceError(502, 'provider_connection_failed', undefined, transportCause(error, [destination?.apiKey]))
      if (!began && typeof error.code === 'string' && (error.code.startsWith('request_') || error.code === 'model_not_allowed')) {
        onDiagnostic({ event: 'studio.inference.rejected', schemaVersion: 2, coverageStartedAt, requestId,
          ...(scope ? { account: scope.profile } : {}), phase: 'validation', status: error.status,
          code: error.code, timestamp: new Date().toISOString() })
      }
      if (began && (error.status || !controller?.signal.aborted)) {
        // 诊断只输出固定字段；上游错误正文、请求内容、地址和凭据不写入日志。
        onDiagnostic(inferenceDiagnostic(error, { schemaVersion: 2, coverageStartedAt, requestId, account: scope.profile, model, providerId, route: endpoint,
          phase: deadline?.phase, elapsedMs: Date.now() - began, timestamp: new Date().toISOString() }))
      }
      if (res.destroyed) return
      const payload = publicInferenceError(error, requestId)
      if (res.headersSent) { res.end('event: error\ndata: ' + JSON.stringify(payload) + '\n\n'); return }
      if (error.status === 429 && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '5')
      json(res, error.status || 502, payload)
    } finally {
      if (controller) { clearTimeout(timer); activeRequests.delete(controller); scope.controllers.delete(controller) }
      deadline?.stop()
      releaseSlot?.()
    }
  }
  const server = createServer(handler)
  server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.keepAliveTimeout = 5000
  server.listen(port, host); await once(server, 'listening')
  let unixServer
  if (unixSocket) {
    unixServer = createServer(handler)
    unixServer.headersTimeout = 10_000; unixServer.requestTimeout = 30_000; unixServer.keepAliveTimeout = 5000
    try {
      unixServer.listen(unixSocket); await once(unixServer, 'listening'); await chmod(unixSocket, 0o600)
    } catch (error) {
      await Promise.all([server, unixServer].map(listener => new Promise(resolve => listener.close(resolve))))
      throw error
    }
  }
  const address = server.address(), publicBase = `http://${host.includes(':') ? '[' + host + ']' : host}:${address.port}`
  const revoke = profile => {
    const scope = scopes.get(profile)
    if (!scope) return
    scopes.delete(profile)
    for (const route of scope.routes.values()) paths.delete(route.id)
    for (const controller of scope.controllers) controller.abort()
  }
  return {
    baseUrl: publicBase,
    unixSocket,
    updateProviders,
    scope(profile) {
      if (typeof profile !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile)) throw new Error('员工工作区标识无效。')
      let scope = scopes.get(profile)
      if (!scope) { scope = { profile, id: randomBytes(24).toString('base64url'), token: randomBytes(32).toString('base64url'), queue: new InferenceQueue(CONCURRENCY, QUEUE_CAPACITY), controllers: new Set(), routes: new Map() }; scopes.set(profile, scope) }
      const routes = [...destinations.values()].map(destination => {
        let route = scope.routes.get(destination.id)
        if (!route) { route = { id: randomBytes(24).toString('base64url'), providerId: destination.id, account: scope }; scope.routes.set(destination.id, route); paths.set(route.id, route) }
        return { id: destination.id, name: destination.name, base_url: publicBase + '/scope/' + route.id + '/v1', token: scope.token, model: destination.defaultModel, models: [...destination.models], api_mode: destination.apiMode,
          ...(Object.keys(destination.modelMetadata).length ? { model_metadata: structuredClone(destination.modelMetadata) } : {}),
          ...(destination.imageModel ? { image_models: destination.imageModels, image_model: destination.imageModel } : {}) }
      })
      const { id, name, ...main } = routes[0]
      return { ...main, ...(routes.length > 1 ? { providers: routes.slice(1) } : {}) }
    },
    revoke,
    async close() {
      for (const profile of scopes.keys()) revoke(profile)
      await Promise.all([server, unixServer].filter(Boolean).map(listener => {
        listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve))
      }))
    }
  }
}
