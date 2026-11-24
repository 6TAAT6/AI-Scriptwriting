import { atom } from 'nanostores'
import { studioRequest } from '../accounts/api'
import { sidebarSessionProjectId } from './sidebar'

export interface RequirementItem {
  id: string; text: string; category: string; lifetime: 'standing' | 'turn'; lasting: boolean; status: string; pinned: boolean; detail?: string | null
  origin: 'user_message' | 'user_edit' | 'migration' | string; quote: string; constraint: Record<string, unknown> | null
  created_at: number; updated_at: number
}
export interface BibleEntry {
  id: string; category: string; category_label: string; name: string; aliases: string[]; content: string
  status: 'active' | 'retired' | string; core: boolean; version: number; source: string; updated_at: number
}
export interface BibleVersion { version: number; action: string; actor: string; snapshot: BibleEntry; reason: string; at: number }
export interface CreativeMemory {
  scope: string; pending_extraction: boolean; requirements: RequirementItem[]; bible: BibleEntry[]
  categories: { core: Record<string, string>; notes: Record<string, string> }; requirement_categories: string[]
}
export interface CreativeMemoryState { sessionId: string; loading: boolean; error: string; data: CreativeMemory | null }

export const REQUIREMENT_LABELS: Record<string, string> = {
  format: '格式', length: '篇幅', episodes: '集数', language: '语言', world: '世界观', character: '人物', plot: '剧情',
  forbid: '禁止项', style: '文风', delivery: '交付', other: '其他'
}
export const SOURCE_LABELS: Record<string, string> = { user: '用户编辑', approval: '用户确认', model: '智能体记录', migration: '旧会话整理', suggestion: '系统整理' }

export const $creativeMemory = atom<CreativeMemoryState>({ sessionId: '', loading: false, error: '', data: null })
let request = 0

/** 侧栏项目即创作范围；“最近”里的聊天显式标为独立范围，旧版未标记的聊天沿用默认项目。 */
function scopeFields(sessionId: string) {
  const projectId = sidebarSessionProjectId(sessionId)
  return projectId ? { project_id: projectId } : { standalone: true }
}

export async function loadCreativeMemory(sessionId: string, { quiet = false } = {}) {
  const current = ++request
  if (!sessionId) { $creativeMemory.set({ sessionId: '', loading: false, error: '', data: null }); return }
  const previous = $creativeMemory.get()
  $creativeMemory.set({ sessionId, loading: !quiet || previous.sessionId !== sessionId, error: '', data: previous.sessionId === sessionId ? previous.data : null })
  try {
    const data = await studioRequest<CreativeMemory>('/creative-memory', 'POST', { session_id: sessionId, ...scopeFields(sessionId) })
    if (current === request) $creativeMemory.set({ sessionId, loading: false, error: '', data })
  } catch (error) {
    if (current === request) $creativeMemory.set({ ...$creativeMemory.get(), loading: false, error: error instanceof Error ? error.message : '创作资料读取失败。' })
  }
}

export async function editCreativeMemory<T = unknown>(sessionId: string, target: 'requirement' | 'bible', action: string, data: Record<string, unknown>): Promise<T> {
  const result = await studioRequest<T>('/creative-memory/edit', 'POST', { session_id: sessionId, target, action, data, ...scopeFields(sessionId) })
  if (action !== 'history') await loadCreativeMemory(sessionId, { quiet: true })
  return result
}
