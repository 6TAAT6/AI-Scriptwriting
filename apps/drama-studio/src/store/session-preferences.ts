import { atom } from 'nanostores'
import type { SessionLiveInfo, TranscriptMessage } from '../../../shared/src/gateway-contract.generated'

export interface ImageModelSelection { model: string; provider: string }
export interface CreativePreferences { region: string; language: string; imageModel?: ImageModelSelection; northAmericaSelected?: boolean }
export interface StoredPreferences extends CreativePreferences { draftModel?: Pick<SessionLiveInfo, 'model' | 'provider' | 'reasoning_effort'> }
export type PreferenceScope = readonly ['session', string] | readonly ['draft', string | null]

export const defaultPreferences = (): CreativePreferences => ({ region: '中国', language: '仅中文', imageModel: undefined })
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value)

function parsePreferences(value: unknown): StoredPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (!['中国', '北美', '欧美'].includes(String(row.region)) || !['仅中文', '中英双语'].includes(String(row.language))) return
  const preferences: StoredPreferences = { region: row.region === '欧美' ? '北美' : String(row.region), language: String(row.language), imageModel: undefined }
  if (typeof row.northAmericaSelected === 'boolean') preferences.northAmericaSelected = row.northAmericaSelected
  if (row.imageModel != null) {
    const image = row.imageModel as Record<string, unknown>
    if (!identifier(image.model) || !identifier(image.provider)) return
    preferences.imageModel = { model: image.model, provider: image.provider }
  }
  if (row.draftModel != null) {
    const model = row.draftModel as Record<string, unknown>
    if (['model', 'provider', 'reasoning_effort'].some(key => model[key] != null && !identifier(model[key]))) return
    preferences.draftModel = { ...(model.model ? { model: String(model.model) } : {}), ...(model.provider ? { provider: String(model.provider) } : {}),
      ...(model.reasoning_effort ? { reasoning_effort: String(model.reasoning_effort) } : {}) }
  }
  return preferences
}

/** 只接受独立用户消息的标准控制头；引用、助手文本和压缩摘要不产生设置。 */
function messagePreferences(message: TranscriptMessage): CreativePreferences | undefined {
  if (message.role !== 'user' || message.display_kind || message._compressed_summary) return
  const raw = message.text ?? message.content
  if (typeof raw !== 'string' || !raw.startsWith('【本轮语言偏好】\n')) return
  const marker = '\n\n【用户本轮消息】\n', boundary = raw.indexOf(marker)
  if (boundary < 0) return
  const header = raw.slice(0, boundary)
  const structured = header.match(/\n【本轮创作设置】\n([^\n]+)(?:\n|$)/)
  if (structured) {
    try { return parsePreferences(JSON.parse(structured[1])) } catch { return }
  }
  const region = header.match(/创作故事时的地区偏好为(中国|北美|欧美)，仅在本轮涉及故事创作且用户没有另行指定时使用。/)?.[1]
  const language = header.includes('用户已在创作设置中明确选择中英双语台词，台词按此选择生成；本轮消息中的明确语言要求优先。') ? '中英双语'
    : header.includes('当前创作设置为仅中文；历史项目或规则包中的默认双语不代表用户本轮要求双语。') ? '仅中文' : undefined
  return region && language ? { region: region === '欧美' ? '北美' : region, language, imageModel: undefined } : undefined
}

function historyPreferences(messages: TranscriptMessage[]): CreativePreferences | undefined {
  let latest: { preferences: CreativePreferences; timestamp?: number } | undefined
  const seen = new Set<string>()
  for (const message of messages) {
    const preferences = messagePreferences(message)
    if (!preferences) continue
    const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : undefined
    // 压缩副本会获得新的 row_id，但保留原消息时间；不能将较大的行号当成新修改。
    const identity = message.message_uid || (timestamp !== undefined ? JSON.stringify([timestamp, message.text ?? message.content]) : undefined)
    if (identity && seen.has(identity)) continue
    if (identity) seen.add(identity)
    if (!latest || timestamp === undefined && latest.timestamp === undefined || timestamp !== undefined && (latest.timestamp === undefined || timestamp >= latest.timestamp)) latest = { preferences, timestamp }
  }
  return latest?.preferences
}

/** 只保存非敏感选择，不保存正文、附件、凭据或会话授权信息。 */
export class SessionPreferenceStore {
  readonly error = atom('')
  private readonly pending = new Map<string, StoredPreferences>()
  private readonly failures = new Map<string, string>()
  private key(profile: string, scope: PreferenceScope) { return `drama-studio:preferences:v1:${JSON.stringify([profile, ...scope])}` }
  private report(key: string, error = '') {
    if (error) this.failures.set(key, error)
    else this.failures.delete(key)
    this.error.set([...this.failures.values()][0] ?? '')
  }
  clearErrors() { this.pending.clear(); this.failures.clear(); this.error.set('') }

  read(profile: string, scope: PreferenceScope, messages: TranscriptMessage[] = []): StoredPreferences {
    const key = this.key(profile, scope), pending = this.pending.get(key)
    if (pending) return pending
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        const value = JSON.parse(raw), saved = parsePreferences(value)
        if (!saved) throw new Error('偏好记录格式不正确')
        this.report(key)
        if (value.region === '欧美') this.save(profile, scope, saved)
        return saved
      }
      this.report(key)
    } catch {
      this.report(key, '创作偏好读取失败，请重新选择地区、台词语言和模型后再继续；已有会话的文字模型与思考强度仍以服务端为准。')
      return defaultPreferences()
    }
    const recovered = scope[0] === 'session' ? historyPreferences(messages) : undefined
    if (recovered) this.save(profile, scope, recovered)
    return recovered ?? defaultPreferences()
  }

  save(profile: string, scope: PreferenceScope, value: StoredPreferences) {
    const key = this.key(profile, scope), preferences = parsePreferences(value)
    if (!preferences) { this.report(key, '创作偏好未保存，请重新选择有效的地区、台词语言和模型。'); return false }
    if (scope[0] === 'session') delete preferences.draftModel
    try {
      localStorage.setItem(key, JSON.stringify(preferences))
      this.pending.delete(key)
      this.report(key)
      return true
    } catch {
      this.pending.set(key, preferences)
      this.report(key, '创作偏好未保存到此浏览器，当前页面仍使用本次选择。请勿刷新，检查浏览器存储后重新选择。')
      return false
    }
  }

  migrate(profile: string, previousId: string, storedId: string) {
    if (previousId === storedId) return
    const source = this.key(profile, ['session', previousId]), target = this.key(profile, ['session', storedId])
    try {
      // 再次从旧 ID 打开时，新 ID 上后来的手选不可被祖先记录倒灌。
      if (this.pending.has(target) || localStorage.getItem(target) !== null) return
      const raw = localStorage.getItem(source)
      const saved = this.pending.get(source) ?? (raw === null ? undefined : parsePreferences(JSON.parse(raw)))
      if (saved && this.save(profile, ['session', storedId], saved)) this.remove(profile, ['session', previousId])
    } catch { this.report(source, '创作偏好迁移失败，请重新选择后再继续。') }
  }

  remove(profile: string, scope: PreferenceScope) {
    const key = this.key(profile, scope)
    try { localStorage.removeItem(key); this.pending.delete(key); this.report(key) }
    catch { this.report(key, '创作偏好清理失败，请检查浏览器存储。') }
  }
}
