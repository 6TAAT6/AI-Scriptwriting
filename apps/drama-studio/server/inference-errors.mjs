const MESSAGES = {
  queue_full: '当前账号的创作请求较多，等待队列已满，请稍后重试。',
  queue_timeout: '等待其他创作请求结束超时，请稍后继续。',
  provider_rate_limited: '模型服务返回限流，请稍后重试。',
  request_cancelled: '这次创作请求已取消。',
  provider_first_response_timeout: '模型长时间未开始返回内容，本次等待已超时，请稍后继续。',
  provider_idle_timeout: '模型响应长时间没有新数据，本次连接已超时，已返回的内容会保留。',
  provider_total_timeout: '本次模型请求已达到最长等待时间，请分段继续。',
  context_length_exceeded: '本次资料超过模型上下文限制，请精简资料或压缩对话后继续。',
  provider_authentication_failed: '模型接入认证失败，请管理员检查接入配置。',
  provider_request_rejected: '模型服务未接受本次请求，请查看后台诊断记录。',
  provider_unavailable: '创作模型服务暂时不可用，请稍后重试。',
  provider_stream_incomplete: '模型连接结束时没有完整回执，已返回的内容会保留。',
  provider_connection_failed: '暂时无法连接模型服务，请稍后重试。'
}

export function inferenceError(status, code, upstreamStatus) {
  return Object.assign(new Error(code), { status, code, ...(upstreamStatus ? { upstreamStatus } : {}) })
}

export function upstreamFailure(status, data) {
  const error = data?.error || data?.response?.error || {}
  const detail = String(error.code || error.type || '') + ' ' + String(error.message || '')
  if (/context_length|context.window|maximum context|token.{0,30}(?:exceed|limit)/i.test(detail)) return inferenceError(400, 'context_length_exceeded', status)
  if (status === 401 || status === 403) return inferenceError(status, 'provider_authentication_failed', status)
  if (status === 429) return inferenceError(429, 'provider_rate_limited', status)
  if (status >= 400 && status < 500) return inferenceError(status, 'provider_request_rejected', status)
  return inferenceError(502, 'provider_unavailable', status)
}

export function publicInferenceError(error, requestId) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'provider_unavailable'
  return { error: { type: 'studio_inference_error', code, message: MESSAGES[code], request_id: requestId } }
}

export function inferenceDiagnostic(error, context) {
  return { event: 'studio.inference.failure', ...context, status: error.status || 502,
    code: Object.hasOwn(MESSAGES, error.code) ? error.code : 'provider_unavailable',
    ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }
}
