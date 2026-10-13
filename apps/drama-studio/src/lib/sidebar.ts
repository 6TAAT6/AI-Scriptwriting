import { atom } from 'nanostores'
import { $currentUser, studioRequest } from '../accounts/api'
import { publicError } from '../../shared/public-errors.mjs'

export interface SidebarProject { id: string; title: string; pinned: boolean; hidden: boolean }
export interface SidebarSession { id: string; projectId?: string | null; title?: string; pinned?: boolean; archived?: boolean }
export interface SidebarData { project: Omit<SidebarProject, 'id'>; projects: SidebarProject[]; sessions: SidebarSession[]; canReveal: boolean }
interface SidebarState extends SidebarData { loaded: boolean; error: string; busy: boolean }
const empty = (): SidebarState => {
  const project = { title: '我的剧本', pinned: false, hidden: false }
  return { project, projects: [{ id: 'default', ...project }], sessions: [], canReveal: false, loaded: false, error: '', busy: false }
}
export const $sidebar = atom<SidebarState>(empty())
export const $selectedSidebarProjectId = atom<string | null>(null)
let accountKey = ''
let revision = 0
let requestRevision = 0
$currentUser.subscribe(user => {
  // 旧版自动写入默认项目；新选择记录只保存明确选择过的项目或“最近”。
  const next = user ? `drama-studio:${user.id}:${user.profile}:project-context` : ''
  if (accountKey === next) return
  accountKey = next; revision++; $sidebar.set(empty()); $selectedSidebarProjectId.set(null)
})

export function selectSidebarProject(id: string | null) {
  const state = $sidebar.get()
  const selected = id !== null && state.loaded && !state.projects.some(project => project.id === id && !project.hidden) ? null : id
  $selectedSidebarProjectId.set(selected)
  if (accountKey && state.loaded) localStorage.setItem(accountKey, selected ?? '')
}
export function sidebarSessionProjectId(id: string, data = $sidebar.get()) {
  // 缺省标记属于旧版默认项目；显式 null 表示新建的“最近”对话。
  const projectId = data.sessions.find(row => row.id === id)?.projectId
  return projectId === undefined ? 'default' : projectId
}

function applyData(data: SidebarData) {
  const selected = !$sidebar.get().loaded && accountKey ? localStorage.getItem(accountKey) || null : $selectedSidebarProjectId.get()
  $sidebar.set({ ...data, projects: data.projects ?? [{ id: 'default', ...data.project }], loaded: true, error: '', busy: false })
  selectSidebarProject(selected)
}

export function sidebarSessionTitle(id: string, title?: string, data = $sidebar.get()) {
  return data.sessions.find(row => row.id === id)?.title || (!title || title === 'Bot Chat' ? '剧本创作工作区' : title)
}
export async function loadSidebar() {
  if ($sidebar.get().busy) return
  const current = revision, request = ++requestRevision
  try {
    const data = await studioRequest<SidebarData>('/sidebar')
    if (current === revision && request === requestRevision) applyData(data)
  } catch (reason) {
    if (current === revision && request === requestRevision) $sidebar.set({ ...$sidebar.get(), error: publicError(reason instanceof Error ? reason.message : '', '侧栏暂未加载，请重试。') })
  }
}
async function mutate<T extends SidebarData = SidebarData>(route: string, method: string, patch: unknown): Promise<T | null> {
  if ($sidebar.get().busy) return null
  const current = revision
  requestRevision++
  $sidebar.set({ ...$sidebar.get(), busy: true, error: '' })
  try {
    const data = await studioRequest<T>(route, method, patch)
    if (current !== revision) return null
    applyData(data); return data
  } catch (reason) {
    if (current === revision) $sidebar.set({ ...$sidebar.get(), busy: false, error: publicError(reason instanceof Error ? reason.message : '', '操作未完成，请重试。') })
    return null
  }
}
export const patchSidebarProject = async (patch: Partial<Omit<SidebarProject, 'id'>>, id = 'default') => Boolean(await mutate(`/sidebar/projects/${encodeURIComponent(id)}`, 'PATCH', patch))
export const patchSidebarSession = async (id: string, patch: Omit<Partial<SidebarSession>, 'id'>) => Boolean(await mutate(`/sidebar/sessions/${encodeURIComponent(id)}`, 'PATCH', patch))
export const deleteSidebarSession = async (id: string) => Boolean(await mutate(`/sidebar/sessions/${encodeURIComponent(id)}`, 'DELETE', {}))
export async function deleteSidebarProject(id: string): Promise<string[] | null> {
  const result = await mutate<SidebarData & { deletedSessionIds: string[] }>(`/sidebar/projects/${encodeURIComponent(id)}`, 'DELETE', {})
  return result?.deletedSessionIds ?? null
}
export async function createSidebarProject(title: string, requestId: string): Promise<string | null> {
  if (!title.trim()) return null
  const data = await mutate<SidebarData & { createdProjectId: string }>('/sidebar/projects', 'POST', { title: title.trim(), requestId })
  return data?.createdProjectId || null
}
export async function revealSidebarWorkspace() {
  const current = revision
  try { await studioRequest('/sidebar/project/reveal', 'POST', {}); return current === revision }
  catch (reason) {
    if (current === revision) $sidebar.set({ ...$sidebar.get(), error: publicError(reason instanceof Error ? reason.message : '', '未能打开 Finder。') })
    return false
  }
}
