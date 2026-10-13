import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { $currentUser, type StudioUser } from '../accounts/api'
import { $selectedSidebarProjectId, $sidebar, loadSidebar, patchSidebarProject, selectSidebarProject, type SidebarData } from './sidebar'

const writer = (id: string): StudioUser => ({ id, username: id, display_name: id, role: 'employee', enabled: true, profile: `profile-${id}`, created_at: '' })
const accountData = (id: string): SidebarData => {
  const project = { title: '默认项目', hidden: false, pinned: false }
  return { project, projects: [{ id: 'default', ...project }, { id: `${id}-project`, title: '创作项目', hidden: false, pinned: false }], sessions: [], canReveal: false }
}
beforeEach(() => { $currentUser.set(null); localStorage.clear() })
afterEach(() => { $currentUser.set(null); vi.unstubAllGlobals() })

test('项目选择按账号恢复，隐藏或不属于当前账号的历史选择回到最近', async () => {
  const data = { a: accountData('a'), b: accountData('b') }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const state = data[$currentUser.get()!.id as keyof typeof data]
    if (options?.method === 'PATCH') Object.assign(state.projects.find(project => url.endsWith(`/${project.id}`))!, JSON.parse(String(options.body)))
    return new Response(JSON.stringify(state), { status: 200 })
  }))
  localStorage.setItem('drama-studio:a:profile-a:project', 'default')
  $currentUser.set(writer('a')); await loadSidebar()
  expect($selectedSidebarProjectId.get()).toBeNull()
  selectSidebarProject('a-project')
  $currentUser.set(writer('b')); await loadSidebar()
  expect($selectedSidebarProjectId.get()).toBeNull()
  selectSidebarProject('b-project')
  $currentUser.set(null); $currentUser.set(writer('a')); await loadSidebar()
  expect($selectedSidebarProjectId.get()).toBe('a-project')
  await patchSidebarProject({ hidden: true }, 'a-project')
  expect($selectedSidebarProjectId.get()).toBeNull()
  expect($sidebar.get().projects.find(project => project.id === 'a-project')?.hidden).toBe(true)
  $currentUser.set(writer('b')); await loadSidebar()
  expect($selectedSidebarProjectId.get()).toBe('b-project')
  data.b.projects = data.b.projects.filter(project => project.id !== 'b-project')
  $currentUser.set(null); $currentUser.set(writer('b')); await loadSidebar()
  expect($selectedSidebarProjectId.get()).toBeNull()
  selectSidebarProject('a-project')
  expect($selectedSidebarProjectId.get()).toBeNull()
  selectSidebarProject(null)
  $currentUser.set(null); $currentUser.set(writer('b')); await loadSidebar()
  expect($selectedSidebarProjectId.get()).toBeNull()
})
