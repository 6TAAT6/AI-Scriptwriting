import { expect, it } from 'vitest'
import { resolveNewConversationModel } from './new-conversation-model'
import type { StudioModelOptions } from './reasoning'

function catalog(): StudioModelOptions {
  return { model: 'model-full', provider: 'available-gm-route', providers: [
    { slug: 'previous-route', name: '原服务', models: ['legacy-writer'], capabilities: {
      'legacy-writer': { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'low' }
    } },
    { slug: 'available-gm-route', aliases: ['custom:available-gm-route'], name: '可用服务', models: ['model-full'], capabilities: {
      'model-full': { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' }
    } }
  ] }
}

it('新对话使用服务端提供的默认路由，手动选择优先且不依赖真实模型名', () => {
  const options = catalog()
  const original = structuredClone(options)
  for (const role of ['admin', 'employee']) {
    expect(resolveNewConversationModel(options, role)).toEqual({ model: 'model-full', provider: 'available-gm-route', reasoning_effort: 'high' })
    expect(resolveNewConversationModel(options, role, { model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'high' }))
      .toEqual({ model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'high' })
  }
  for (const role of ['super_admin', undefined, null]) {
    expect(resolveNewConversationModel(options, role)).toEqual({ model: 'model-full', provider: 'available-gm-route', reasoning_effort: 'high' })
  }
  expect(resolveNewConversationModel(options, 'employee', { model: 'model-full', provider: 'custom:available-gm-route', reasoning_effort: 'ultra' }))
    .toEqual({ model: 'model-full', provider: 'available-gm-route', reasoning_effort: 'high' })
  expect(options).toEqual(original)
})

it('默认目录项缺失或路由不明确时明确报错，并允许改选当前可用模型', () => {
  const missing = catalog()
  missing.providers.pop()
  expect(() => resolveNewConversationModel(missing, 'employee')).toThrow(/默认创作模型.*手动选择/)
  expect(resolveNewConversationModel(missing, 'employee', { model: 'legacy-writer', provider: 'previous-route' }))
    .toEqual({ model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'low' })

  const duplicate = catalog()
  duplicate.provider = 'unknown-route'
  duplicate.providers.push({ slug: 'another-gm-route', name: '另一服务', models: ['model-full'] })
  expect(() => resolveNewConversationModel(duplicate, 'admin')).toThrow(/默认创作模型.*手动选择/)
  duplicate.provider = 'custom:available-gm-route'
  expect(resolveNewConversationModel(duplicate, 'admin')).toEqual({ model: 'model-full', provider: 'available-gm-route', reasoning_effort: 'high' })

  const unavailable = catalog()
  unavailable.providers[1].authenticated = false
  expect(() => resolveNewConversationModel(unavailable, 'employee')).toThrow(/默认创作模型/)
  expect(() => resolveNewConversationModel(catalog(), 'employee', { model: 'missing-writer', provider: 'previous-route' }))
    .toThrow(/所选创作模型.*重新选择/)
})
