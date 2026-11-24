// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Composer } from './Composer'
import { workspace, type WorkspaceApi } from '../store/workspace'

const LABEL = '巨豹 skill · 漫剧剧本内容合规审核规范'
const SKILL_ID = 'content-compliance'

afterEach(() => { cleanup(); workspace.reset(); localStorage.clear(); vi.restoreAllMocks() })

function field(text: string, label: string) {
  const line = text.split(`【${label}】\n`)[1]?.split('\n')[0]
  expect(line).toBeTruthy()
  return JSON.parse(line)
}

test('独立合规技能叠加主Agent并随发送生效，取消后下一轮停用且账号切换不串选择', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ storedId: 'saved-a', runtimeId: 'live-a', info: { model: 'writer', provider: 'primary' } })
  workspace.models.set({ providers: [{ slug: 'primary', name: '创作模型', models: ['writer'] }] })
  const original = { id: 'prior-user', role: 'user' as const, text: '既有用户要求', capabilities: { agent: 'gm3-1', skills: [] }, calls: [] }
  workspace.conversation.set({ runtimeId: 'live-a', entries: [original], running: false, error: '' })
  const submitted: Record<string, unknown>[] = []
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method !== 'prompt.submit') throw new Error('选择与发送不能另建会话、切模型或改写系统提示')
    submitted.push(params as Record<string, unknown>)
    return { status: 'streaming' }
  }) as WorkspaceApi['rpc'])
  render(<Composer />)
  fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
  fireEvent.click(screen.getByRole('option', { name: LABEL }))
  expect(screen.getByRole('button', { name: '移除剧本 Agent：巨豹 Agent1 · 适配满血版 V1.1' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '停用' + LABEL })).toBeTruthy()
  expect(workspace.session.get().info.model).toBe('writer')
  expect(submitted).toEqual([])

  const body = '只审核当前稿件。\n逐项给出依据，不改写正文。'
  fireEvent.change(screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }), { target: { value: body } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送消息' })) })
  expect(submitted).toHaveLength(1)
  const first = String(submitted[0].text)
  expect(submitted[0].session_id).toBe('live-a')
  expect(field(first, '本轮能力操作')).toEqual([{ id: SKILL_ID, action: 'enable' }])
  expect(field(first, '本轮创作能力')).toEqual({ agent: 'gm3-1', skills: [SKILL_ID] })
  expect(first.split('【用户本轮消息】\n')[1]).toBe(body)
  expect(first).toContain('jubao-drama:jubao-skill-content-compliance')
  expect(workspace.conversation.get().entries[0]).toEqual(original)

  act(() => workspace.conversation.set({ ...workspace.conversation.get(), running: false, turn: undefined }))
  fireEvent.click(screen.getByRole('button', { name: '停用' + LABEL }))
  fireEvent.change(screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }), { target: { value: '继续普通讨论。' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送消息' })) })
  expect(submitted).toHaveLength(2)
  expect(field(String(submitted[1].text), '本轮能力操作')).toEqual([{ id: SKILL_ID, action: 'disable' }])
  expect(field(String(submitted[1].text), '本轮创作能力')).toEqual({ agent: 'gm3-1', skills: [] })
  const ownHistory = [...workspace.conversation.get().entries]

  act(() => {
    workspace.reset()
    workspace.connection.set('open')
    workspace.session.set({ storedId: 'saved-b', runtimeId: 'live-b', info: { model: 'writer', provider: 'primary' } })
    workspace.models.set({ providers: [{ slug: 'primary', name: '创作模型', models: ['writer'] }] })
  })
  expect(screen.queryByRole('button', { name: '停用' + LABEL })).toBeNull()
  expect(workspace.composer.get().capabilityCommands ?? []).toEqual([])
  act(() => {
    workspace.reset()
    workspace.connection.set('open')
    workspace.session.set({ storedId: 'saved-a', runtimeId: 'live-a', info: { model: 'writer', provider: 'primary' } })
    workspace.models.set({ providers: [{ slug: 'primary', name: '创作模型', models: ['writer'] }] })
    workspace.conversation.set({ runtimeId: 'live-a', entries: ownHistory, running: false, error: '' })
  })
  expect(screen.queryByRole('button', { name: '停用' + LABEL })).toBeNull()
  expect(screen.getByRole('button', { name: '移除剧本 Agent：巨豹 Agent1 · 适配满血版 V1.1' })).toBeTruthy()
})
