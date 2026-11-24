import type { TranscriptMessage } from '../../../shared/src/gateway-contract.generated'
import { attachmentText } from './attachments'
import { isSupportedFile } from '../../shared/attachments.mjs'
import { conversationSelection, type CapabilitySelection } from './capabilities'

export const DIALOGUE_LANGUAGES = ['仅中文', '中英双语'] as const
export const DEFAULT_DIALOGUE_LANGUAGE = DIALOGUE_LANGUAGES[0]

export interface EpisodeStatistics { episode: string; hanCharacters: number; nonWhitespaceCharacters: number }

const textCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

function episodeStatistics(value: unknown): EpisodeStatistics[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows = value.flatMap(item => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : undefined
    return typeof row?.episode === 'string' && textCount(row.han_characters) && textCount(row.non_whitespace_characters)
      ? [{ episode: row.episode, hanCharacters: row.han_characters, nonWhitespaceCharacters: row.non_whitespace_characters }] : []
  })
  return rows.length ? rows : undefined
}

export interface Artifact {
  id: string
  name: string
  path?: string
  content?: string
  kind: 'source' | 'document' | 'result'
  downloadPath?: string
  downloadName?: string
  downloadFormat?: string
  downloadStatus?: string
  documentKind?: string
  sourceMessageId?: string
  sourceResponseSha256?: string
  /** 质量回执记录的直接前版，不按同名推断版本。 */
  previousDocumentId?: string
  previousContentSha256?: string
  contentSha256?: string
  /** episodes 来自后端同一份回执，按集正文（不含集标题）统计，与模型核验字数同源。 */
  textStatistics?: { hanCharacters: number; nonWhitespaceCharacters: number; episodes?: EpisodeStatistics[] }
  contentVerified?: boolean
  layoutVerified?: boolean
  wpsVerified?: boolean
  /** 用户要求核验结论：checked 已通过，revision_required 未通过（仍可下载草稿）。 */
  reviewStatus?: 'checked' | 'revision_required'
  /** 同一回复中同名稿件的版本数（仅展示用）。 */
  versions?: number
}
export interface ProjectSummary { id: string; title: string; stage: string; artifacts: Artifact[]; agentId?: string }

export const STAGES = [
  { id: 'M1', label: '原剧分析' }, { id: 'H1', label: '核心确认' },
  { id: 'M2A', label: '改编方向' }, { id: 'H2', label: '方案确认' }, { id: 'M2B', label: '人物与新纲' },
  { id: 'M3', label: '正文创作' }, { id: 'M4', label: '独立审稿' }, { id: 'M5', label: '文件交付' }
]
export function stageLabel(stage?: string): string {
  return ({ H2: '方案选择', END: '阶段完成', skill: '技能创作' } as Record<string, string>)[stage ?? ''] ??
    STAGES.find(item => item.id === stage)?.label ?? '尚未开始'
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { return record(JSON.parse(value)) } catch { return null } }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function projectFromResult(value: unknown): ProjectSummary | null {
  const result = record(value)
  const project = record(result?.project)
  if (!project || typeof project.id !== 'string') return null
  const artifacts: Artifact[] = []
  const addContent = (id: string, name: string, value: unknown, kind: Artifact['kind'] = 'result') => {
    const item = record(value)
    const quality = record(item?.quality_check)
    const previousDocumentId = item?.previous_document_id ?? quality?.previous_document_id
    if (typeof item?.content === 'string' && item.content) artifacts.push({ id, name, content: item.content, kind,
      ...(typeof item.kind === 'string' ? { documentKind: item.kind } : {}),
      ...(typeof item.source_message_id === 'string' || typeof item.source_message_id === 'number' ? { sourceMessageId: String(item.source_message_id) } : {}),
      ...(typeof item.source_response_sha256 === 'string' ? { sourceResponseSha256: item.source_response_sha256 } : {}),
      ...(typeof previousDocumentId === 'string' && previousDocumentId ? { previousDocumentId } : {}),
      ...(typeof item.previous_content_sha256 === 'string' ? { previousContentSha256: item.previous_content_sha256 } : {}),
      ...(typeof item.content_sha256 === 'string' ? { contentSha256: item.content_sha256 } : {}),
      ...(item.status === 'checked' || item.status === 'revision_required' ? { reviewStatus: item.status } : {})
    })
  }
  addContent('source', '原始剧本', project.source, 'source')
  addContent('core', '核心期待与创作依据', project.core)
  addContent('plan', '已选改编方向', project.plan)
  for (const value of Array.isArray(project.artifacts) ? project.artifacts : []) {
    const row = record(value)
    if (typeof row?.id === 'string' && typeof row.name === 'string') addContent(row.id, row.name, row)
  }
  for (const key of ['outline_batches', 'script_batches'] as const) {
    const rows = Array.isArray(project[key]) ? project[key] : []
    rows.forEach((row, index) => {
      const recordValue = record(row)
      const id = typeof recordValue?.id === 'string' ? recordValue.id : `${key}-${index}`
      addContent(id, `${key === 'outline_batches' ? '新大纲' : '剧本正文'} · 第 ${index + 1} 批`, row)
    })
  }
  const artifactById = new Map(artifacts.map(artifact => [artifact.id, artifact]))
  for (const value of (Array.isArray(project.exports) ? project.exports : [])) {
    const item = record(value)
    const path = item?.path ?? item?.destination
    if (typeof path !== 'string') continue
    const name = String(item?.artifact_name ?? item?.name ?? (path.split(/[\\/]/).pop() || '交付文件'))
    const downloadName = typeof item?.name === 'string' ? item.name : path.split(/[\\/]/).pop() || name
    const format = typeof item?.format === 'string' ? item.format : name.split('.').pop()?.toLowerCase() || ''
    const artifactId = typeof item?.artifact_id === 'string' ? item.artifact_id : ''
    const source = artifactId ? artifactById.get(artifactId) : undefined
    if (source) {
      source.downloadPath = path
      source.downloadName = downloadName
      source.downloadFormat = format
      source.downloadStatus = typeof item?.status === 'string' ? item.status : undefined
      const statistics = record(item?.text_statistics)
      if (statistics?.method === 'unicode_han_and_non_whitespace_v1'
        && Number.isSafeInteger(statistics.han_characters) && Number(statistics.han_characters) >= 0
        && Number.isSafeInteger(statistics.non_whitespace_characters) && Number(statistics.non_whitespace_characters) >= 0) {
        source.textStatistics = { hanCharacters: Number(statistics.han_characters), nonWhitespaceCharacters: Number(statistics.non_whitespace_characters),
          episodes: episodeStatistics(statistics.episodes) }
      }
      source.contentVerified = item?.content_verified === true
      source.layoutVerified = item?.layout_verified === true
      source.wpsVerified = record(item?.verification)?.wps === 'passed'
      source.documentKind ??= typeof item?.source_kind === 'string' ? item.source_kind : undefined
    }
    artifacts.push({ id: `export-${path}`, name, path, kind: 'document' })
  }
  return { id: project.id, title: String(project.title ?? '未命名剧本'), stage: String(project.stage ?? 'M0'), artifacts, agentId: String(project.agent_id ?? 'oa6-1') }
}

/** 合并同一 Agent 的会话稿件，保留优先快照的阶段和同编号版本。 */
export function mergeProjectArtifacts(preferred: ProjectSummary | null, extra: ProjectSummary | null): ProjectSummary | null {
  if (!preferred) return extra
  if (!extra || preferred.agentId && extra.agentId && preferred.agentId !== extra.agentId) return preferred
  const artifacts = new Map<string, Artifact>()
  for (const artifact of [...extra.artifacts, ...preferred.artifacts]) artifacts.set(artifact.kind === 'document' ? artifact.path || artifact.id : artifact.id, artifact)
  return { ...preferred, artifacts: [...artifacts.values()] }
}

export function projectMatchesSelection(project: ProjectSummary, selection: CapabilitySelection): boolean {
  const owner = selection.agent || (selection.skills.length ? 'independent-skills' : '')
  return !owner || !project.agentId || owner === project.agentId
}

export function historyProject(messages: TranscriptMessage[]): ProjectSummary | null {
  const selection = conversationSelection(messages.map(row => ({ role: row.role, text: attachmentText(row.text ?? row.content) })))
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (row.role !== 'tool') continue
    const project = projectFromResult(row.content ?? row.text)
    if (project && projectMatchesSelection(project, selection)) return project
  }
  return null
}

export function historySources(messages: TranscriptMessage[]): Artifact[] {
  const files = new Map<string, Artifact>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = attachmentText(message.text ?? message.content)
    for (const match of text.matchAll(/@file:(?:`([^`]+)`|"([^"]+)"|([^\s]+))/g)) {
      const path = match[1] || match[2] || match[3]
      if (!isSupportedFile(path)) continue
      const name = path.split(/[\\/]/).pop() || '原稿'
      files.set(name, { id: path, name, path, kind: 'source' })
    }
  }
  return [...files.values()]
}

export interface ToolReceipt { id: string; content: unknown }
export interface SessionMaterials { project: ProjectSummary | null; sources: Artifact[]; receipts?: ToolReceipt[] }

export function spilloverPath(content: unknown): string | null {
  if (typeof content !== 'string' || !content.startsWith('<persisted-output>')) return null
  const path = content.match(/^Full output saved to: (.+)$/m)?.[1]
  return path && /^\/.+\/cache\/spillover\/call_[\w-]+\.txt$/.test(path) && !path.includes('/../') ? path : null
}
