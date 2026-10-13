import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StudioBackend, authorizeRpc } from '../backend.mjs'
import { safeCapabilities, supportedEfforts } from '../reasoning.mjs'

test('思考强度只可设置当前账号空闲会话声明支持的档位，不能改变全局配置', async () => {
  const user = { id: 'writer', role: 'employee', profile: 'writer' }
  const backend = new StudioBackend({ backend: 'http://127.0.0.1:1', repoRoot: '/fixture', backendToken: 'fixture-only' })
  backend.runtimeOwners.set('session', user.id)
  backend.runtimeStates = new Map([['session', { model: 'writer-model', provider: 'configured', running: false }]])
  backend.catalogs.set(user.id, { provider: 'configured', model: 'writer-model', providers: [{ slug: 'configured', models: ['writer-model'], capabilities: { 'writer-model': { reasoning: true, supported_efforts: ['low', 'high'] } } }] })
  const frame = { jsonrpc: '2.0', id: 'setting', method: 'config.set', params: { profile: 'writer', session_id: 'session', key: 'reasoning', value: 'high', scope: 'session' } }
  assert.equal((await authorizeRpc(frame, user, backend)).params.value, 'high')
  for (const patch of [{ scope: 'global' }, { key: 'model' }, { value: 'max' }, { session_id: 'other' }]) await assert.rejects(authorizeRpc({ ...frame, params: { ...frame.params, ...patch } }, user, backend))
  backend.runtimeStates.get('session').running = true
  await assert.rejects(authorizeRpc(frame, user, backend), /生成中/)
  assert.deepEqual(safeCapabilities({ 'writer-model': { reasoning: true, supported_efforts: ['low', 'high'], api_key: 'private' } }, ['writer-model']), { 'writer-model': { reasoning: true, fast: false, can_disable_reasoning: true, supported_efforts: ['low', 'high'] } })
})

test('普通账号收到真实思考档位与会话回执，其他后台配置不进入页面', async () => {
  const user = { id: 'writer', role: 'employee', profile: 'writer' }
  const backend = new StudioBackend({ backend: 'http://127.0.0.1:1', repoRoot: '/fixture', backendToken: 'fixture-only' })
  const reply = await backend.presentation.rpc(user, { method: 'model.options', params: {} }, { id: 'catalog', result: {
    provider: 'custom:configured', model: 'writer-model', providers: [{ slug: 'configured', aliases: ['custom:configured', null, { api_key: 'private' }], name: '模型服务', models: ['writer-model'], capabilities: { 'writer-model': { reasoning: true, supported_efforts: ['low', 'high'], credential: 'private' } } }]
  } })
  assert.deepEqual(reply.result.providers[0].capabilities['writer-model'].supported_efforts, ['low', 'high'])
  const resumed = { model: 'writer-model', provider: 'custom:configured', running: false }
  assert.deepEqual(supportedEfforts(reply.result, resumed), ['low', 'high'])
  backend.runtimeOwners.set('resumed', user.id)
  backend.runtimeStates.set('resumed', resumed)
  const changed = await authorizeRpc({ jsonrpc: '2.0', id: 'reasoning', method: 'config.set', params: { session_id: 'resumed', key: 'reasoning', value: 'high', scope: 'session' } }, user, backend)
  assert.equal(changed.params.value, 'high')
  assert.ok(!JSON.stringify(reply).includes('private'))
  const saved = await backend.presentation.rpc(user, { method: 'config.set', params: { key: 'reasoning' } }, { id: 'save', result: { key: 'reasoning', value: 'high', info: { reasoning_effort: 'high', reasoning_effort_wire: 'high', api_key: 'private' } } })
  assert.equal(saved.result.value, 'high')
  assert.equal(saved.result.info.reasoning_effort_wire, 'high')
  assert.ok(!JSON.stringify(saved).includes('private'))
})
