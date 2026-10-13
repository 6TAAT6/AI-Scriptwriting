import { expect, test } from 'vitest'
import { modelReasoning, type StudioModelOptions } from './reasoning'

test('品牌入口改绑后旧会话保留实际模型思考能力，换选其他入口时采用新目录', () => {
  const catalog: StudioModelOptions = { model: 'brand-text-1', provider: 'jubao-models', providers: [{
    slug: 'jubao-models', name: '巨豹创作模型', models: ['brand-text-1', 'brand-text-2'], capabilities: {
      'brand-text-1': { fast: false, reasoning: true, supported_efforts: ['none', 'ultra'], default_reasoning_effort: 'ultra' },
      'brand-text-2': { fast: false, reasoning: true, supported_efforts: ['medium', 'max'], default_reasoning_effort: 'max' }
    }
  }] }
  const session = { model: 'brand-text-1', provider: 'jubao-models', reasoning_effort: 'high', model_capabilities: {
    model: 'brand-text-1', capabilities: { fast: false, reasoning: true, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' }
  } }
  expect(modelReasoning(catalog, session)).toMatchObject({ efforts: ['low', 'high'], defaultEffort: 'high' })
  expect(modelReasoning(catalog, { ...session, model: 'brand-text-2' })).toMatchObject({ efforts: ['medium', 'max'], defaultEffort: 'max' })
  expect(modelReasoning(catalog, { model: 'brand-text-1', provider: 'jubao-models' })).toMatchObject({ efforts: ['none', 'ultra'], defaultEffort: 'ultra' })
})
