import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../App'
import { Workspace, workspace, type WorkspaceApi } from './workspace'

const catalog = { model: 'gpt-6', provider: 'primary', providers: [{ slug: 'primary', name: '创作模型', models: ['gpt-6'] }] }

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { cleanup(); workspace.reset(); localStorage.clear(); vi.restoreAllMocks() })

it('首次连接未完成时首页可编辑，服务就绪前不发送，迟到的历史记录不覆盖新草稿', async () => {
  workspace.reset()
  workspace.connection.set('open')
  const history = pending<{ sessions: { id: string }[] }>()
  const models = pending<typeof catalog>()
  const calls: string[] = []
  vi.spyOn(workspace.projects!, 'load').mockResolvedValue()
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async method => {
    calls.push(method)
    if (method === 'session.list') return history.promise
    if (method === 'model.options') return models.promise
    throw new Error('准备期间不应创建或发送会话')
  }) as WorkspaceApi['rpc'])
  localStorage.setItem(`drama-studio:${workspace.api.profile}:selected`, 'previous')
  let initialized!: Promise<void>
  act(() => { initialized = workspace.initialize() })
  render(<App />)
  try {
    const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }) as HTMLTextAreaElement
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: '等待时写下的新想法' } })
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true)
    await workspace.send()
    expect(calls).not.toContain('prompt.submit')
    expect(calls).not.toContain('session.create')
    await act(async () => { history.resolve({ sessions: [{ id: 'previous' }] }); models.resolve(catalog); await initialized })
    expect(input.value).toBe('等待时写下的新想法')
    expect(calls).not.toContain('session.resume')
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)
  } finally {
    await act(async () => { history.resolve({ sessions: [] }); models.resolve(catalog); await initialized })
  }
})

it('模型目录较慢时已有聊天先恢复，切换账号后迟到目录不能写回旧状态', async () => {
  const models = pending<typeof catalog>()
  const local = new Workspace({ profile: 'startup', materials: async () => ({ project: null, sources: [] }),
    rpc: (async method => {
      if (method === 'session.list') return { sessions: [{ id: 'saved' }] }
      if (method === 'model.options') return models.promise
      if (method === 'session.resume') return { session_id: 'live', stored_session_id: 'saved', messages: [{ role: 'assistant', content: '已保存的剧本' }], info: {}, message_count: 1 }
      if (method === 'subagent.list') return { subagents: [] }
      if (method === 'session.events.since') return { events: [] }
      throw new Error('不应调用模型生成')
    }) as WorkspaceApi['rpc'] })
  localStorage.setItem('drama-studio:startup:selected', 'saved')
  const initialized = local.initialize()
  try {
    await waitFor(() => expect(local.session.get().storedId).toBe('saved'))
    expect(local.navigation.get().loading).toBe(false)
    local.reset()
    models.resolve(catalog)
    await initialized
    expect(local.models.get().providers).toEqual([])
    expect(local.session.get().storedId).toBe('')
  } finally { models.resolve(catalog); await initialized }
})

it('后台恢复当前对话时保持输入区，恢复响应不覆盖等待期间继续输入的草稿', async () => {
  const response = pending<{ session_id: string; stored_session_id: string; info: {}; messages: []; message_count: number }>()
  const local = new Workspace({ profile: 'recover', materials: async () => ({ project: null, sources: [] }), rpc: (async method => {
    if (method === 'session.resume') return response.promise
    if (method === 'session.events.since') return { events: [] }
    if (method === 'subagent.list') return { subagents: [] }
    throw new Error('恢复连接不应提交创作')
  }) as WorkspaceApi['rpc'] })
  local.session.set({ runtimeId: 'old-live', storedId: 'saved', info: {} })
  local.editComposer({ text: '原来的草稿' })
  const recovering = local.open('saved', { background: true })
  expect(local.navigation.get().loading).toBe(false)
  local.editComposer({ text: '等待恢复时继续输入的草稿' })
  response.resolve({ session_id: 'new-live', stored_session_id: 'saved', info: {}, messages: [], message_count: 0 })
  await recovering
  expect(local.session.get().runtimeId).toBe('new-live')
  expect(local.composer.get().text).toBe('等待恢复时继续输入的草稿')
  expect(local.startup.get().history).toBe(false)
  const late = local.open('saved', { background: true })
  local.newConversation(null)
  await late
  expect(local.session.get().storedId).toBe('')
  expect(local.startup.get().history).toBe(false)
})
