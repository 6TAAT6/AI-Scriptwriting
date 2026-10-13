// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Composer } from './Composer'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { historyEntries } from '../lib/transcript'
import { buildLanguageAwarePrompt } from '../lib/prompt-language'

afterEach(() => { cleanup(); workspace.reset(); vi.restoreAllMocks() })

test('斜杠选择显示为标记，正文编辑与实际发送仍保留对应 Agent 调用', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.models.set({ providers: [{ slug: 'primary', name: '主服务', models: ['model-alpha'] }] })
  workspace.session.set({ storedId: 'stored', runtimeId: 'live', info: { model: 'model-alpha' } })
  const submitted: string[] = []
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method !== 'prompt.submit') throw new Error('界面验收不应调用其他接口')
    submitted.push((params as { text: string }).text)
    return { status: 'streaming' }
  }) as WorkspaceApi['rpc'])
  workspace.editComposer({ text: '/' })
  render(<Composer />)

  const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' })
  expect(screen.getAllByRole('option').map(option => option.querySelector('strong')?.textContent)).toEqual([
    '巨豹 Agent1-适配巨豹满血版 V1.1', '巨豹 Agent2-适配巨豹测试版 V2.1', '巨豹 Agent3-适配巨豹试用版 V3.0', '巨豹skill-大纲变剧本', '巨豹skill-去AI味',
  ])
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(workspace.composer.get().text).toBe('')
  expect(workspace.composer.get().capabilityCommands?.map(row => row.capability.id)).toEqual(['gm3-1'])
  expect(input).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: '切换剧本 Agent：巨豹 Agent1-适配巨豹满血版 V1.1' })).toBeTruthy()
  expect(screen.queryByRole('listbox', { name: '剧本 Agent' })).toBeNull()
  fireEvent.change(input, { target: { value: '请改写这段故事\n保留人物关系。' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
  expect(submitted).toHaveLength(1)
  expect(submitted[0].split('\n\n【用户本轮消息】\n')[1]).toBe('请改写这段故事\n保留人物关系。')
  expect(screen.getByRole('button', { name: /^切换剧本 Agent/ })).toBeTruthy()
  expect(input).toHaveProperty('value', '')
})

test('标记支持筛选、切换、移除和草稿恢复，正文与附件保持', () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.models.set({ providers: [{ slug: 'primary', name: '主服务', models: ['model-alpha'] }] })
  workspace.editComposer({ text: '/gr4' })
  render(<Composer />)

  expect(screen.getAllByRole('option').map(option => option.querySelector('strong')?.textContent)).toEqual(['巨豹 Agent3-适配巨豹试用版 V3.0'])
  fireEvent.click(screen.getByRole('option'))
  const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }) as HTMLTextAreaElement
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('')
  fireEvent.change(input, { target: { value: '保留我的要求' } })
  fireEvent.click(screen.getByRole('button', { name: '切换剧本 Agent：巨豹 Agent3-适配巨豹试用版 V3.0' }))
  fireEvent.click(screen.getByRole('option', { name: /测试版 V2.1/ }))
  expect(workspace.composer.get().text).toBe('保留我的要求')
  expect(workspace.composer.get().capabilityCommands?.map(row => row.capability.id)).toEqual(['oa6-1'])
  expect(input.value).toBe('保留我的要求')
  act(() => workspace.newConversation('另一个项目'))
  expect(screen.queryByRole('button', { name: /^切换剧本 Agent/ })).toBeNull()
  act(() => workspace.newConversation(null))
  expect(screen.getByRole('button', { name: '切换剧本 Agent：巨豹 Agent2-适配巨豹测试版 V2.1' })).toBeTruthy()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(input, { key: 'Backspace', isComposing: true })
  expect(screen.getByRole('button', { name: /^切换剧本 Agent/ })).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(workspace.composer.get().text).toBe('保留我的要求')
  expect(input.value).toBe('保留我的要求')
  const attachments = [{ attached: true, name: '原稿.txt', path: '/fixture/原稿.txt', ref_path: '/fixture/原稿.txt', ref_text: '@file:/fixture/原稿.txt', uploaded: true }]
  act(() => workspace.editComposer({ text: '调用巨豹 Agent3-适配巨豹试用版 V3.0 保留我的要求', attachments }))
  fireEvent.click(screen.getByRole('button', { name: '移除剧本 Agent：巨豹 Agent3-适配巨豹试用版 V3.0' }))
  expect(workspace.composer.get().text).toBe('保留我的要求')
  expect(workspace.composer.get().attachments).toEqual(attachments)
})
test('独立技能可与主 Agent 叠加并在续聊时显示和停用', () => {
  const saved = buildLanguageAwarePrompt('继续第二十集', '仅中文', '中国', { agent: 'oa6-1', skills: ['humanize'] })
  workspace.conversation.set({ runtimeId: 'live', running: false, error: '', entries: historyEntries([
    { role: 'user', content: saved }
  ]) })
  render(<Composer />)
  expect(screen.getByRole('group', { name: '已选择的创作能力' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } })
  fireEvent.click(screen.getByRole('option', { name: /巨豹skill-大纲变剧本/ }))
  expect(workspace.composer.get().capabilityCommands?.some(row => row.capability.id === 'outline-script')).toBe(true)
  expect(screen.getByRole('button', { name: '停用巨豹skill-去AI味' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '停用巨豹skill-去AI味' }))
  expect(workspace.composer.get().capabilityCommands?.find(row => row.capability.id === 'humanize')?.action).toBe('停用')
  expect(workspace.composer.get().capabilityCommands?.some(row => row.capability.id === 'outline-script')).toBe(true)
})

test('选择另一个主 Agent 直接替换草稿，不弹窗或新建对话，并保留技能', () => {
  workspace.session.set({ storedId: 'saved-original', runtimeId: 'live', info: {} })
  workspace.conversation.set({ runtimeId: 'live', running: false, error: '', entries: [
    { id: 'u1', role: 'user', text: '调用巨豹 Agent1-适配巨豹满血版 V1.1\n调用巨豹skill-去AI味', calls: [] }
  ] })
  render(<Composer />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/gr4' } })
  fireEvent.click(screen.getByRole('option', { name: /巨豹 Agent3-适配巨豹试用版 V3.0/ }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(workspace.session.get().runtimeId).toBe('live')
  expect(workspace.conversation.get().entries).toHaveLength(1)
  expect(workspace.composer.get().text).toBe('')
  expect(workspace.composer.get().capabilityCommands?.map(row => row.capability.id)).toEqual(['gr4-7'])
  expect(screen.getByRole('button', { name: '停用巨豹skill-去AI味' })).toBeTruthy()
  expect(workspace.conversation.get().running).toBe(false)
})
