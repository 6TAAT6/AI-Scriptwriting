import { expect, it } from 'vitest'
import type { StudioModelOptions } from './reasoning'
import { creationModelOptions, modelDisplayName } from './model-options'

it('目录改名同步用于模型选择和活动显示，同名模型保留各自调用路由', () => {
  const catalog: StudioModelOptions = { providers: [
    { slug: 'first', name: '内部服务', models: ['text-1'], display_names: { 'text-1': '团队写作版' }, image_models: ['image-1'], image_display_names: { 'image-1': '团队画图版' } },
    { slug: 'second', name: '另一内部服务', models: ['text-2'], display_names: { 'text-2': '团队写作版' } }
  ] }
  const options = creationModelOptions(catalog)
  expect(options.map(row => [row.label, row.group, row.provider, row.model])).toEqual([
    ['团队写作版', '文字模型', 'first', 'text-1'], ['团队写作版', '文字模型', 'second', 'text-2'],
    ['团队画图版', '生图模型', 'first', 'image-1']
  ])
  expect(options[0].value).not.toBe(options[1].value)
  expect(options[0].searchText).toBe('团队写作版')
  catalog.providers[0].display_names!['text-1'] = '新的写作版'
  expect(creationModelOptions(catalog)[0].label).toBe('新的写作版')
  expect(modelDisplayName('text-1', 'text', catalog)).toBe('新的写作版')
  expect(modelDisplayName('image-1', 'image', catalog)).toBe('团队画图版')
})

it('未知模型不把内部名称用于显示或菜单搜索', () => {
  const options = creationModelOptions({ providers: [{ slug: 'custom', name: '内部服务', models: ['vendor-secret-model'] }] })
  expect(options[0]).toMatchObject({ label: '巨豹创作模型 1', model: 'vendor-secret-model' })
  expect(options[0].searchText).toBe(options[0].label)
  expect(modelDisplayName('vendor-secret-model', 'text')).toBe('巨豹创作模型')
})
