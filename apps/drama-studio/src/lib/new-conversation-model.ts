import type { SessionLiveInfo } from '../../../shared/src/gateway-contract.generated'
import { modelReasoning, type StudioModelOptions } from './reasoning'

export function resolveNewConversationModel(catalog: StudioModelOptions, role?: string | null, selection: SessionLiveInfo = {}): SessionLiveInfo {
  const employeeDefault = !selection.model && (role === 'admin' || role === 'employee')
  const available = catalog.providers.flatMap(provider => provider.authenticated === false ? [] : (provider.models ?? [])
    .filter(model => !provider.unavailable_models?.includes(model)).map(model => ({ model, provider: provider.slug })))
  const first = available.find(row => row.model === 'brand-text-1') || available[0]
  const model = selection.model || first?.model || catalog.model
  const preferredProvider = selection.model ? selection.provider || catalog.provider : first?.provider || catalog.provider
  const candidates = catalog.providers.filter(row => row.authenticated !== false && model && row.models?.includes(model)
    && !row.unavailable_models?.includes(model))
  const preferred = candidates.filter(row => row.slug === preferredProvider || row.aliases?.includes(preferredProvider || ''))
  const matched = preferred.length === 1 ? preferred[0] : candidates.length === 1 ? candidates[0] : undefined
  if (employeeDefault && !matched) throw new Error('默认创作模型暂不可用，请刷新模型目录或手动选择其他模型。')
  if (selection.model && (!matched || selection.provider && matched.slug !== selection.provider && !matched.aliases?.includes(selection.provider))) {
    throw new Error('所选创作模型暂不可用，请刷新模型目录并重新选择。')
  }
  const provider = matched?.slug || preferredProvider
  const { efforts, defaultEffort } = modelReasoning(catalog, { model, provider })
  const effort = efforts.find(value => value === selection.reasoning_effort) || defaultEffort
  return { model, provider, ...(effort ? { reasoning_effort: effort } : {}) }
}
