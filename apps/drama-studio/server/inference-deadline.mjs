/** 总预算与无数据超时分开，持续输出不会撞上固定三分钟截止线。 */
export function inferenceTimeouts(value = {}) {
  const defaults = { firstResponseMs: 600_000, idleMs: 180_000, totalMs: 1_800_000 }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(key in defaults))) throw new Error('模型超时配置字段无效。')
  const result = { ...defaults, ...value }
  if (Object.values(result).some(ms => !Number.isSafeInteger(ms) || ms < 100 || ms > 3_600_000)
      || result.firstResponseMs > result.totalMs || result.idleMs > result.totalMs) throw new Error('模型超时配置范围无效。')
  return result
}

export function inferenceDeadline(controller, settings, imageRequest = false) {
  let timer, streaming = false, phase = 'first_response'
  const abort = code => { if (!controller.signal.aborted) controller.abort(Object.assign(new Error(code), { status: 504, code })) }
  const total = setTimeout(() => abort('provider_total_timeout'), imageRequest ? 300_000 : settings.totalMs)
  total.unref()
  const reset = () => {
    clearTimeout(timer)
    timer = setTimeout(() => abort(phase === 'first_response' ? 'provider_first_response_timeout' : 'provider_idle_timeout'), imageRequest ? 300_000 : streaming ? settings.idleMs : settings.firstResponseMs)
    timer.unref()
  }
  reset()
  return {
    responseStarted(stream) { streaming = stream; phase = stream ? 'stream' : 'response_body'; reset() },
    progress: reset,
    stop() { clearTimeout(timer); clearTimeout(total) },
    get phase() { return phase }
  }
}
