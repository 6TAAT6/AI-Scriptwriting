import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { AccountsSettings } from '../accounts/AccountsSettings'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { $sidebar, type SidebarData } from '../lib/sidebar'
import { $currentUser } from '../accounts/api'

let data: SidebarData
let failRestore = false
let failCreate = false
let releaseCreate: (() => void) | undefined
let creatingRequests = 0
let failDelete = false
let deletedIds: string[] = []
beforeEach(() => {
  localStorage.clear()
  $currentUser.set({ id: 'test-user', username: 'writer', display_name: '编剧', role: 'super_admin', enabled: true, created_at: '', profile: 'test-profile' })
  const project = { id: 'default', title: '我的剧本', pinned: false, hidden: false }
  data = { project, projects: [project], sessions: [], canReveal: false }
  $sidebar.set({ ...data, loaded: true, busy: false, error: '' })
  failRestore = false
  failCreate = false
  releaseCreate = undefined
  creatingRequests = 0
  failDelete = false
  deletedIds = []
  workspace.reset()
  workspace.connection.set('open')
  workspace.navigation.set({ sessions: [{ id: 'first', title: 'Bot Chat' }, { id: 'second', title: '第二部剧' }], loading: false, error: '' })
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') {
      const id = url.split('/').pop()!
      if (failDelete) return new Response(JSON.stringify({ error: '聊天仍在创作中，请停止后重试。' }), { status: 409 })
      if (url.includes('/projects/')) {
        const deletedSessionIds = data.sessions.filter(row => (row.projectId === undefined ? 'default' : row.projectId) === id).map(row => row.id)
        deletedIds.push(...deletedSessionIds)
        data.sessions = data.sessions.filter(row => !deletedSessionIds.includes(row.id))
        data.projects = data.projects.filter(row => row.id !== id)
        return new Response(JSON.stringify({ ...data, deletedSessionIds }), { status: 200 })
      }
      deletedIds.push(id)
      data.sessions = data.sessions.filter(row => row.id !== id)
      return new Response(JSON.stringify(data), { status: 200 })
    }
    if (options?.method === 'POST' && url.endsWith('/projects')) {
      creatingRequests++
      if (failCreate) return new Response(JSON.stringify({ error: '创建未完成，请重试。' }), { status: 503 })
      await new Promise<void>(resolve => { releaseCreate = resolve })
      const project = { id: 'new-project', title: JSON.parse(String(options.body)).title, pinned: false, hidden: false }
      data.projects.push(project)
      return new Response(JSON.stringify({ ...data, createdProjectId: project.id }), { status: 201 })
    }
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body))
      if (body.archived === false && failRestore) return new Response(JSON.stringify({ error: '暂时无法恢复，请重试。' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/project')) Object.assign(data.project, body)
      else if (url.includes('/projects/')) Object.assign(data.projects.find(project => project.id === url.split('/').pop())!, body)
      else {
        const id = url.split('/').pop()!
        let row = data.sessions.find(value => value.id === id)
        if (!row) { row = { id }; data.sessions.push(row) }
        Object.assign(row, body)
      }
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); $currentUser.set(null) })
const display = () => render(<Sidebar active theme="light" onTheme={() => {}} onSettings={() => {}} onCollapse={() => {}} onSelect={() => {}} />)

test('侧栏错误不把服务端内部信息直接显示给用户', () => {
  $currentUser.set(null)
  $sidebar.set({ ...data, loaded: false, busy: false, error: '内部 provider grok-4.7 请求失败，详见 https://private.invalid' })
  display()

  expect(screen.getByRole('alert').textContent).toContain('侧栏暂未加载，请重试。')
  expect(screen.queryByText(/provider|grok-4\.7|private\.invalid/)).toBeNull()
})

test('新的创作跟随当前项目，未选项目和返回最近时保存为独立的最近对话', async () => {
  let sequence = 0
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async method => {
    if (method === 'session.create') { const id = ++sequence; return { session_id: `live-${id}`, stored_session_id: `new-${id}`, messages: [], info: {}, message_count: 0 } }
    if (method === 'session.list') return { sessions: [{ id: 'first', title: '旧项目聊天' }] }
    if (method === 'model.options') return { providers: [] }
    throw new Error('此测试不发送生成请求')
  }) as WorkspaceApi['rpc'])
  display()
  const recent = screen.getByRole('region', { name: '最近' })
  const create = screen.getByRole('button', { name: /新的创作/ })
  fireEvent.click(create)
  workspace.editComposer({ text: '最近的新对话' })
  await act(async () => { await workspace.ensureSession() })
  expect(data.sessions.find(row => row.id === 'new-1')?.projectId).toBeNull()
  expect(within(recent).getByTitle('最近的新对话')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '选择项目我的剧本' }))
  fireEvent.click(create)
  workspace.editComposer({ text: '项目中的对话' })
  await act(async () => { await workspace.ensureSession() })
  expect(data.sessions.find(row => row.id === 'new-2')?.projectId).toBe('default')
  expect(within(screen.getByRole('region', { name: '我的剧本' })).getByTitle('项目中的对话')).toBeTruthy()
  expect(within(recent).queryByTitle('项目中的对话')).toBeNull()
  fireEvent.click(within(recent).getByRole('button', { name: '最近' }))
  fireEvent.click(create)
  await act(async () => { await workspace.ensureSession() })
  expect(data.sessions.find(row => row.id === 'new-3')?.projectId).toBeNull()
})

test('加号要求项目名称，失败保留输入，创建只提交一次并显示可选择的新项目', async () => {
  display()
  const trigger = screen.getByRole('button', { name: '创建项目' })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '创建项目' })
  const name = within(dialog).getByRole('textbox', { name: '项目名称' })
  expect(document.activeElement).toBe(name)
  expect(within(dialog).queryByRole('button', { name: '添加' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: '创建项目' })).toHaveProperty('disabled', true)
  fireEvent.change(name, { target: { value: '  雾港来信  ' } })
  failCreate = true
  fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '创建未完成，请重试。')
  expect(name).toHaveProperty('value', '  雾港来信  ')
  failCreate = false
  fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }))
  await waitFor(() => expect(releaseCreate).toBeTypeOf('function'))
  fireEvent.submit(dialog.querySelector('form')!)
  expect(creatingRequests).toBe(2)
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
  releaseCreate!()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '创建项目' })).toBeNull())
  expect(screen.getByRole('button', { name: '选择项目雾港来信' }).getAttribute('aria-current')).toBe('true')
  expect(screen.getByRole('button', { name: '剧本创作工作区' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '第二部剧' })).toBeTruthy()
  expect(document.activeElement).toBe(trigger)
})

test('创建成功但响应丢失后重试复用请求标识，明确重新创建允许使用相同名称', async () => {
  const requests: Array<{ title: string; requestId?: string }> = []
  const created = new Map<string, string>()
  let dropResponse = true
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method !== 'POST') return new Response(JSON.stringify(data), { status: 200 })
    const body = JSON.parse(String(options.body))
    requests.push(body)
    let id = body.requestId && created.get(body.requestId)
    if (!id) {
      id = `project-${created.size + 1}`
      created.set(body.requestId || id, id)
      data.projects.push({ id, title: body.title, pinned: false, hidden: false })
    }
    if (dropResponse) { dropResponse = false; throw new Error('响应丢失') }
    return new Response(JSON.stringify({ ...data, createdProjectId: id }), { status: 201 })
  }))
  display()
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  const dialog = screen.getByRole('dialog', { name: '创建项目' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '项目名称' }), { target: { value: '雾港来信' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }))
  expect(await within(dialog).findByRole('alert')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getAllByRole('button', { name: '选择项目雾港来信' })).toHaveLength(1)
  expect(requests[0].requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
  expect(requests[1].requestId).toBe(requests[0].requestId)
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  const nextDialog = screen.getByRole('dialog', { name: '创建项目' })
  fireEvent.change(within(nextDialog).getByRole('textbox', { name: '项目名称' }), { target: { value: '雾港来信' } })
  fireEvent.click(within(nextDialog).getByRole('button', { name: '创建项目' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(requests[2].requestId).not.toBe(requests[0].requestId)
  expect(screen.getAllByRole('button', { name: '选择项目雾港来信' })).toHaveLength(2)
})

test('取消和 Escape 不创建项目，每个项目可新建对话并分别保留草稿', async () => {
  data.projects.push({ id: 'another', title: '第二个项目', pinned: false, hidden: false })
  data.sessions.push({ id: 'second', projectId: 'another' })
  display()
  const trigger = screen.getByRole('button', { name: '创建项目' })
  trigger.focus(); fireEvent.click(trigger)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(creatingRequests).toBe(0)
  const firstProject = screen.getByRole('button', { name: '选择项目我的剧本' })
  const secondProject = screen.getByRole('button', { name: '选择项目第二个项目' })
  fireEvent.click(firstProject)
  workspace.editComposer({ text: '第一个项目的草稿' })
  fireEvent.click(screen.getByRole('button', { name: '在第二个项目中新建对话' }))
  expect(secondProject.getAttribute('aria-current')).toBe('true')
  expect(workspace.composer.get().text).toBe('')
  workspace.editComposer({ text: '第二个项目的草稿' })
  fireEvent.click(screen.getByRole('button', { name: '收起第二个项目' }))
  expect(screen.queryByRole('button', { name: '第二部剧' })).toBeNull()
  expect(screen.getByRole('button', { name: '剧本创作工作区' })).toBeTruthy()
  fireEvent.click(firstProject)
  expect(firstProject.getAttribute('aria-current')).toBe('true')
  expect(workspace.composer.get().text).toBe('第一个项目的草稿')
  expect(screen.getByRole('button', { name: '展开第二个项目' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '在第二个项目中新建对话' }))
  expect(workspace.composer.get().text).toBe('第二个项目的草稿')
  expect(screen.getByRole('button', { name: '收起第二个项目' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /新的创作/ }))
  expect(secondProject.getAttribute('aria-current')).toBe('true')
  expect(workspace.composer.get().text).toBe('第二个项目的草稿')
  fireEvent.click(screen.getByRole('button', { name: '剧本创作工作区' }))
  await waitFor(() => expect(workspace.navigation.get().loading).toBe(false))
  fireEvent.click(firstProject)
  expect(workspace.composer.get().text).toBe('第一个项目的草稿')
})

test('右键菜单归档后，仅从系统设置查看和恢复，侧栏即时更新', async () => {
  display()
  await waitFor(() => expect($sidebar.get().loaded).toBe(true))
  const sidebar = screen.getByRole('complementary', { name: '项目与对话' })
  expect(within(sidebar).queryByRole('button', { name: '已归档' })).toBeNull()
  expect(within(sidebar).queryByRole('button', { name: '人员管理' })).toBeNull()
  expect(within(sidebar).queryByText('创作服务已连接')).toBeNull()
  expect(within(sidebar).getByRole('button', { name: '切换深色主题' })).toBeTruthy()
  const button = screen.getByRole('button', { name: '第二部剧的更多操作' })
  fireEvent.contextMenu(screen.getByRole('button', { name: '第二部剧' }).parentElement!, { clientX: 100, clientY: 100 })
  fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => expect(data.sessions[0]?.pinned).toBe(true))
  expect(Array.from(document.querySelectorAll('.session-row')).map(row => row.getAttribute('title'))).toEqual(['第二部剧', '剧本创作工作区'])
  fireEvent.click(button)
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(button)
  fireEvent.click(button); fireEvent.click(screen.getByRole('menuitem', { name: '归档聊天' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '第二部剧' })).toBeNull())
  expect(screen.queryByText('聊天已归档，可在系统设置的已归档聊天中恢复')).toBeNull()
  render(<AccountsSettings initialSection="account" onClose={() => {}} />)
  const settings = screen.getByRole('dialog', { name: '系统设置' })
  fireEvent.click(within(settings).getByRole('button', { name: '已归档' }))
  expect(await within(settings).findByText('第二部剧')).toBeTruthy()
  failRestore = true
  fireEvent.click(within(settings).getByRole('button', { name: '恢复第二部剧' }))
  expect(await within(settings).findByRole('alert')).toHaveProperty('textContent', '暂时无法恢复，请重试。')
  expect(within(settings).getByText('第二部剧')).toBeTruthy()
  expect(within(sidebar).queryByRole('button', { name: '第二部剧' })).toBeNull()
  failRestore = false
  fireEvent.click(within(settings).getByRole('button', { name: '恢复第二部剧' }))
  await waitFor(() => expect(data.sessions[0].archived).toBe(false))
  expect(await within(settings).findByText('还没有已归档的聊天')).toBeTruthy()
  expect(within(sidebar).getByRole('button', { name: '第二部剧' })).toBeTruthy()
})

test('置顶项目和对话位于各自分组顶部，新建项目和对话位于未置顶项目顶部', () => {
  const defaultProject = data.projects[0]
  data.projects = [
    { id: 'new-project', title: '新项目', pinned: false, hidden: false },
    defaultProject,
    { id: 'old-project', title: '旧项目', pinned: false, hidden: false },
    { id: 'pinned-project', title: '置顶项目', pinned: true, hidden: false },
  ]
  data.sessions = [
    { id: 'old-chat', title: '旧对话', projectId: 'old-project', pinned: false },
    { id: 'new-chat', title: '新对话', projectId: 'old-project', pinned: false },
    { id: 'pinned-chat', title: '置顶对话', projectId: 'old-project', pinned: true },
    { id: 'old-recent', title: '旧最近', projectId: null, pinned: false },
    { id: 'new-recent', title: '新最近', projectId: null, pinned: false },
  ]
  $sidebar.set({ ...data, loaded: true, busy: false, error: '' })
  workspace.navigation.set({
    sessions: [
      { id: 'old-chat', title: '旧对话', started_at: 100 },
      { id: 'new-chat', title: '新对话', started_at: 200 },
      { id: 'pinned-chat', title: '置顶对话', started_at: 50 },
      { id: 'old-recent', title: '旧最近', started_at: 100 },
      { id: 'new-recent', title: '新最近', started_at: 200 },
    ], loading: false, error: ''
  })
  display()

  expect(Array.from(document.querySelectorAll('.sidebar-project > .sidebar-project-row .project-group > span:first-of-type')).map(node => node.textContent))
    .toEqual(['置顶项目', '新项目', '我的剧本', '旧项目'])
  const project = screen.getByRole('region', { name: '旧项目' })
  expect(Array.from(project.querySelectorAll('.session-row')).map(node => node.getAttribute('title')))
    .toEqual(['置顶对话', '新对话', '旧对话'])
  const recent = screen.getByRole('region', { name: '最近' })
  expect(Array.from(recent.querySelectorAll('.session-row')).map(node => node.getAttribute('title')))
    .toEqual(['新最近', '旧最近'])
})

test('聊天删除先确认，取消不发请求，运行中禁用，成功后移除导航与当前聊天', async () => {
  workspace.session.set({ storedId: 'second', runtimeId: 'runtime-second', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime-second', entries: [], running: true, error: '' })
  display()
  fireEvent.click(screen.getByRole('button', { name: '第二部剧的更多操作' }))
  expect(screen.getByRole('menuitem', { name: '删除聊天' })).toHaveProperty('disabled', true)
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  workspace.conversation.set({ ...workspace.conversation.get(), running: false })
  fireEvent.click(screen.getByRole('button', { name: '第二部剧的更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '删除聊天' }))
  let dialog = screen.getByRole('dialog', { name: '删除聊天' })
  expect(within(dialog).getByText(/不可恢复/)).toBeTruthy()
  expect(deletedIds).toEqual([])
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(deletedIds).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '第二部剧的更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '删除聊天' }))
  dialog = screen.getByRole('dialog', { name: '删除聊天' })
  fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(deletedIds).toEqual(['second'])
  expect(screen.queryByRole('button', { name: '第二部剧' })).toBeNull()
  expect(workspace.session.get().storedId).toBe('')
  expect(screen.getByRole('button', { name: '剧本创作工作区' })).toBeTruthy()
})

test('已归档聊天提供删除，失败保留记录与错误，确认重试成功后只移除该聊天', async () => {
  data.sessions.push({ id: 'second', archived: true })
  display()
  render(<AccountsSettings initialSection="archived" onClose={() => {}} />)
  const settings = screen.getByRole('dialog', { name: '系统设置' })
  fireEvent.click(await within(settings).findByRole('button', { name: '删除第二部剧' }))
  let dialog = screen.getByRole('dialog', { name: '删除聊天' })
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog', { name: '删除聊天' })).toBeNull()
  expect(deletedIds).toEqual([])
  fireEvent.click(within(settings).getByRole('button', { name: '删除第二部剧' }))
  dialog = screen.getByRole('dialog', { name: '删除聊天' })
  failDelete = true
  fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '聊天仍在创作中，请停止后重试。')
  expect(within(settings).getByText('第二部剧')).toBeTruthy()
  expect(deletedIds).toEqual([])
  failDelete = false
  fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除聊天' })).toBeNull())
  expect(deletedIds).toEqual(['second'])
  expect(within(settings).getByText('还没有已归档的聊天')).toBeTruthy()
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['first'])
})

test('归档项目删除必须确认，取消和失败保留项目，成功清理其中聊天和当前会话', async () => {
  data.projects[0].hidden = true
  data.sessions = [{ id: 'first', projectId: null }, { id: 'second', projectId: 'default', archived: true }]
  workspace.session.set({ storedId: 'second', runtimeId: 'live', info: {} })
  display()
  render(<AccountsSettings initialSection="archived" onClose={() => {}} />)
  const settings = screen.getByRole('dialog', { name: '系统设置' })
  fireEvent.click(await within(settings).findByRole('button', { name: '彻底删除项目我的剧本' }))
  let dialog = screen.getByRole('dialog', { name: '彻底删除项目' })
  expect(within(dialog).getByText(/全部聊天记录/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(deletedIds).toEqual([])
  fireEvent.click(within(settings).getByRole('button', { name: '彻底删除项目我的剧本' }))
  dialog = screen.getByRole('dialog', { name: '彻底删除项目' })
  failDelete = true
  fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }))
  expect(await within(dialog).findByRole('alert')).toBeTruthy()
  expect(data.projects).toHaveLength(1)
  failDelete = false
  fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '彻底删除项目' })).toBeNull())
  expect(data.projects).toEqual([])
  expect(deletedIds).toEqual(['second'])
  expect(workspace.session.get().storedId).toBe('')
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['first'])
  expect(within(settings).queryByRole('button', { name: '恢复项目我的剧本' })).toBeNull()
})

test('移除项目后侧栏不留占位卡片，恢复入口只在设置的归档中显示', async () => {
  display()
  fireEvent.click(screen.getByRole('button', { name: '我的剧本的更多操作' }))
  expect(screen.queryByRole('menuitem', { name: '在 Finder 中显示' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: '查看已归档聊天' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }))
  fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '短剧创作' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '短剧创作的更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '移除项目' }))
  expect(screen.getByText(/聊天和稿件会保留/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '移除项目' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('button', { name: '恢复项目' })).toBeNull()
  expect(screen.queryByText(/已从侧栏移除/)).toBeNull()
  expect(screen.queryByText('项目已移除，可随时恢复')).toBeNull()
  expect(screen.queryByRole('button', { name: '选择项目短剧创作' })).toBeNull()
  render(<AccountsSettings initialSection="archived" onClose={() => {}} />)
  const settings = screen.getByRole('dialog', { name: '系统设置' })
  fireEvent.click(await within(settings).findByRole('button', { name: '恢复项目短剧创作' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '短剧创作的更多操作' })).toBeTruthy())
  expect(screen.getByRole('button', { name: '剧本创作工作区' })).toBeTruthy()
})
