import { beforeEach, expect, test } from 'vitest'
import type { ConfigSetParams, RpcMethods } from '../../../shared/src/gateway-contract.generated'
import { Workspace, type WorkspaceApi } from './workspace'

beforeEach(() => localStorage.clear())

function reasoningWorkspace(rpc: WorkspaceApi['rpc']) {
  const workspace = new Workspace({ profile: 'test', rpc, materials: async () => ({ project: null, sources: [] }) })
  workspace.models.set({ model: 'test-model', provider: 'test-provider', providers: [{ slug: 'test-provider', name: '测试服务', models: ['test-model'], capabilities: {
    'test-model': { fast: false, reasoning: true, supported_efforts: ['low', 'medium', 'high'] }
  } }] })
  return workspace
}

test('思考强度随新建会话发送，已有会话只写本会话并按服务端结果校准', async () => {
  const requests: { method: keyof RpcMethods; params: unknown }[] = []
  const workspace = reasoningWorkspace((async (method, params) => {
    requests.push({ method, params })
    if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored', messages: [], message_count: 0,
      info: { model: 'test-model', provider: 'test-provider', reasoning_effort: 'high', reasoning_effort_wire: 'high' } }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'config.set') return { key: 'reasoning', value: 'medium', info: { model: 'test-model', provider: 'test-provider', reasoning_effort: 'medium', reasoning_effort_wire: 'medium' } }
    throw new Error('意外请求')
  }) as WorkspaceApi['rpc'])
  await workspace.setReasoningEffort('high')
  expect(requests).toEqual([])
  await workspace.ensureSession()
  expect(requests.find(request => request.method === 'session.create')?.params).toMatchObject({ reasoning_effort: 'high' })
  await workspace.setReasoningEffort('low')
  expect(requests.find(request => request.method === 'config.set')?.params).toEqual({ profile: 'test', session_id: 'runtime', key: 'reasoning', value: 'low', scope: 'session' })
  expect(workspace.session.get().info.reasoning_effort).toBe('medium')
  workspace.conversation.set({ runtimeId: 'runtime', entries: [], running: true, error: '' })
  await workspace.setReasoningEffort('high')
  expect(requests.filter(request => request.method === 'config.set')).toHaveLength(1)
})

test('保存失败保留原档位，迟到的思考设置结果不能覆盖另一段会话', async () => {
  let settle!: (value: RpcMethods['config.set']['result']) => void
  let fail = true
  const workspace = reasoningWorkspace((async (method, params) => {
    if (method !== 'config.set') throw new Error('意外请求')
    expect((params as ConfigSetParams).scope).toBe('session')
    if (fail) throw new Error('暂时断开')
    return new Promise(resolve => { settle = resolve })
  }) as WorkspaceApi['rpc'])
  workspace.session.set({ storedId: 'stored', runtimeId: 'runtime', info: { model: 'test-model', provider: 'test-provider', reasoning_effort: 'low' } })
  await workspace.setReasoningEffort('high')
  expect(workspace.session.get().info.reasoning_effort).toBe('low')
  expect(workspace.reasoning.get().error).toContain('暂时断开')
  fail = false
  const saving = workspace.setReasoningEffort('high')
  workspace.newConversation()
  settle({ key: 'reasoning', value: 'high' })
  await saving
  expect(workspace.session.get().runtimeId).toBe('')
  expect(workspace.session.get().info.reasoning_effort).toBeUndefined()
  expect(workspace.reasoning.get().saving).toBe(false)
})

test('模型指定的默认思考用于新建会话，用户仍能选择其他受支持档位', async () => {
  let created: unknown
  const workspace = reasoningWorkspace((async (method, params) => {
    if (method === 'session.create') { created = params; return { session_id: 'live', stored_session_id: 'stored', messages: [], message_count: 0, info: { model: 'test-model', provider: 'test-provider', reasoning_effort: 'high' } } }
    if (method === 'session.list') return { sessions: [] }
    throw new Error('意外请求')
  }) as WorkspaceApi['rpc'])
  const catalog = workspace.models.get()
  catalog.providers[0].capabilities!['test-model'] = { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' }
  workspace.models.set(catalog)
  workspace.selectModel('test-model', 'test-provider')
  expect(workspace.session.get().info.reasoning_effort).toBe('high')
  await workspace.ensureSession()
  expect(created).toMatchObject({ reasoning_effort: 'high' })
})

test('模型目录短暂刷新失败会自动重试，恢复后不再残留“目录未刷新”提示', async () => {
  let calls = 0
  const options = { model: 'test-model', provider: 'test-provider', providers: [] }
  const workspace = reasoningWorkspace((async method => {
    if (method !== 'model.options') throw new Error('意外请求')
    calls += 1
    if (calls === 1) throw new Error('创作服务暂时不可用')
    return options
  }) as WorkspaceApi['rpc'])
  workspace.reasoning.set({ ...workspace.reasoning.get(), error: '模型目录暂未刷新，请稍后新建对话重试。' })
  await workspace.refreshModels()
  expect(calls).toBe(2)
  expect(workspace.reasoning.get().error).toBe('')
  expect(workspace.models.get()).toEqual(options)
}, 10000)
