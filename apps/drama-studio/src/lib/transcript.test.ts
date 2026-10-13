import { describe, expect, it } from 'vitest'
import { historyEntries, reduceEvent, restoreToolReceipts, type Conversation } from './transcript'

describe('剧本对话记录', () => {
  it('保留用户与正文，把相邻工具结果折叠成过程，隐藏内部提示', () => {
    const entries = historyEntries([
      { role: 'system', text: '内部系统提示' },
      { role: 'user', text: '请分析这个故事。' },
      { role: 'user', text: '隐藏的上下文', display_kind: 'hidden' },
      { role: 'assistant', text: '我先阅读原稿。' },
      { role: 'tool', name: 'read_file', tool_call_id: 't1', content: '原稿内容' },
      { role: 'tool', name: 'drama_project_status', tool_call_id: 't2', content: '{"ok":true}' },
      { role: 'assistant', text: '核心期待是家人重逢。' }
    ])
    expect(entries.map(entry => entry.role)).toEqual(['user', 'assistant', 'activity', 'assistant'])
    expect(entries[2].calls.map(call => call.id)).toEqual(['t1', 't2'])
    expect(entries[3].text).toBe('核心期待是家人重逢。')
    expect(entries.flatMap(entry => entry.text)).not.toContain('隐藏的上下文')
  })

  it('按会话隔离流式事件，阶段消息不重复，错误结束保留已生成正文', () => {
    let state: Conversation = { runtimeId: 'runtime-a', entries: [], running: true, error: '' }
    const dispatch = (type: string, payload: Record<string, unknown>, session_id = 'runtime-a') => {
      state = reduceEvent(state, { type, payload, session_id })
    }
    dispatch('message.delta', { text: '另一个项目的内容' }, 'runtime-b')
    expect(state.entries).toEqual([])
    dispatch('message.delta', { text: '正在阅读原稿。' })
    dispatch('message.interim', { text: '正在阅读原稿。', already_streamed: true })
    dispatch('tool.start', { tool_id: 't1', name: 'read_file', args: { path: '原稿.md' } })
    dispatch('tool.complete', { tool_id: 't1', name: 'read_file', result: '原稿', duration_s: 2 })
    dispatch('message.delta', { text: '## 人物分析\n母亲' })
    dispatch('message.complete', { status: 'error', text: '', error: '连接中断' })
    expect(state.entries.filter(entry => entry.text === '正在阅读原稿。')).toHaveLength(1)
    expect(state.entries.at(-1)?.text).toBe('## 人物分析\n母亲')
    expect(state.entries.find(entry => entry.role === 'activity')?.calls[0].state).toBe('complete')
    expect(state.running).toBe(false)
    expect(state.error).toBe('暂时无法连接创作服务，请稍后重试。')
  })

  it('恢复历史时展示附件名称，内部附件说明和压缩续写提示不变成用户正文', () => {
    const entries = historyEntries([
      { role: 'user', text: '请分析\n@file:`/work/.hermes/attachments/原剧本.docx`\n\n--- Attached Context ---\n内部附件元数据' },
      { role: 'user', text: '[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]\n请分析' },
      { role: 'user', text: '[ASYNC DELEGATION BATCH COMPLETE — task-1]\n内部任务回执' },
      { role: 'tool', name: 'execute_code', tool_call_id: 'read', args: { code: 'from hermes_tools import read_file' } }
    ])
    expect(entries.filter(entry => entry.role === 'user').map(entry => entry.text)).toEqual(['请分析'])
    expect(entries[0].attachments).toEqual([{ path: '/work/.hermes/attachments/原剧本.docx', name: '原剧本.docx' }])
    expect(entries.at(-1)?.calls.at(-1)?.label).toBe('处理项目资料')
    expect(JSON.stringify(entries)).not.toContain('from hermes_tools')
    expect(JSON.stringify(entries)).not.toContain('内部任务回执')
  })

  it('工具事件仅保存业务摘要，重复开始不重复计数，错误字符串不能显示成功', () => {
    let state: Conversation = { runtimeId: 's', entries: [], running: true, error: '' }
    const start = { type: 'tool.start', session_id: 's', payload: { tool_id: 'read-1', name: 'read_file', args: { path: '/workspace/原稿.md', command: 'PRIVATE_COMMAND' } } }
    state = reduceEvent(state, start, 1000)
    state = reduceEvent(state, start, 1200)
    state = reduceEvent(state, { type: 'tool.complete', session_id: 's', payload: { tool_id: 'read-1', name: 'read_file', result: '{"ok":false,"error":"资料不可读"}', duration_s: 0.5 } }, 1500)
    expect(state.entries[0].calls).toHaveLength(1)
    const call = state.entries[0].calls[0]
    expect(call.argumentSummary).toBe('资料：原稿.md')
    expect(call.resultSummary).toBe('资料不可读')
    expect(JSON.stringify(call)).not.toContain('/workspace/')
    expect(JSON.stringify(call)).not.toContain('PRIVATE_COMMAND')
    expect(call).not.toHaveProperty('arguments')
    expect(call).not.toHaveProperty('result')
    expect(call.state).toBe('error')
    expect(call.seconds).toBe(0.5)
    expect(call.startedAt).toBe(1000)
    expect(call.endedAt).toBe(1500)
  })

  it('结束轮次会结清未返回操作，不把中断操作继续显示为运行中', () => {
    let state: Conversation = { runtimeId: 's', entries: [], running: false, error: '' }
    state = reduceEvent(state, { type: 'message.start', session_id: 's', payload: {} }, 1000)
    state = reduceEvent(state, { type: 'tool.start', session_id: 's', payload: { tool_id: 'slow', name: 'drama_review' } }, 2000)
    state = reduceEvent(state, { type: 'message.complete', session_id: 's', payload: { status: 'interrupted', text: '' } }, 20_000)
    expect(state.running).toBe(false)
    expect(state.entries[0].calls[0].state).toBe('interrupted')
    expect(state.turn?.endedAt).toBe(20_000)
    const historical = historyEntries([{ role: 'tool', name: 'read_file', tool_call_id: 'old', args: { path: '原稿.md' } }])
    expect(historical[0].calls[0].state).toBe('unknown')
    expect(historical[0].calls[0].seconds).toBeUndefined()
  })

  it('后台结束快照会关闭遗留的转圈，且不伪造漏收的完成时刻', () => {
    let state: Conversation = { runtimeId: 's', entries: [], running: false, error: '' }
    for (const event of [
      { type: 'message.start', payload: {} },
      { type: 'tool.start', payload: { tool_id: 'read', name: 'read_file' } },
      { type: 'message.delta', payload: { text: '已读取一部分原稿' } },
      { type: 'session.info', payload: { running: false } }
    ]) state = reduceEvent(state, { ...event, session_id: 's' }, 5000)
    expect(state.running).toBe(false)
    expect(state.entries.every(entry => !entry.pending)).toBe(true)
    expect(state.entries[0].calls[0].state).toBe('unknown')
    expect(state.turn?.endedAt).toBeUndefined()
  })

  it('流式公开过的最终回复只出现一次，后端修订后的最终正文可以替换预览', () => {
    let state: Conversation = { runtimeId: 's', entries: [], running: true, error: '' }
    state = reduceEvent(state, { type: 'message.delta', session_id: 's', payload: { text: '原稿已核对。' } })
    state = reduceEvent(state, { type: 'message.interim', session_id: 's', payload: { text: '原稿已核对。', already_streamed: true } })
    state = reduceEvent(state, { type: 'message.complete', session_id: 's', payload: { text: '原稿已核对。', response_previewed: true, status: 'complete' } })
    expect(state.entries.filter(entry => entry.role === 'assistant')).toHaveLength(1)
    state = reduceEvent(state, { type: 'message.complete', session_id: 's', payload: { text: '原稿已核对，等待确认核心期待。', response_previewed: true, response_transformed: true, status: 'complete' } })
    expect(state.entries.map(entry => entry.text)).toEqual(['原稿已核对，等待确认核心期待。'])
    let next: Conversation = { runtimeId: 's', entries: [], running: true, error: '' }
    next = reduceEvent(next, { type: 'message.delta', session_id: 's', payload: { text: '先前已收到的说明。' } })
    next = reduceEvent(next, { type: 'message.interim', session_id: 's', payload: { text: '新增的公开进度说明。', already_streamed: false } })
    expect(next.entries.map(entry => entry.text)).toEqual(['先前已收到的说明。', '新增的公开进度说明。'])
  })

  it('按工具调用标识补回历史回执，保留已有实时结果且不虚构耗时', () => {
    const entries = historyEntries([{ role: 'tool', name: 'read_file', tool_call_id: 'a', args: { path: '原稿.md' } }, { role: 'tool', name: 'terminal', tool_call_id: 'b', content: { ok: true, summary: '已保存新纲', debug: 'PRIVATE_HISTORY' } }])
    const restored = restoreToolReceipts(entries, [{ id: 'a', content: '{"ok":false,"error":"原稿不存在"}' }, { id: 'b', content: { ok: true, summary: '不能覆盖的新值' } }])
    expect(restored[0].calls[0].argumentSummary).toContain('原稿.md')
    expect(restored[0].calls[0].resultSummary).toBe('原稿不存在')
    expect(restored[0].calls[0].state).toBe('error')
    expect(restored[0].calls[0].seconds).toBeUndefined()
    expect(restored[0].calls[1].resultSummary).toBe('已保存新纲')
    expect(JSON.stringify(restored)).not.toContain('PRIVATE_HISTORY')
  })
})
