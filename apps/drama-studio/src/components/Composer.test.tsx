// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Composer } from './Composer'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { gateway } from '../lib/gateway'

beforeEach(() => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.session.set({ storedId: '', runtimeId: '', info: { model: 'model-alpha', provider: 'primary' } })
  workspace.models.set({ providers: [
    { slug: 'primary', name: '主服务', models: ['model-alpha', 'model-beta'] },
    { slug: 'secondary', name: '备用服务', models: ['model-beta'], display_names: { 'model-beta': '团队备用版' } }
  ] })
  workspace.composer.set({ text: '', region: '中国', language: '中英双语', attachments: [], busy: false })
  workspace.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
  workspace.navigation.set({ sessions: [], loading: false, error: '' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('截图粘贴只添加一次附件，保留文字草稿；断线粘贴给出明确提示', async () => {
  workspace.session.set({ storedId: 'stored', runtimeId: 'live', info: {} })
  workspace.connection.set('open')
  workspace.composer.set({ ...workspace.composer.get(), text: '帮我看这张截图' })
  const calls: string[] = []
  vi.spyOn(gateway, 'rpc').mockImplementation(async (method, params) => {
    calls.push(method)
    if (method !== 'file.attach') throw new Error('本测试不调用模型')
    const upload = params as { data_url: string; name: string }
    expect(upload.data_url).toMatch(/^data:image\/png;base64,/)
    return { attached: true, name: upload.name, path: '/assets-data/test/截图.png', ref_path: '/assets-data/test/截图.png', ref_text: '@file:`/assets-data/test/截图.png`', uploaded: true } as never
  })
  render(<Composer />)
  const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' })
  const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], '截图.png', { type: 'image/png' })
  const clipboardData = { files: [image], items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] }
  fireEvent.paste(input, { clipboardData })
  await waitFor(() => expect(workspace.composer.get().attachments).toHaveLength(1))
  expect(calls).toEqual(['file.attach'])
  expect(workspace.composer.get().text).toBe('帮我看这张截图')
  fireEvent.click(screen.getByRole('button', { name: '移除附件 截图.png' }))
  expect(workspace.composer.get().attachments).toHaveLength(0)
  workspace.connection.set('closed')
  fireEvent.paste(input, { clipboardData })
  await waitFor(() => expect(workspace.conversation.get().error).toContain('连接'))
  expect(calls).toHaveLength(1)
  const textPaste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(textPaste, 'clipboardData', { value: { files: [], items: [] } })
  input.dispatchEvent(textPaste)
  expect(textPaste.defaultPrevented).toBe(false)
})

test('模型菜单直接显示全部选项，键盘选择保留模型所属服务', () => {
  render(<Composer />)
  fireEvent.click(screen.getByRole('combobox', { name: '创作模型' }))
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.getAllByRole('option')).toHaveLength(3)
  const list = screen.getByRole('listbox', { name: '创作模型' })
  fireEvent.keyDown(list, { key: 'End' })
  fireEvent.keyDown(list, { key: 'Enter' })
  expect(workspace.session.get().info).toMatchObject({ model: 'model-beta', provider: 'secondary' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '创作模型' }))
})

test('统一选择菜单支持退出、点击外部关闭以及任务参数选择', () => {
  render(<Composer />)
  const model = screen.getByRole('combobox', { name: '创作模型' })
  fireEvent.click(model)
  fireEvent.keyDown(screen.getByRole('listbox', { name: '创作模型' }), { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.activeElement).toBe(model)
  fireEvent.click(model)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '创作设置' }))
  fireEvent.click(screen.getByRole('combobox', { name: '故事地区' }))
  fireEvent.click(screen.getByRole('option', { name: '欧美' }))
  expect(workspace.composer.get().region).toBe('欧美')
})

test('思考强度只提供当前模型声明的档位，切换模型清除不兼容的选择', () => {
  workspace.models.set({ providers: [{ slug: 'primary', name: '主服务', models: ['model-alpha', 'model-beta'], capabilities: {
    'model-alpha': { fast: false, reasoning: true, supported_efforts: ['low', 'medium', 'high'] },
    'model-beta': { fast: false, reasoning: false }
  } }] })
  render(<Composer />)
  fireEvent.click(screen.getByRole('combobox', { name: '思考强度' }))
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['低', '中', '高'])
  fireEvent.click(screen.getByRole('option', { name: '高' }))
  expect(workspace.session.get().info.reasoning_effort).toBe('high')
  fireEvent.click(screen.getByRole('combobox', { name: '创作模型' }))
  fireEvent.click(screen.getByRole('option', { name: '巨豹创作模型 2' }))
  expect(workspace.session.get().info.reasoning_effort).toBeUndefined()
  expect((screen.getByRole('combobox', { name: '思考强度' }) as HTMLButtonElement).disabled).toBe(true)
})

test('模型菜单展示文字与生图分类，选择图片模型保留对话文字模型并启用生图', () => {
  workspace.models.set({ model: 'gpt-6-astra', provider: 'gpt', providers: [
    { slug: 'gpt', aliases: ['custom:gpt'], name: '内部服务名', models: ['gpt-6-astra'], display_names: { 'gpt-6-astra': '巨豹测试版 V2.0' }, image_models: ['gpt-image-2'] },
    { slug: 'gemini', name: '内部代理', models: ['gemini-3.1-pro-low'], image_models: ['gemini-3.1-flash-image'], image_display_names: { 'gemini-3.1-flash-image': '巨豹生图 V2.0' } }
  ] })
  workspace.session.set({ storedId: '', runtimeId: '', info: {} })
  render(<Composer />)
  fireEvent.click(screen.getByRole('combobox', { name: '创作模型' }))
  expect(screen.getAllByText('文字模型').length).toBeGreaterThan(1)
  expect(screen.getAllByText('生图模型').length).toBeGreaterThan(1)
  fireEvent.click(screen.getByRole('option', { name: '巨豹生图 V2.0' }))
  expect(workspace.composer.get()).toMatchObject({ imageModel: { provider: 'gemini', model: 'gemini-3.1-flash-image' } })
  expect(workspace.session.get().info.model).not.toBe('gemini-3.1-flash-image')
  act(() => workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: { model: 'gpt-6-astra', provider: 'custom:gpt' } }))
  fireEvent.click(screen.getByRole('combobox', { name: '创作模型' }))
  fireEvent.click(screen.getByRole('option', { name: '巨豹测试版 V2.0' }))
  expect(workspace.composer.get().imageModel).toBeUndefined()
  expect(workspace.session.get().info.model).toBe('gpt-6-astra')
})

test('停止后的对话可直接选择其他文字模型，确认前按钮等待且原稿保持', async () => {
  workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: { model: 'model-alpha', provider: 'primary' } })
  workspace.conversation.set({ runtimeId: 'live', entries: [{ id: 'old', role: 'user', text: '已上传原稿', calls: [] }], running: false, error: '' })
  let finish!: (value: unknown) => void
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async method => {
    if (method !== 'config.set') throw new Error('不能新建对话')
    return new Promise<unknown>(resolve => { finish = resolve })
  }) as WorkspaceApi['rpc'])
  workspace.editComposer({ text: '接着修改原来的剧本' })
  render(<Composer />)
  fireEvent.click(screen.getByRole('combobox', { name: '创作模型' }))
  const option = screen.getByRole('option', { name: '团队备用版' })
  expect(option.getAttribute('aria-disabled')).not.toBe('true')
  fireEvent.click(option)
  expect(screen.getByRole('button', { name: '发送消息' })).toHaveProperty('disabled', true)
  await act(async () => finish({ key: 'model', value: 'model-beta', info: { model: 'model-beta', provider: 'secondary' } }))
  expect(screen.getByRole('combobox', { name: '创作模型' }).textContent).toContain('团队备用版')
  expect(workspace.session.get().storedId).toBe('saved')
  expect(workspace.composer.get().text).toBe('接着修改原来的剧本')
  expect(workspace.conversation.get().entries[0].text).toBe('已上传原稿')
})

test('恢复创作会话使用已保存的模型和思考强度，不切到工作区默认模型', async () => {
  workspace.reset()
  workspace.connection.set('open')
  workspace.models.set({ model: 'profile-default', provider: 'primary', providers: [{ slug: 'primary', aliases: ['custom:primary'],
    name: '创作模型', models: ['profile-default', 'saved-writer'], capabilities: {
      'saved-writer': { fast: false, reasoning: true, supported_efforts: ['low', 'medium', 'high'] }
    } }] })
  let watching = true
  const calls: string[] = []
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    calls.push(method)
    if (method === 'session.resume') {
      watching = Boolean((params as { lazy?: boolean }).lazy)
      return { session_id: 'restored-live', stored_session_id: 'stored', messages: [], message_count: 0,
        info: watching ? { model: 'profile-default', lazy: true } : { model: 'saved-writer', provider: 'primary', lazy: true } }
    }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'session.events.since') return { events: [] }
    throw new Error('恢复历史不能修改模型或提交创作')
  }) as WorkspaceApi['rpc'])
  vi.spyOn(workspace.api, 'materials').mockResolvedValue({ project: null, sources: [] })
  render(<Composer />)
  await act(async () => {
    await workspace.open('stored')
    if (!watching) workspace.receive({ type: 'session.info', session_id: 'restored-live', payload: {
      model: 'saved-writer', provider: 'custom:primary', running: false, reasoning_effort: 'low', reasoning_effort_wire: 'low'
    } })
  })
  expect(screen.getByRole('combobox', { name: '创作模型' }).textContent).toContain('巨豹创作模型 2')
  expect(screen.getByRole('combobox', { name: '思考强度' }).textContent).toContain('低')
  expect(calls).not.toContain('config.set')
  expect(calls).not.toContain('prompt.submit')
})

test('禁用模型和思考强度时说明当前阻塞原因，并为 Agent 菜单提供可追踪关系', () => {
  workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: { model: 'model-alpha', provider: 'primary' } })
  workspace.models.set({ providers: [{ slug: 'primary', name: '主服务', models: ['model-alpha'], capabilities: {
    'model-alpha': { fast: false, reasoning: true, supported_efforts: ['low', 'medium', 'high'] }
  } }] })
  workspace.conversation.set({ runtimeId: 'live', entries: [], running: true, error: '' })
  render(<Composer />)

  const model = screen.getByRole('combobox', { name: '创作模型' })
  const reasoning = screen.getByRole('combobox', { name: '思考强度' })
  expect(model.getAttribute('title')).toBe('本轮结束或停止后可切换模型。')
  expect(reasoning.getAttribute('title')).toContain('本轮完成后可调整')

  act(() => workspace.conversation.set({ ...workspace.conversation.get(), running: false }))
  const agent = screen.getByRole('button', { name: '选择 Agent 或独立技能' })
  expect(agent.getAttribute('aria-haspopup')).toBe('listbox')
  expect(agent.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(agent)
  expect(agent.getAttribute('aria-expanded')).toBe('true')
  const menu = screen.getByRole('listbox', { name: '剧本 Agent' })
  expect(agent.getAttribute('aria-controls')).toBe(menu.id)
  expect(screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }).getAttribute('aria-controls')).toBe(menu.id)
  expect(menu.querySelector('[role="option"]')?.getAttribute('id')).toContain(`${menu.id}-option-`)
})

test('连接尚未打开时，模型按钮解释需要先恢复连接', () => {
  workspace.session.set({ storedId: 'saved', runtimeId: 'live', info: { model: 'model-alpha', provider: 'primary' } })
  workspace.connection.set('closed')
  render(<Composer />)
  expect(screen.getByRole('combobox', { name: '创作模型' }).getAttribute('title')).toBe('连接创作服务后才能切换模型。')
})
