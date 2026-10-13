import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Composer } from './Composer'
import { Transcript } from './Transcript'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { historyEntries } from '../lib/transcript'

afterEach(() => { cleanup(); workspace.reset(); vi.restoreAllMocks() })

test('两个独立技能与主 Agent 共用标记，真实发送的用户正文不拼接调用句', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: {} })
  let sent = ''
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method !== 'prompt.submit') throw new Error('此测试不调用模型')
    sent = (params as { text: string }).text
    return { status: 'streaming' }
  }) as WorkspaceApi['rpc'])
  render(<><Transcript onInspect={() => {}} /><Composer /></>)
  for (const name of ['巨豹 Agent1-适配巨豹满血版 V1.1', '巨豹skill-大纲变剧本', '巨豹skill-去AI味']) {
    fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
    fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }))
  }
  const selected = screen.getByRole('group', { name: '已选择的创作能力' })
  expect(within(selected).getByText('巨豹 Agent1 · 适配满血版 V1.1')).toBeTruthy()
  expect(within(selected).getByText('skill-大纲变剧本')).toBeTruthy()
  expect(within(selected).getByText('skill-去 AI 味')).toBeTruthy()
  const body = '请优化这一集。\n保留人物说话习惯。'
  fireEvent.change(screen.getByRole('textbox'), { target: { value: body } })
  expect(workspace.composer.get().text).toBe(body)
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(sent).not.toBe(''))
  expect(sent.split('\n\n【用户本轮消息】\n')[1]).toBe(body)
  expect(workspace.conversation.get().entries[0].text).toBe(body)
  expect(screen.getByRole('group', { name: '本条消息使用的创作能力' }).textContent).toContain('skill-去 AI 味')
  expect(document.querySelector('.user-message-text')?.textContent).toBe(body)
  act(() => workspace.conversation.set({ runtimeId: 'live', running: false, error: '', entries: historyEntries([{ role: 'user', content: sent }]) }))
  expect(screen.getByRole('group', { name: '本条消息使用的创作能力' }).textContent).toContain('大纲变剧本')
  expect(document.querySelector('.user-message-text')?.textContent).toBe(body)
})

test('只调用 skill 也能发送并恢复为标记，新对话不携带另一份草稿的选择', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: {} })
  let sent = ''
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method === 'model.options') return { providers: [] }
    if (method === 'prompt.submit') { sent = (params as { text: string }).text; return { status: 'streaming' } }
    throw new Error('此测试不调用模型')
  }) as WorkspaceApi['rpc'])
  render(<><Transcript onInspect={() => {}} /><Composer /></>)
  fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
  fireEvent.click(screen.getByRole('option', { name: /巨豹skill-去AI味/ }))
  expect(screen.getByRole('textbox')).toHaveProperty('value', '')
  expect(workspace.canAutoUpdate).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(sent).not.toBe(''))
  const history = historyEntries([{ role: 'user', content: sent }])
  expect(history).toHaveLength(1)
  expect(history[0].text).toBe('')
  expect(history[0].capabilities?.skills).toEqual(['humanize'])
  await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
  act(() => workspace.newConversation(null))
  expect(screen.queryByRole('group', { name: '已选择的创作能力' })).toBeNull()
})

test('持续能力只保留可关闭的高亮标记，取消后下一条消息回到普通对话', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: {} })
  workspace.conversation.set({ runtimeId: 'live', running: false, error: '', entries: [{ id: 'first', role: 'user', text: '原稿', calls: [],
    capabilities: { agent: 'gm3-1', skills: ['humanize'] }, capabilityCommands: [] }] })
  let sent = ''
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (_method, params) => { sent = (params as { text: string }).text; return { status: 'streaming' } }) as WorkspaceApi['rpc'])
  render(<><Transcript onInspect={() => {}} /><Composer /></>)
  expect(screen.queryByRole('group', { name: '本条消息使用的创作能力' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '停用巨豹skill-去AI味' }))
  expect(screen.queryByRole('button', { name: '停用巨豹skill-去AI味' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '移除剧本 Agent：巨豹 Agent1-适配巨豹满血版 V1.1' }))
  expect(screen.queryByRole('group', { name: '已选择的创作能力' })).toBeNull()
  expect(document.body.textContent).not.toMatch(/已启用|待停用/)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '现在普通聊天。' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(sent).not.toBe(''))
  expect(workspace.conversation.get().entries.at(-1)?.capabilities).toEqual({ skills: [] })
  expect(sent).toContain('"id":"gm3-1","action":"disable"')
  expect(screen.queryByRole('group', { name: '本条消息使用的创作能力' })).toBeNull()
})
