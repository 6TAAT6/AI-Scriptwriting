import type { ModelCapabilities, ModelOptionProvider, ModelOptionsResult, SessionLiveInfo } from '../../../shared/src/gateway-contract.generated'
import { REASONING_EFFORT_VALUES } from '../../../shared/src/reasoning-effort'

interface StudioModelCapabilities extends ModelCapabilities { supported_efforts?: string[]; default_reasoning_effort?: string; context_length?: number }
interface StudioModelProvider extends ModelOptionProvider { capabilities?: Record<string, StudioModelCapabilities> | null; image_models?: string[]; image_model?: string; display_names?: Record<string, string>; image_display_names?: Record<string, string> }
export interface StudioModelOptions extends ModelOptionsResult { providers: StudioModelProvider[] }
export interface StudioSessionLiveInfo extends SessionLiveInfo {
  model_capabilities?: { model: string; capabilities: StudioModelCapabilities }
}

const labels: Record<string, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '超高' }
export const reasoningLabel = (effort: string) => labels[effort] || effort

export function modelReasoning(catalog: StudioModelOptions, info: StudioSessionLiveInfo) {
  const model = info.model || catalog.model || ''
  const rawProvider = String(info.provider || catalog.provider || '')
  const provider = rawProvider === 'custom' ? catalog.provider : rawProvider.replace(/^custom:/, '')
  const candidates = catalog.providers.filter(row => row.slug === provider || row.aliases?.some(alias => alias === rawProvider || alias.replace(/^custom:/, '') === provider))
  // 品牌入口可以改绑，旧会话仍以实际使用的模型能力为准；切换入口时不沿用旧快照。
  const snapshot = info.model_capabilities?.model === model ? info.model_capabilities.capabilities : undefined
  const snapshotHasEfforts = Array.isArray(snapshot?.supported_efforts) && snapshot.supported_efforts.length > 0
  const caps = snapshotHasEfforts ? snapshot : candidates.length === 1 ? candidates[0].capabilities?.[model] : undefined
  const declared = Array.isArray(caps?.supported_efforts) ? caps.supported_efforts : []
  const efforts = caps?.reasoning ? REASONING_EFFORT_VALUES.filter(value => declared.includes(value) && (value !== 'none' || caps.can_disable_reasoning !== false)) : []
  const defaultEffort = efforts.find(value => value === caps?.default_reasoning_effort)
  return { efforts, options: efforts.map(value => ({ value, label: reasoningLabel(value) })), supported: caps?.reasoning, defaultEffort }
}
