// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Composer } from './Composer'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { historyEntries } from '../lib/transcript'
import { buildLanguageAwarePrompt } from '../lib/prompt-language'
import { CAPABILITIES } from '../lib/capabilities'

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
  // 菜单按能力目录顺序列出全部可见能力；隐藏的入口不出现。
  expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(
    CAPABILITIES.filter(row => !row.hidden).map(row => row.display_name))
  // 方向键移到第二项后回车选中。
  const second = CAPABILITIES.filter(row => !row.hidden)[1]
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(workspace.composer.get().text).toBe('')
  expect(workspace.composer.get().capabilityCommands?.map(row => row.capability.id)).toEqual([second.id])
  expect(input).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: `切换剧本 Agent：${second.display_name}` })).toBeTruthy()
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
  workspace.editComposer({ text: '/gm3' })
  render(<Composer />)

  expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['巨豹 Agent1 · 适配满血版 V1.1'])
  fireEvent.click(screen.getByRole('option'))
  const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }) as HTMLTextAreaElement
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('')
  fireEvent.change(input, { target: { value: '保留我的要求' } })
  fireEvent.click(screen.getByRole('button', { name: '切换剧本 Agent：巨豹 Agent1 · 适配满血版 V1.1' }))
  fireEvent.click(screen.getByRole('option', { name: /Agent2.2/ }))
  expect(workspace.composer.get().text).toBe('保留我的要求')
  expect(workspace.composer.get().capabilityCommands?.map(row => row.capability.id)).toEqual(['coauthor-2-2'])
  expect(input.value).toBe('保留我的要求')
  act(() => workspace.newConversation('另一个项目'))
  expect(screen.queryByRole('button', { name: /^切换剧本 Agent/ })).toBeNull()
  act(() => workspace.newConversation(null))
  expect(screen.getByRole('button', { name: '切换剧本 Agent：巨豹 Agent2.2 · 适配巨豹满血版 V1.1' })).toBeTruthy()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(input, { key: 'Backspace', isComposing: true })
  expect(screen.getByRole('button', { name: /^切换剧本 Agent/ })).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(workspace.composer.get().text).toBe('保留我的要求')
  expect(input.value).toBe('保留我的要求')
  const attachments = [{ attached: true, name: '原稿.txt', path: '/fixture/原稿.txt', ref_path: '/fixture/原稿.txt', ref_text: '@file:/fixture/原稿.txt', uploaded: true }]
  act(() => workspace.editComposer({ text: '调用巨豹 Agent-适配 GM3.1 版本 保留我的要求', attachments }))
  fireEvent.click(screen.getByRole('button', { name: '移除剧本 Agent：巨豹 Agent1 · 适配满血版 V1.1' }))
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
  fireEvent.click(screen.getByRole('option', { name: /巨豹 skill · 大纲变剧本/ }))
  expect(workspace.composer.get().capabilityCommands?.some(row => row.capability.id === 'outline-script')).toBe(true)
  expect(screen.getByRole('button', { name: '停用巨豹 skill · 去 AI 味' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '停用巨豹 skill · 去 AI 味' }))
  expect(workspace.composer.get().capabilityCommands?.find(row => row.capability.id === 'humanize')?.action).toBe('停用')
  expect(workspace.composer.get().capabilityCommands?.some(row => row.capability.id === 'outline-script')).toBe(true)
})

test('选择另一个主 Agent 直接替换草稿，不弹窗或新建对话，并保留技能', () => {
  workspace.session.set({ storedId: 'saved-original', runtimeId: 'live', info: {} })
  workspace.conversation.set({ runtimeId: 'live', running: false, error: '', entries: [
    { id: 'u1', role: 'user', text: '调用巨豹 Agent-适配 GM3.1 版本\n调用巨豹skill-去AI味', calls: [] }
  ] })
  render(<Composer />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/coauthor' } })
  fireEvent.click(screen.getByRole('option', { name: /巨豹 Agent2\.2 · 适配巨豹满血版 V1\.1/ }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(workspace.session.get().runtimeId).toBe('live')
  expect(workspace.conversation.get().entries).toHaveLength(1)
  expect(workspace.composer.get().text).toBe('')
  expect(workspace.composer.get().capabilityCommands?.map(row => row.capability.id)).toEqual(['coauthor-2-2'])
  expect(screen.getByRole('button', { name: '停用巨豹 skill · 去 AI 味' })).toBeTruthy()
  expect(workspace.conversation.get().running).toBe(false)
})

test('菜单高亮跟随当前选中的 Agent 与已启用的 skill，而不是固定第一项', () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.models.set({ providers: [{ slug: 'primary', name: '主服务', models: ['model-alpha'] }] })
  const visible = CAPABILITIES.filter(row => !row.hidden)
  const agents = visible.filter(row => row.kind === 'agent'), skill = visible.find(row => row.kind === 'skill')!
  const other = agents[1]
  render(<Composer />)
  const selectedIds = () => screen.getAllByRole('option').filter(option => option.getAttribute('aria-selected') === 'true')
    .map(option => visible.find(row => row.display_name === option.getAttribute('aria-label'))?.id)

  // 未选择任何能力时没有选中项。
  fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
  expect(selectedIds()).toEqual([])
  fireEvent.click(screen.getByRole('option', { name: other.display_name }))

  // 选了非第一项的 Agent 后重新打开，高亮落在它上面，键盘光标也从它开始。
  fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
  expect(selectedIds()).toEqual([other.id])
  expect(screen.getByRole('option', { name: other.display_name }).className).toContain('is-active')
  fireEvent.click(screen.getByRole('option', { name: skill.display_name }))

  // 叠加 skill 后两者都标为已选。
  fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
  expect(selectedIds()).toEqual([other.id, skill.id])
  fireEvent.click(screen.getByRole('option', { name: agents[0].display_name }))
  fireEvent.click(screen.getByRole('button', { name: '选择 Agent 或独立技能' }))
  expect(selectedIds()).toEqual([agents[0].id, skill.id])
})
