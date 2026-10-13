import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceApi } from './workspace'
import { workspace } from './workspace'
import { Composer } from '../components/Composer'
import scriptFormat from '../../shared/script-format.md?raw'

const inputText = '请创作一场只有两名角色的短剧。'

afterEach(() => { cleanup(); workspace.reset(); localStorage.clear(); vi.restoreAllMocks() })

it('旧会话下一轮带上当前共用格式，保留原历史且不另建会话', async () => {
  workspace.reset()
  const oldEntry = { id: 'old', role: 'assistant' as const, text: '旧稿原有内容\n原有换行', calls: [] }
  workspace.session.set({ runtimeId: 'existing-live', storedId: 'existing-saved', info: {} })
  workspace.conversation.set({ runtimeId: 'existing-live', entries: [oldEntry], running: false, error: '' })
  workspace.editComposer({ text: '请继续下一场。' })
  const submitted: Record<string, unknown>[] = []
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method !== 'prompt.submit') throw new Error('旧会话不应另建会话或改写系统提示')
    submitted.push(params as Record<string, unknown>)
    return { status: 'streaming' }
  }) as WorkspaceApi['rpc'])
  await workspace.send()
  expect(submitted).toHaveLength(1)
  expect(submitted[0].session_id).toBe('existing-live')
  expect(String(submitted[0].text)).toContain(scriptFormat)
  expect(String(submitted[0].text).endsWith('请继续下一场。')).toBe(true)
  expect(workspace.conversation.get().entries.find(entry => entry.id === 'old')).toEqual(oldEntry)
})

it('提交回执不明时保留草稿并阻止再次付费提交，核对会话后才允许继续', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  workspace.conversation.set({ runtimeId: 'live', entries: [], running: false, error: '' })
  workspace.editComposer({ text: inputText })
  let submissions = 0
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async method => {
    if (method === 'prompt.submit') { submissions++; throw new Error('回执超时') }
    if (method === 'session.resume') return { session_id: 'live', stored_session_id: 'saved', messages: [], message_count: 0, info: {}, running: false }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'session.events.since') return { events: [] }
    throw new Error('测试不应调用其他方法')
  }) as WorkspaceApi['rpc'])
  vi.spyOn(workspace.api, 'materials').mockResolvedValue({ project: null, sources: [] })
  render(<Composer />)
  await act(async () => { await workspace.send() })
  expect(workspace.composer.get().text).toBe(inputText)
  expect(workspace.conversation.get().turn?.state).toBe('unknown')
  expect.soft((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { await workspace.send() })
  expect.soft(submissions).toBe(1)
  fireEvent.keyDown(screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }), { key: 'Enter' })
  await act(async () => {})
  expect.soft(submissions).toBe(1)
  await act(async () => { await workspace.open('saved', { background: true }) })
  expect(workspace.composer.get().text).toBe(inputText)
  expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)
})

it('未知提交状态由定期同步重新核对，新的创作仍可打开且保留原聊天草稿', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  workspace.navigation.set({ sessions: [{ id: 'saved', message_count: 0 }], loading: false, error: '' })
  workspace.conversation.set({ runtimeId: 'live', entries: [], running: false, error: '', turn: { timingSource: 'unknown', state: 'unknown' } })
  workspace.editComposer({ text: inputText })
  vi.spyOn(workspace.projects!, 'load').mockResolvedValue()
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async method => {
    if (method === 'session.list') return { sessions: [{ id: 'saved', message_count: 0 }] }
    if (method === 'session.resume') return { session_id: 'live', stored_session_id: 'saved', messages: [], message_count: 0, info: {}, running: false }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'session.events.since') return { events: [] }
    if (method === 'model.options') return { providers: [] }
    throw new Error('同步和新建界面不应提交生成')
  }) as WorkspaceApi['rpc'])
  vi.spyOn(workspace.api, 'materials').mockResolvedValue({ project: null, sources: [] })
  render(<Composer />)
  await act(async () => { await workspace.synchronize() })
  expect.soft(workspace.conversation.get().turn?.state).not.toBe('unknown')
  expect.soft((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)
  act(() => {
    workspace.conversation.set({ ...workspace.conversation.get(), turn: { timingSource: 'unknown', state: 'unknown' } })
    workspace.newConversation()
  })
  expect(workspace.session.get().storedId).toBe('')
  expect(workspace.conversation.get().turn).toBeUndefined()
  await act(async () => { await workspace.open('saved') })
  expect(workspace.composer.get().text).toBe(inputText)
})
