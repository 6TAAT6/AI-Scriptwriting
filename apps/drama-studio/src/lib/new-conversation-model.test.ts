import { expect, it } from 'vitest'
import { resolveNewConversationModel } from './new-conversation-model'
import type { StudioModelOptions } from './reasoning'

function catalog(): StudioModelOptions {
  return { model: 'legacy-writer', provider: 'previous-route', providers: [
    { slug: 'previous-route', name: '原服务', models: ['legacy-writer'], capabilities: {
      'legacy-writer': { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'low' }
    } },
    { slug: 'available-gm-route', aliases: ['custom:available-gm-route'], name: '可用服务', models: ['brand-text-1'], capabilities: {
      'brand-text-1': { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' }
    } }
  ] }
}

// brand-text-1 是显示名映射中的首个文字模型（当前配置为“巨豹满血版 V1.1”），新对话默认使用它；
// 目录中没有时退回第一个可用模型。手动选择始终优先。
it('新对话默认使用首个品牌模型，手动选择优先', () => {
  const options = catalog()
  const original = structuredClone(options)
  for (const role of ['admin', 'employee', 'super_admin', undefined, null]) {
    expect(resolveNewConversationModel(options, role)).toEqual({ model: 'brand-text-1', provider: 'available-gm-route', reasoning_effort: 'high' })
    expect(resolveNewConversationModel(options, role, { model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'high' }))
      .toEqual({ model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'high' })
  }
  expect(resolveNewConversationModel(options, 'employee', { model: 'brand-text-1', provider: 'custom:available-gm-route', reasoning_effort: 'ultra' }))
    .toEqual({ model: 'brand-text-1', provider: 'available-gm-route', reasoning_effort: 'high' })
  expect(options).toEqual(original)
})

it('没有品牌模型时使用第一个可用模型，所选模型不可用时明确报错', () => {
  const missing = catalog()
  missing.providers.pop()
  expect(resolveNewConversationModel(missing, 'employee')).toEqual({ model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'low' })

  const duplicate = catalog()
  duplicate.providers.push({ slug: 'another-gm-route', name: '另一服务', models: ['brand-text-1'] })
  expect(resolveNewConversationModel(duplicate, 'admin')).toEqual({ model: 'brand-text-1', provider: 'available-gm-route', reasoning_effort: 'high' })

  const unavailable = catalog()
  unavailable.providers[1].authenticated = false
  expect(resolveNewConversationModel(unavailable, 'employee')).toEqual({ model: 'legacy-writer', provider: 'previous-route', reasoning_effort: 'low' })
  expect(() => resolveNewConversationModel(catalog(), 'employee', { model: 'missing-writer', provider: 'previous-route' }))
    .toThrow(/所选创作模型.*重新选择/)
})
