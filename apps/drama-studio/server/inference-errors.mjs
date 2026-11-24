const MESSAGES = {
  request_invalid: '创作请求参数不正确，请检查模型选项或重新打开对话。',
  model_not_allowed: '当前接入不支持所选模型，请切换到可用模型。',
  request_unauthorized: '创作请求验证已失效，请重新连接。',
  request_forbidden: '当前创作请求不符合接入权限要求。',
  request_not_found: '创作请求地址不存在，请重新连接。',
  request_method_not_allowed: '此创作接口不支持当前请求方式。',
  request_conflict: '创作接入状态已变化，请重新连接后继续。',
  request_too_large: '本次创作请求过大，请减少附件或分段提交。',
  queue_full: '当前账号的创作请求较多，等待队列已满，请稍后重试。',
  queue_timeout: '等待其他创作请求结束超时，请稍后继续。',
  provider_rate_limited: '模型服务返回限流，请稍后重试。',
  request_cancelled: '这次创作请求已取消。',
  provider_first_response_timeout: '模型长时间未开始返回内容，本次等待已超时，请稍后继续。',
  provider_idle_timeout: '模型响应长时间没有新数据，本次连接已超时，已返回的内容会保留。',
  provider_total_timeout: '本次模型请求已达到最长等待时间，请分段继续。',
  context_length_exceeded: '本次资料超过模型上下文限制，请精简资料或压缩对话后继续。',
  provider_authentication_failed: '模型接入认证失败，请管理员检查接入配置。',
  provider_response_schema_rejected: '模型服务未接受本次结构化输出格式。',
  provider_request_rejected: '模型服务未接受本次请求，请查看后台诊断记录。',
  provider_unavailable: '创作模型服务暂时不可用，请稍后重试。',
  provider_stream_incomplete: '模型连接结束时没有完整回执，已返回的内容会保留。',
  provider_connection_failed: '暂时无法连接模型服务，请稍后重试。'
}

// 字段名不是安全边界：供应商可能把正文放进 code/type，只记录已知枚举。
const diagnosticEnums = {
  upstreamCode: new Set(['context_length_exceeded', 'invalid_api_key', 'invalid_request_error', 'rate_limit_exceeded',
    'insufficient_quota', 'model_not_found', 'content_filter', 'server_error', 'internal_server_error',
    'service_unavailable', 'upstream_overloaded', 'overloaded_error']),
  upstreamType: new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error',
    'rate_limit_error', 'insufficient_quota', 'api_error', 'server_error', 'overloaded_error', 'gateway_error']),
  causeCode: new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']),
  causeName: new Set(['Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError', 'ConnectTimeoutError',
    'HeadersTimeoutError', 'BodyTimeoutError', 'SocketError', 'RequestAbortedError']),
  causeSyscall: new Set(['connect', 'read', 'write', 'getaddrinfo', 'getnameinfo', 'send', 'recv']),
}

function safeDiagnosticFields(values) {
  const fields = {}
  for (const [name, allowed] of Object.entries(diagnosticEnums)) {
    if (allowed.has(values[name])) fields[name] = values[name]
  }
  if (Number.isSafeInteger(values.causeErrno)) fields.causeErrno = values.causeErrno
  return fields
}

export function inferenceError(status, code, upstreamStatus, details = {}) {
  return Object.assign(new Error(code), { status, code, ...(upstreamStatus ? { upstreamStatus } : {}), ...details })
}

const incompleteReasons = new Set(['max_output_tokens', 'content_filter'])
const responseEvents = new Set(['response.completed', 'response.incomplete', 'response.failed', 'response.error', 'error'])

export function expectedIncompleteResponse(data) {
  const response = data?.response ?? data
  return (!data?.type || data.type === 'response.incomplete') && response?.status === 'incomplete'
    && !data?.error && !response.error && incompleteReasons.has(response.incomplete_details?.reason)
}

// OpenRouter 在余额不够覆盖进行中的请求时返回 402 in_flight_budget_exhausted（带 Retry-After），
// 等这些请求结束即可恢复，按限流转发给员工进程以便重试；余额真正耗尽返回的是其他 402，仍按拒绝处理。
export function admissionRetryAfter(status, data) {
  const metadata = data?.error?.metadata
  if (status !== 402 || metadata?.reason !== 'in_flight_budget_exhausted') return null
  const delay = Number(metadata.headers?.['Retry-After'])
  return Number.isFinite(delay) && delay > 0 ? delay : 0
}

export function upstreamFailure(status, data) {
  const error = data?.error || data?.response?.error || {}
  const detail = String(error.code || error.type || '') + ' ' + String(error.message || '')
  const response = data?.response ?? data
  // 只保留有限状态，供应商原始错误和未知 reason 可能包含请求正文或凭据。
  const diagnostic = {
    ...(responseEvents.has(data?.type) ? { upstreamEventType: data.type } : {}),
    ...(incompleteReasons.has(response?.incomplete_details?.reason) ? { upstreamIncompleteReason: response.incomplete_details.reason } : {}),
    ...safeDiagnosticFields({ upstreamCode: error.code, upstreamType: error.type })
  }
  const failure = (httpStatus, code) => Object.assign(inferenceError(httpStatus, code, status), diagnostic)
  if (/context_length|context.window|maximum context|token.{0,30}(?:exceed|limit)/i.test(detail)) return failure(400, 'context_length_exceeded')
  if (status === 401 || status === 403) return failure(status, 'provider_authentication_failed')
  if (status === 429) return failure(429, 'provider_rate_limited')
  if ((status === 400 || status === 422)
    && [error.code, error.type].some(value => value === 'content_filter' || value === 'content_policy_violation')) {
    return failure(status, 'provider_request_rejected')
  }
  // 员工代理只传固定分类，使辅助调用可按原流程有界重试；不转发含凭据或正文的上游错误。
  const formatField = /\bresponse_format\b|\bresponse_schema\b|\bresponse_json_schema\b|\bresponse(?:Json)?Schema\b/i
  const formatRejected = formatField.test(String(error.param || '')) || (formatField.test(detail)
    && /unsupported|not.support|unknown (?:name|field)|invalid|cannot|str type expected|not.permitted|unavailable/i.test(detail))
  if ((status === 400 || status === 422) && formatRejected) return failure(status, 'provider_response_schema_rejected')
  if (status >= 400 && status < 500) return failure(status, 'provider_request_rejected')
  if ((!data?.type || data.type === 'response.incomplete') && response?.status === 'incomplete' && !data?.error && !response.error) return failure(502, 'provider_stream_incomplete')
  return failure(502, 'provider_unavailable')
}

export function publicInferenceError(error, requestId) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'provider_unavailable'
  return { error: { type: 'studio_inference_error', code, message: MESSAGES[code], request_id: requestId } }
}

export function inferenceDiagnostic(error, context) {
  return { event: 'studio.inference.failure', ...context, status: error.status || 502,
    code: Object.hasOwn(MESSAGES, error.code) ? error.code : 'provider_unavailable',
    ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(responseEvents.has(error.upstreamEventType) ? { upstreamEventType: error.upstreamEventType } : {}),
    ...(incompleteReasons.has(error.upstreamIncompleteReason) ? { upstreamIncompleteReason: error.upstreamIncompleteReason } : {}),
    ...safeDiagnosticFields(error) }
}

export function transportCause(error) {
  const cause = error?.cause
  if (!cause || typeof cause !== 'object') return {}
  return safeDiagnosticFields({ causeCode: cause.code, causeName: cause.name, causeSyscall: cause.syscall, causeErrno: cause.errno })
}
