import { beforeEach, expect, test } from 'vitest'
import { Workspace, type WorkspaceApi } from './workspace'
import type { ConfigSetParams, RpcMethods } from '../../../shared/src/gateway-contract.generated'

beforeEach(() => localStorage.clear())

function fixture(rpc: WorkspaceApi['rpc']) {
  const workspace = new Workspace({ profile: 'writer', rpc, materials: async () => ({ project: null, sources: [] }) })
  workspace.connection.set('open')
  workspace.models.set({ model: 'writer-a', provider: 'first', providers: [
    { slug: 'first', name: '文字服务一', models: ['writer-a'] },
    { slug: 'second', aliases: ['custom:second'], name: '文字服务二', models: ['writer-b'], capabilities: {
      'writer-b': { fast: false, reasoning: true, supported_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'high' }
    } }
  ] })
  workspace.session.set({ runtimeId: 'live', storedId: 'stored', info: { model: 'writer-a', provider: 'first' } })
  workspace.conversation.set({ runtimeId: 'live', running: false, error: '', entries: [{ id: 'history', role: 'user', text: '原稿已上传。', calls: [] }] })
  workspace.editComposer({ text: '我正在编辑的新要求', attachments: [{ attached: true, name: '原稿.docx', path: '/assets-data/fixture/原稿.docx', ref_path: '/assets-data/fixture/原稿.docx', ref_text: '@file:原稿.docx', uploaded: true }] })
  return workspace
}

test('已有对话切换文字模型后沿用原会话和附件，切换完成前阻止发送', async () => {
  let complete!: (result: RpcMethods['config.set']['result']) => void
  const calls: { method: string; params: unknown }[] = []
  const workspace = fixture((async (method, params) => {
    calls.push({ method, params })
    if (method !== 'config.set') throw new Error('切换期间不得发送新创作')
    return new Promise(resolve => { complete = resolve })
  }) as WorkspaceApi['rpc'])
  const draft = workspace.composer.get(), history = workspace.conversation.get()
  const changing = workspace.selectModel('writer-b', 'second')
  expect(calls).toEqual([{ method: 'config.set', params: { profile: 'writer', session_id: 'live', key: 'model', scope: 'session', value: { model: 'writer-b', provider: 'second', reasoning_effort: 'high' } } }])
  await workspace.send()
  expect(calls).toHaveLength(1)
  expect(workspace.session.get().info.model).toBe('writer-a')
  complete({ key: 'model', value: 'writer-b', scope: 'session', info: { model: 'writer-b', provider: 'custom:second', reasoning_effort: 'high' } })
  await changing
  expect(workspace.session.get()).toMatchObject({ storedId: 'stored', runtimeId: 'live', info: { model: 'writer-b', reasoning_effort: 'high' } })
  expect(workspace.conversation.get()).toBe(history)
  expect(workspace.composer.get().text).toBe(draft.text)
  expect(workspace.composer.get().attachments).toEqual(draft.attachments)
})

test('失败或迟到的切换回执不改变其他对话，生成中不能切换', async () => {
  let settle!: (result: RpcMethods['config.set']['result']) => void, fail = true, calls = 0
  const workspace = fixture((async (_method, params) => {
    calls++
    expect((params as ConfigSetParams).scope).toBe('session')
    if (fail) throw new Error('连接暂时不可用')
    return new Promise(resolve => { settle = resolve })
  }) as WorkspaceApi['rpc'])
  await workspace.selectModel('writer-b', 'second')
  expect(workspace.session.get().info.model).toBe('writer-a')
  expect(calls).toBe(1)
  workspace.conversation.set({ ...workspace.conversation.get(), running: true })
  await workspace.selectModel('writer-b', 'second')
  expect(calls).toBe(1)
  workspace.conversation.set({ ...workspace.conversation.get(), running: false })
  fail = false
  const pending = workspace.selectModel('writer-b', 'second')
  workspace.connection.set('closed')
  workspace.newConversation()
  settle({ key: 'model', value: 'writer-b', info: { model: 'writer-b', provider: 'second' } })
  await pending
  expect(workspace.session.get().runtimeId).toBe('')
  expect(workspace.session.get().info.model).toBeUndefined()
})

test('员工新会话使用首个品牌模型，手动模型与思考草稿刷新后优先', async () => {
  const requests: { method: string; params: unknown }[] = []
  const catalog = { model: 'writer-a', provider: 'first', providers: [{ slug: 'first', name: '创作服务', models: ['writer-a', 'brand-text-1'], capabilities: {
    'writer-a': { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' },
    'brand-text-1': { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' }
  } }] }
  const api: WorkspaceApi = { profile: 'new-employee', materials: async () => ({ project: null, sources: [] }), rpc: (async (method, params) => {
    requests.push({ method, params })
    if (method === 'session.create') return { session_id: 'live', stored_session_id: 'created', messages: [], message_count: 0, info: {} }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'model.options') return catalog
    throw new Error('不应改写已有模型配置')
  }) as WorkspaceApi['rpc'] }
  const workspace = new Workspace(api, undefined, () => 'employee')
  workspace.models.set(catalog)
  await workspace.ensureSession()
  expect(requests.find(row => row.method === 'session.create')?.params).toMatchObject({ model: 'brand-text-1', provider: 'first', reasoning_effort: 'high' })
  workspace.newConversation()
  await workspace.selectModel('writer-a', 'first')
  await workspace.setReasoningEffort('low')
  const restored = new Workspace(api, undefined, () => 'employee')
  restored.models.set(catalog)
  expect(restored.modelSelection()).toMatchObject({ model: 'writer-a', provider: 'first', reasoning_effort: 'low' })
  requests.length = 0
  await restored.ensureSession()
  expect(requests.find(row => row.method === 'session.create')?.params).toMatchObject({ model: 'writer-a', reasoning_effort: 'low' })
  expect(requests.some(row => row.method === 'config.set')).toBe(false)
  const bootstrap = new Workspace(api, undefined, () => 'employee')
  bootstrap.models.set(catalog)
  await bootstrap.selectModel('writer-a', 'first')
  const beforeLogin = new Workspace(api, undefined, () => 'employee')
  expect(beforeLogin.session.get().info.model).toBe('writer-a')
  api.profile = 'another-employee'
  await beforeLogin.initialize(false)
  expect(beforeLogin.session.get().info.model).toBeUndefined()
  expect(beforeLogin.modelSelection().model).toBe('brand-text-1')
})
