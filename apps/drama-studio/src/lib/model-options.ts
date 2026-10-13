import type { StudioModelOptions } from './reasoning'

export function modelDisplayName(model: string, kind: 'text' | 'image', catalog?: StudioModelOptions) {
  for (const provider of catalog?.providers ?? []) {
    const label = (kind === 'text' ? provider.display_names : provider.image_display_names)?.[model]
    if (label) return label
  }
  return kind === 'text' ? '巨豹创作模型' : '巨豹生图模型'
}

export function creationModelOptions(catalog: StudioModelOptions) {
  let unknownText = 0
  let unknownImages = 0
  const text = catalog.providers.flatMap(provider => (provider.models || []).map(model => {
    const label = provider.display_names?.[model] || `巨豹创作模型 ${++unknownText}`
    return { value: JSON.stringify(['text', provider.slug, model]), label, group: '文字模型', badge: '文字模型', searchText: label, kind: 'text' as const, provider: provider.slug, model }
  }))
  const images = catalog.providers.flatMap(provider => (provider.image_models || []).map(model => {
    const label = provider.image_display_names?.[model] || `巨豹生图模型 ${++unknownImages}`
    return { value: JSON.stringify(['image', provider.slug, model]), label, group: '生图模型', badge: '生图模型', searchText: label, kind: 'image' as const, provider: provider.slug, model }
  }))
  return [...text, ...images]
}
