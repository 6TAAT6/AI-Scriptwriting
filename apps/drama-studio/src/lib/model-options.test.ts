import { expect, it } from 'vitest'
import { creationModelOptions } from './model-options'

it('文字和生图按用途分组，显示名来自服务端映射，相同名称仍保留各自服务路由', () => {
  const options = creationModelOptions({ providers: [
    { slug: 'gpt', name: '内部代理名', models: ['gpt-6-astra'], image_models: ['gpt-image-2.5-sunburst'],
      display_names: { 'gpt-6-astra': '巨豹测试版 V2.0' }, image_display_names: { 'gpt-image-2.5-sunburst': '巨豹生图 V1' } },
    { slug: 'gemini', name: '另一个内部代理名', models: ['gemini-3.8-flash-high'], image_models: ['gemini-3.1-flash-image'],
      display_names: { 'gemini-3.8-flash-high': '巨豹满血版 V1.1' }, image_display_names: { 'gemini-3.1-flash-image': '巨豹生图 V2' } },
    { slug: 'grok', name: 'Grok', models: ['grok-4.7'] }
  ] })
  expect(options.map(row => [row.label, row.group, row.provider])).toEqual([
    ['巨豹测试版 V2.0', '文字模型', 'gpt'], ['巨豹满血版 V1.1', '文字模型', 'gemini'], ['巨豹创作模型 1', '文字模型', 'grok'],
    ['巨豹生图 V1', '生图模型', 'gpt'], ['巨豹生图 V2', '生图模型', 'gemini']
  ])
  // 搜索只匹配显示名，不能用真实模型名反推映射。
  expect(options.every(row => row.searchText === row.label)).toBe(true)
})

it('未知模型只显示业务名称，不把真实模型 ID 回退到界面', () => {
  const options = creationModelOptions({ providers: [{ slug: 'custom', name: '内部服务', models: ['vendor-secret-model'] }] })
  expect(options[0]).toMatchObject({ label: '巨豹创作模型 1', model: 'vendor-secret-model' })
  expect(options[0].label).not.toContain('vendor-secret-model')
})
