import { afterEach, expect, it } from 'vitest'
import type { SessionResumeResult } from '../../../shared/src/gateway-contract.generated'
import { beginTurn } from '../lib/progress'
import { Workspace, type WorkspaceApi } from './workspace'

afterEach(() => localStorage.clear())

it('同会话恢复期间的新正文和完成事件不被旧快照覆盖，后续同步恢复完整历史且不重复正文', async () => {
  let finishResume!: (value: SessionResumeResult) => void
  let resumes = 0
  const request = '请完成这场两人短剧。'
  const answer = '第一场：两人在车站重逢。她递出车票，他终于承认了秘密。'
  const settled = { session_id: 'live', stored_session_id: 'saved', running: false, info: { running: false },
    messages: [{ role: 'user', content: request }, { role: 'assistant', content: answer }], message_count: 2 }
  const local = new Workspace({ profile: 'restore', materials: async () => ({ project: null, sources: [] }),
    rpc: (async method => {
      if (method === 'session.resume') return ++resumes === 1 ? new Promise(resolve => { finishResume = resolve }) : settled
      if (method === 'session.list') return { sessions: [{ id: 'saved', message_count: 2 }] }
      if (method === 'subagent.list') return { subagents: [] }
      if (method === 'session.events.since') return { events: [] }
      throw new Error('恢复会话不得再次提交生成')
    }) as WorkspaceApi['rpc'] })
  local.session.set({ runtimeId: 'live', storedId: 'saved', info: { running: true } })
  local.navigation.set({ sessions: [{ id: 'saved', message_count: 2 }], loading: false, error: '' })
  local.conversation.set({ runtimeId: 'live', running: true, error: '', turn: beginTurn(), entries: [
    { id: 'user', role: 'user', text: request, calls: [] }, { id: 'reply', role: 'assistant', text: '第一场：', calls: [], pending: true }
  ] })
  local.editComposer({ text: '保留我在等待时写下的下一轮要求' })
  const restoring = local.open('saved', { background: true })
  local.receive({ type: 'message.delta', session_id: 'live', payload: { text: answer.slice('第一场：'.length) } })
  local.receive({ type: 'message.complete', session_id: 'live', payload: { text: answer, status: 'complete' } })
  finishResume({ ...settled, running: true, info: { running: true }, messages: [settled.messages[0]], message_count: 1,
    inflight: { assistant: '第一场：', streaming: true, user: request } })
  await restoring
  expect.soft(local.conversation.get().running).toBe(false)
  expect.soft(local.conversation.get().turn?.state).toBe('complete')
  expect.soft(local.conversation.get().entries.filter(row => row.role === 'assistant').map(row => row.text)).toEqual([answer])
  await local.synchronize()
  await local.synchronize()
  expect(local.conversation.get().running).toBe(false)
  expect(local.conversation.get().entries.filter(row => row.role === 'assistant').map(row => row.text)).toEqual([answer])
  expect(local.composer.get().text).toBe('保留我在等待时写下的下一轮要求')
  expect(local.preparing.get()).toBe(false)
})

it('无竞态的已完成快照覆盖旧运行态，服务端更换 runtime 时不被旧会话事件阻挡', async () => {
  let finishResume!: (value: SessionResumeResult) => void
  const local = new Workspace({ profile: 'restore', materials: async () => ({ project: null, sources: [] }),
    rpc: (async method => {
      if (method === 'session.resume') return new Promise(resolve => { finishResume = resolve })
      if (method === 'subagent.list') return { subagents: [] }
      if (method === 'session.events.since') return { events: [] }
      throw new Error('恢复会话不得提交生成')
    }) as WorkspaceApi['rpc'] })
  local.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  local.conversation.set({ runtimeId: 'live', running: true, error: '', turn: beginTurn(), entries: [] })
  const settled = { session_id: 'live', stored_session_id: 'saved', running: false, info: {}, messages: [{ role: 'assistant', content: '完整成稿' }], message_count: 1 }
  const first = local.open('saved', { background: true })
  finishResume(settled)
  await first
  expect(local.conversation.get().running).toBe(false)
  expect(local.conversation.get().entries.map(row => row.text)).toEqual(['完整成稿'])
  const next = local.open('saved', { background: true })
  local.receive({ type: 'message.delta', session_id: 'live', payload: { text: '旧运行实例的迟到内容' } })
  finishResume({ ...settled, session_id: 'replacement' })
  await next
  expect(local.session.get().runtimeId).toBe('replacement')
  expect(local.conversation.get().entries.map(row => row.text)).toEqual(['完整成稿'])
})

it('切到仍在重连重放的会话先等待回放再读取历史，上轮完成事件不会插进本轮回复', async () => {
  let finishReplay!: (ready: boolean) => void
  const replay = new Promise<boolean>(resolve => { finishReplay = resolve })
  let replaying = true, resumes = 0
  const previousAnswer = '核心期待已通过你的确认。下面给出三个改编方案。'
  const snapshot = { session_id: 'target-live', stored_session_id: 'target', running: true, info: {},
    messages: [{ role: 'user', content: '给出改编方案' }, { role: 'assistant', content: previousAnswer },
      { role: 'user', content: '我选择方案B' }], message_count: 3,
    inflight: { assistant: '正在核对当前方案与确认状态。', user: '我选择方案B', streaming: true } }
  const api: WorkspaceApi & { sessionReplayBarrier: (runtimeId: string) => Promise<boolean> | undefined } = {
    profile: 'restore', materials: async () => ({ project: null, sources: [] }),
    sessionReplayBarrier: runtimeId => runtimeId === 'target-live' && replaying ? replay : undefined,
    rpc: (async method => {
      if (method === 'session.resume') { resumes++; return snapshot }
      if (method === 'session.list') return { sessions: [{ id: 'target', message_count: 3 }] }
      if (method === 'subagent.list') return { subagents: [] }
      if (method === 'session.events.since') return { events: [] }
      throw new Error('重连恢复不应提交生成')
    }) as WorkspaceApi['rpc']
  }
  const local = new Workspace(api)
  local.session.set({ runtimeId: 'other-live', storedId: 'other', info: {} })
  local.conversation.set({ runtimeId: 'other-live', running: false, entries: [], error: '' })
  const opening = local.open('target')
  await Promise.resolve()
  local.receive({ type: 'message.complete', session_id: 'target-live', seq: 2367, replayEpoch: 'gateway', replayed: true,
    payload: { text: previousAnswer, status: 'complete' } })
  replaying = false; finishReplay(true)
  await opening
  expect(local.conversation.get().entries.filter(row => row.text === previousAnswer)).toHaveLength(1)
  expect(local.conversation.get().entries.at(-1)?.text).toBe('正在核对当前方案与确认状态。')
  expect(local.conversation.get().running).toBe(true)
  expect(resumes).toBe(2)
})
