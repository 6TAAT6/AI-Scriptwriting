// 只处理错误表面，不改写用户稿件或正常创作内容。
const errorKinds = [
  [/can't reach|cannot reach|offline|network|failed to fetch|fetch failed|ECONN|ENOTFOUND|connection (?:failed|refused|reset|closed)|连接中断|无法连接/i, '暂时无法连接创作服务，请稍后重试。'],
  [/timed?\s*out|timeout|超时/i, '本次响应等待时间较长，请稍后重试，或缩小本次处理范围。'],
  [/rate.?limit|too many requests|overloaded|繁忙|限流/i, '当前创作请求较多，请稍后重试。'],
  [/context.{0,35}(?:limit|length|exceed)|too many tokens|上下文.{0,15}(?:超|限制)/i, '本次资料较长，请缩小单次处理范围后继续。'],
  [/invalid.?api.?key|authentication|unauthorized|credential/i, '创作服务连接配置暂不可用，请联系管理员检查。'],
]
// 原生推理错误以稳定的 ``failure_reason`` 编码传递，而不是完整句子。
// 对外保留具体原因，同时绝不转发供应商、端点、请求正文或凭证。
const errorCodes = new Map([
  ['provider_first_response_timeout', '模型长时间未开始返回内容，本次等待已超时，请稍后继续。'],
  ['provider_idle_timeout', '模型响应长时间没有新数据，本次连接已超时，已返回的内容会保留。'],
  ['provider_total_timeout', '本次模型请求已达到最长等待时间，请分段继续。'],
  ['provider_connection_failed', '暂时无法连接模型服务，请稍后重试。'],
  ['provider_unavailable', '创作模型服务暂时不可用，请稍后重试。'],
  ['provider_stream_incomplete', '模型连接结束时没有完整回执，已返回的内容会保留。'],
  ['provider_rate_limited', '模型服务返回限流，请稍后重试。'],
  ['provider_authentication_failed', '模型接入认证失败，请管理员检查接入配置。'],
  ['provider_request_rejected', '模型服务未接受本次请求，请稍后重试。'],
  ['context_length_exceeded', '本次资料超过模型上下文限制，请精简资料或压缩对话后继续。'],
])
const internal = /hermes|nous research|litellm|openai|anthropic|codex|provider|api[_ -]?key|traceback|https?:\/\/|(?:\/Users\/|\/home\/)|\bsk-[a-z0-9_-]{10,}/i

export function publicError(value, fallback = '创作服务暂时不可用，请稍后重试。') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  const coded = errorCodes.get(text)
  if (coded) return coded
  if (text.startsWith('消息提交未确认')) return '消息提交状态暂未确认，请重新打开这段对话核实后继续。'
  const known = errorKinds.find(([pattern]) => pattern.test(text))
  if (known) return known[1]
  return /[\u3400-\u9fff]/.test(text) && !internal.test(text) ? text : fallback
}

export function errorEventPayload(type, payload) {
  const result = { ...payload }
  if (type === 'error') result.message = publicError(payload.message ?? payload.error)
  for (const field of ['error', 'failure_reason']) if (payload[field]) result[field] = publicError(payload[field])
  if (type === 'notification.show' && payload.level === 'error') result.text = publicError(payload.text)
  if (type === 'status.update' && ['error', 'warn'].includes(payload.kind)) result.text = publicError(payload.text)
  if (type === 'message.complete' && payload.status === 'error' && internal.test(String(payload.text || ''))) result.text = publicError(payload.text)
  return result
}

export function publicRuntimeFailure(value) {
  const text = typeof value === 'string' ? value : ''
  const heading = text.trim().replace(/^[⚠❌*\s]+/, '')
  return /^(?:Hermes|创作引擎).{0,100}(?:can't|cannot|error|fail|offline|timeout)/i.test(heading)
    || /^Error:.{0,100}(?:Hermes|provider|API|network|timeout)/i.test(heading) ? publicError(text) : text
}
