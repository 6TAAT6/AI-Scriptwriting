const statusTexts = {
  preparing: '正在准备创作。', thinking: '正在思考。', generating: '正在生成。',
  compacting: '正在压缩会话上下文。', compressing: '正在压缩会话上下文。', compacted: '会话上下文已压缩。',
  retrying: '正在重试。', waiting: '正在等待。', process: '后台任务状态已更新。',
  goal: '任务目标状态已更新。', loop: '循环任务状态已更新。', heartbeat: '后台检查状态已更新。',
  ready: '已就绪。', status: '正在处理请求。', lifecycle: '正在准备下一步。', warn: '创作服务状态有变化。'
}

// 状态诊断可能带供应商原始错误；只保留公开语义，不转发诊断正文。
export function publicStatus(value) {
  const kind = Object.hasOwn(statusTexts, value.kind) ? value.kind : 'status'
  const text = typeof value.text === 'string' ? value.text : ''
  const meanings = [
    [/retry|重试/i, '正在重试。'],
    [/fallback|falling back|回退/i, '正在使用备用处理方式。'],
    [/compress|compact|压缩/i, statusTexts.compacting],
    [/reconnect|恢复连接|重新连接/i, '正在恢复连接。']
  ]
  return { kind, text: ['lifecycle', 'status', 'warn'].includes(kind) ? meanings.find(([match]) => match.test(text))?.[1] ?? statusTexts[kind] : statusTexts[kind] }
}

export function publicSkillArguments(value) {
  const result = {}
  for (const key of ['name', 'file_path']) {
    const text = value?.[key]
    if (typeof text === 'string' && text.length <= 256 && /^[\p{L}\p{N}_.:/-]+$/u.test(text) && !text.startsWith('/') && !text.split('/').includes('..') && !/^[a-z]:\//i.test(text)) result[key] = text
  }
  return result
}

export function publicSkillSummary(name, args, result) {
  const action = name === 'skills_list' ? '技能列表读取' : args.file_path ? '技能资源读取' : '技能加载'
  const target = [args.name, args.file_path].filter(Boolean).join(' → ')
  return `${action}${result.ok ? '完成' : '失败'}${target ? '：' + target : '。'}`
}

export const subagentFields = ['subagent_id', 'parent_id', 'child_session_id', 'delegation_id', 'task_count', 'task_index', 'depth', 'model', 'tool_count', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'api_calls', 'duration_seconds', 'started_at']
export const subagentStatuses = new Set(['queued', 'running', 'completed', 'failed', 'error', 'timeout', 'interrupted'])
export const displayKinds = new Set(['auto_continue', 'async_delegation_complete', 'process_complete', 'model_switch', 'personality_switch', 'failed_turn'])
export const noticeTexts = { auto_continue: '已恢复中断的创作。', async_delegation_complete: '后台创作任务已结束。', process_complete: '后台任务已结束。', model_switch: '模型已切换。', personality_switch: '助手风格已切换。', failed_turn: '本轮创作未完成，请重试。' }
