import { atom } from 'nanostores'
import { historyEntries, type Entry, type TranscriptMessage } from '../lib/transcript'
import { studioRequest, type StudioUser } from '../accounts/api'
import { publicError } from '../../shared/public-errors.mjs'

export interface EmployeeConversationSession { id: string; title?: string; preview?: string; started_at?: number; message_count?: number; archived?: boolean }
export interface EmployeeConversationGroup {
  id: string
  employeeId: string
  createdBy: string
  createdAt: string
  employee: Pick<StudioUser, 'id' | 'username' | 'display_name' | 'role' | 'profile'>
  sessions: EmployeeConversationSession[]
  sync_error?: string
}
export interface EmployeeViewerState {
  group: EmployeeConversationGroup | null
  session: EmployeeConversationSession | null
  entries: Entry[]
  loading: boolean
  error: string
}

export const $employeeGroups = atom<EmployeeConversationGroup[]>([])
export const $employeeViewer = atom<EmployeeViewerState>({ group: null, session: null, entries: [], loading: false, error: '' })
let requestRevision = 0
let viewerRevision = 0

export async function loadEmployeeConversations() {
  const revision = ++requestRevision
  const data = await studioRequest<{ groups: EmployeeConversationGroup[] }>('/employee-conversations')
  if (revision === requestRevision) $employeeGroups.set(data.groups || [])
  return data.groups || []
}

export async function addEmployeeConversationAccess(employeeId: string) {
  await studioRequest('/employee-conversations', 'POST', { employee_id: employeeId })
  return loadEmployeeConversations()
}

export async function removeEmployeeConversationAccess(assignmentId: string) {
  requestRevision++
  await studioRequest(`/employee-conversations/assignments/${encodeURIComponent(assignmentId)}`, 'DELETE', {})
  $employeeGroups.set($employeeGroups.get().filter(group => group.id !== assignmentId))
  if ($employeeViewer.get().group?.id === assignmentId) closeEmployeeConversation()
}

export async function openEmployeeConversation(group: EmployeeConversationGroup, session: EmployeeConversationSession) {
  const revision = ++viewerRevision
  $employeeViewer.set({ group, session, entries: [], loading: true, error: '' })
  try {
    const data = await studioRequest<{ messages: TranscriptMessage[] }>(`/employee-conversations/${encodeURIComponent(group.employeeId)}/sessions/${encodeURIComponent(session.id)}/messages`)
    if (revision === viewerRevision) $employeeViewer.set({ group, session, entries: historyEntries(data.messages || []), loading: false, error: '' })
  } catch (reason) {
    if (revision === viewerRevision) $employeeViewer.set({ group, session, entries: [], loading: false, error: publicError(reason instanceof Error ? reason.message : '', '员工对话暂时无法读取。') })
  }
}

export async function refreshEmployeeConversation() {
  const viewer = $employeeViewer.get()
  if (!viewer.group || !viewer.session || viewer.loading) return false
  const revision = viewerRevision
  try {
    const data = await studioRequest<{ messages: TranscriptMessage[] }>(`/employee-conversations/${encodeURIComponent(viewer.group.employeeId)}/sessions/${encodeURIComponent(viewer.session.id)}/messages`)
    const current = $employeeViewer.get()
    if (revision !== viewerRevision || current.group?.id !== viewer.group.id || current.session?.id !== viewer.session.id) return false
    $employeeViewer.set({ ...current, entries: historyEntries(data.messages || []), error: '' })
    return true
  } catch {
    return false
  }
}

export function closeEmployeeConversation() {
  requestRevision++
  viewerRevision++
  $employeeViewer.set({ group: null, session: null, entries: [], loading: false, error: '' })
}

export function resetEmployeeConversations() {
  requestRevision++
  $employeeGroups.set([])
  closeEmployeeConversation()
}
