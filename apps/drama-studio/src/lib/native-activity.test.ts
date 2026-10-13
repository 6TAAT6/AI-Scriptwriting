import { expect, it } from 'vitest'
import { historyEntries, reduceEvent, type Conversation } from './transcript'
import { restoreSubagents } from './native-activity'

it('原生状态按顺序显示，后台子代理在父轮结束后继续更新，重放不重复正文', () => {
  let state: Conversation = { runtimeId: 'native', entries: [], running: false, error: '' }
  let seq = 0
  const send = (type: string, payload: Record<string, unknown>) => {
    const event = { type, payload, session_id: 'native', replayEpoch: 'run-a', seq: ++seq }
    state = reduceEvent(state, event, seq * 1000)
    return event
  }
  send('message.start', {})
  send('reasoning.delta', { text: 'PRIVATE_REASONING' })
  const first = send('message.delta', { text: '正在起草' })
  send('review.summary', { text: '自我改进回顾：技能 structured-tool-results 已修补' })
  send('message.delta', { text: '第 9—12 集。' })
  state = reduceEvent(state, { ...first, replayed: true }, 5000)
  expect(state.entries.filter(row => row.role === 'assistant').map(row => row.text)).toEqual(['正在起草第 9—12 集。'])
  send('message.interim', { text: '正在起草第 9—12 集。', already_streamed: true })
  send('subagent.start', { subagent_id: 'child', goal: '起草第 9—12 集新纲', model: 'test-model' })
  send('message.complete', { text: '正在起草第 9—12 集。', response_previewed: true, status: 'complete' })
  expect(state.running).toBe(false)
  expect(state.asyncPending).toBe(1)
  send('subagent.progress', { subagent_id: 'child', tool_count: 3, tool_name: 'read_file' })
  state = restoreSubagents(state, [{ subagent_id: 'child', status: 'running', tool_count: 1, last_tool: 'old_tool' }])
  expect(state.entries.find(row => row.subagent)?.subagent).toMatchObject({ toolCount: 3, lastTool: 'read_file' })
  send('subagent.complete', { subagent_id: 'child', status: 'completed', duration_seconds: 59 })
  expect(state.asyncPending).toBe(0)
  expect(state.entries.find(row => row.role === 'subagent')?.subagent).toMatchObject({ id: 'child', goal: '起草第 9—12 集新纲', status: 'completed', elapsed: 59, toolCount: 3 })
  expect(state.entries.find(row => row.role === 'status')?.text).toContain('structured-tool-results')
  expect(state.entries.find(row => row.role === 'thinking')?.pending).toBe(false)
  expect(JSON.stringify(state)).not.toContain('PRIVATE_REASONING')
})

it('恢复时自动续接与后台回执保留为状态行，不变成用户新指令或重复子代理', () => {
  const entries = historyEntries([
    { role: 'user', content: '继续写第 9 集' },
    { role: 'user', content: 'INTERNAL_RECOVERY_PROMPT', display_kind: 'auto_continue', display_metadata: { attempt: 1 } },
    { role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — batch-a]\nINTERNAL_RESULT' }
  ])
  expect(entries.filter(row => row.role === 'user').map(row => row.text)).toEqual(['继续写第 9 集'])
  expect(entries.filter(row => row.role === 'status').map(row => row.noticeKind)).toEqual(['auto_continue', 'background.complete'])
  expect(JSON.stringify(entries)).not.toMatch(/INTERNAL_/)
  let state: Conversation = { runtimeId: 's', entries, running: false, error: '' }
  state = restoreSubagents(state, [], [{ delegation_id: 'failed-batch', task_index: 2, status: 'failed', goal: '独立审核' }])
  expect(state.entries.find(row => row.subagent)?.subagent).toMatchObject({ status: 'failed', goal: '独立审核' })
  state = reduceEvent(state, { type: 'subagent.complete', session_id: 's', payload: { subagent_id: 'unknown-completion', status: 'running' } })
  expect(state.asyncPending).toBe(0)
  expect(state.entries.at(-1)?.subagent?.status).toBe('failed')
})

it('权威快照可以结束旧运行状态，缺席任务退出活动列表且迟到进度不能复活它', () => {
  let state: Conversation = { runtimeId: 's', entries: [], running: false, error: '' }
  state = reduceEvent(state, { type: 'subagent.start', session_id: 's', payload: { subagent_id: 'failed-child', goal: '独立审核' } })
  state = restoreSubagents(state, [{ subagent_id: 'failed-child', status: 'failed' }])
  expect(state.asyncPending).toBe(0)
  expect(state.entries[0].subagent?.status).toBe('failed')
  state = reduceEvent(state, { type: 'subagent.start', session_id: 's', payload: { subagent_id: 'missing-child' } })
  expect(state.asyncPending).toBe(1)
  state = restoreSubagents(state, [])
  expect(state.asyncPending).toBe(0)
  state = reduceEvent(state, { type: 'subagent.progress', session_id: 's', payload: { subagent_id: 'missing-child', status: 'running' } })
  expect(state.asyncPending).toBe(0)
})
