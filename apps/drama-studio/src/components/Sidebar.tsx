import { useStore } from '@nanostores/react'
import { Archive, ChevronDown, FolderOpen, LoaderCircle, MessageSquare, Moon, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Search, Settings2, SquarePen, Sun, Trash2, UserRound, X } from 'lucide-react'
import { useCallback, useRef, useState, useEffect, type MouseEvent } from 'react'
import type { SessionListRow } from '../../../shared/src/gateway-contract.generated'
import { workspace } from '../store/workspace'
import { $currentUser, roleLabels } from '../accounts/api'
import { groupByRegion } from '../accounts/regions'
import { $selectedSidebarProjectId, $sidebar, createSidebarProject, deleteSidebarSession, loadSidebar, patchSidebarProject, patchSidebarSession, revealSidebarWorkspace, sidebarSessionProjectId, sidebarSessionTitle } from '../lib/sidebar'
import { Brand } from './Brand'
import { CreateProjectDialog } from './CreateProjectDialog'
import { DeleteChatDialog, SidebarDialog, SidebarMenu, type MenuAction, type MenuAnchor } from './SidebarMenu'
import './Sidebar.css'
import { $employeeGroups, openEmployeeConversation, removeEmployeeConversationAccess } from '../employee-access/api'
import { publicText } from '../lib/transcript'

interface SidebarProps {
  active: boolean
  theme: string
  onTheme: () => void
  onSettings: (section?: 'employee-access') => void
  onCollapse: () => void
  onSelect: () => void
}
interface MenuTarget { kind: 'project' | 'session'; id: string; title: string; anchor: MenuAnchor }
interface DialogTarget { kind: 'project-name' | 'session-name' | 'project-hide'; id: string; title: string }

export function Sidebar({ active, theme, onTheme, onSettings, onCollapse, onSelect }: SidebarProps) {
  const navigation = useStore(workspace.navigation)
  const startup = useStore(workspace.startup)
  const session = useStore(workspace.session)
  const draft = useStore(workspace.composer)
  const conversation = useStore(workspace.conversation)
  const runningSessions = useStore(workspace.activity.running)
  const unreadSessions = useStore(workspace.activity.unread)
  const user = useStore($currentUser)
  const sidebar = useStore($sidebar)
  const selectedProject = useStore($selectedSidebarProjectId)
  const employeeGroups = useStore($employeeGroups)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 员工对话的地区与人员分组默认收起，点开后再展开查看。
  const [openEmployees, setOpenEmployees] = useState<Set<string>>(new Set())
  const toggleEmployees = (key: string) => setOpenEmployees(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [dialog, setDialog] = useState<DialogTarget | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [notice, setNotice] = useState('')
  const [removingEmployee, setRemovingEmployee] = useState<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useEffect(() => {
    if (user) void loadSidebar()
    setMenu(null); setDialog(null); setDeleting(null); setCreatingProject(false); setSearch(''); setCollapsed(new Set()); setNotice('')
  }, [user?.id])
  useEffect(() => {
    if (!active) return
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); searchInput.current?.focus()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [active])
  const metadata = new Map(sidebar.sessions.map(row => [row.id, row]))
  const visible = navigation.sessions.filter(row => !metadata.get(row.id)?.archived)
  const sessions = visible.filter(row => `${sidebarSessionTitle(row.id, row.title, sidebar)} ${row.preview ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => {
      const pinOrder = Number(Boolean(metadata.get(b.id)?.pinned)) - Number(Boolean(metadata.get(a.id)?.pinned))
      if (pinOrder) return pinOrder
      // 每个项目/最近分组都按最新创建的对话在前；置顶只决定分组内的第一层顺序。
      return (b.started_at ?? 0) - (a.started_at ?? 0)
    })
  const projects = sidebar.projects.filter(project => !project.hidden).sort((a, b) => Number(b.pinned) - Number(a.pinned))
  const recent = sessions.filter(row => sidebarSessionProjectId(row.id, sidebar) === null)
  const unavailable = draft.busy || sidebar.busy || !sidebar.loaded
  const sidebarError = sidebar.error ? publicText(sidebar.error, '侧栏暂未加载，请重试。') : ''
  const showMenu = (event: MouseEvent<HTMLElement>, kind: MenuTarget['kind'], id: string, title: string) => {
    event.preventDefault(); event.stopPropagation()
    if (unavailable) return
    const rect = event.currentTarget.getBoundingClientRect()
    const context = event.type === 'contextmenu'
    setMenu({ kind, id, title, anchor: { x: context ? event.clientX : rect.right - 180, y: context ? event.clientY : rect.bottom + 4, trigger: context ? event.currentTarget.querySelector<HTMLButtonElement>('button') || event.currentTarget : event.currentTarget } })
  }
  const updateProject = async (id: string, patch: Parameters<typeof patchSidebarProject>[0], message: string) => {
    const ok = await patchSidebarProject(patch, id)
    if (ok) setNotice(message)
    return ok
  }
  const updateSession = async (id: string, patch: Parameters<typeof patchSidebarSession>[1], message: string) => {
    const ok = await patchSidebarSession(id, patch)
    if (ok) { setNotice(message); if (patch.archived && session.storedId === id) workspace.newConversation() }
    return ok
  }
  const selectProject = (id: string | null) => {
    if (draft.busy) return
    workspace.newConversation(id)
  }
  const newProjectConversation = (id: string) => {
    selectProject(id)
    setCollapsed(current => { const next = new Set(current); next.delete(id); return next })
    setSearch('')
    onSelect()
  }
  const createProject = async (name: string, requestId: string) => {
    const id = await createSidebarProject(name, requestId)
    if (!id) return false
    selectProject(id)
    setSearch('')
    setNotice('项目已创建')
    return true
  }
  const removeEmployeeGroup = async (group: { id: string; employee: { display_name: string } }) => {
    if (removingEmployee || sidebar.busy) return
    setRemovingEmployee(group.id)
    try { await removeEmployeeConversationAccess(group.id); setNotice(`已停止查看${group.employee.display_name}的对话。`) }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : '移除查看授权失败，请重试。') }
    finally { setRemovingEmployee(null) }
  }
  let actions: MenuAction[] = []
  const menuProject = menu?.kind === 'project' ? projects.find(project => project.id === menu.id) : undefined
  if (menuProject && menu) {
    actions = [
      { label: '新建对话', icon: <SquarePen size={16} />, run: () => newProjectConversation(menuProject.id) },
      { label: menuProject.pinned ? '取消置顶' : '置顶', icon: menuProject.pinned ? <PinOff size={16} /> : <Pin size={16} />, run: () => { void updateProject(menuProject.id, { pinned: !menuProject.pinned }, menuProject.pinned ? '项目已取消置顶' : '项目已置顶') } },
      { label: '编辑', icon: <Pencil size={16} />, run: () => setDialog({ kind: 'project-name', id: menuProject.id, title: menu.title }) },
      ...(menuProject.id === 'default' && sidebar.canReveal ? [{ label: '在 Finder 中显示', icon: <FolderOpen size={16} />, divider: true, run: () => { void revealSidebarWorkspace().then(ok => { if (ok) setNotice('已在 Finder 中打开工作区') }) } }] : []),
      { label: '移除项目', icon: <X size={16} />, divider: true, danger: true, run: () => setDialog({ kind: 'project-hide', id: menuProject.id, title: menu.title }) }
    ]
  } else if (menu?.kind === 'session') {
    const row = metadata.get(menu.id), id = menu.id
    actions = [
      { label: row?.pinned ? '取消置顶' : '置顶', icon: row?.pinned ? <PinOff size={16} /> : <Pin size={16} />, run: () => { void updateSession(id, { pinned: !row?.pinned }, row?.pinned ? '聊天已取消置顶' : '聊天已置顶') } },
      { label: '编辑名称', icon: <Pencil size={16} />, run: () => setDialog({ kind: 'session-name', id, title: menu.title }) },
      { label: '归档聊天', icon: <Archive size={16} />, divider: true,
        disabled: session.storedId === id && conversation.running, run: () => { void updateSession(id, { archived: true }, '') } },
      { label: '删除聊天', icon: <Trash2 size={16} />, danger: true, disabled: session.storedId === id && conversation.running,
        run: () => { $sidebar.set({ ...$sidebar.get(), error: '' }); setDeleting({ id, title: menu.title }) } }
    ]
  }
  const isRunning = (row: SessionListRow) => runningSessions.has(row.id) || Boolean(row.resolved_id && runningSessions.has(row.resolved_id))
    || session.storedId === row.id && (conversation.running || Boolean(conversation.asyncPending))
  const isUnread = (row: SessionListRow) => unreadSessions.has(row.id) || Boolean(row.resolved_id && unreadSessions.has(row.resolved_id))
  const renderSession = (row: SessionListRow) => {
    const title = sidebarSessionTitle(row.id, row.title, sidebar)
    return <div key={row.id} className={`sidebar-session-item ${session.storedId === row.id ? 'active' : ''}`} onContextMenu={event => showMenu(event, 'session', row.id, title)}>
      <button className={`session-row ${session.storedId === row.id ? 'active' : ''}`} disabled={draft.busy} title={title} onClick={() => { void workspace.open(row.id); onSelect() }}><>{isRunning(row) ? <LoaderCircle className="sidebar-running" size={14} aria-label={`${title}正在创作`} /> : isUnread(row) ? <span className="sidebar-unread" aria-label={`${title}有新回复`} /> : <MessageSquare size={14} />}</><span>{title}</span>{metadata.get(row.id)?.pinned && <Pin className="session-pin" size={11} />}<time>{row.started_at ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(row.started_at * 1000)) : ''}</time></button>
      <button className="icon-button sidebar-more" aria-label={`${title}的更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === 'session' && menu.id === row.id} disabled={unavailable} onClick={event => showMenu(event, 'session', row.id, title)}><MoreHorizontal size={15} /></button>
    </div>
  }
  return <aside className="sidebar" aria-label="项目与对话">
    <div className="sidebar-brand"><Brand showVersion /><button className="icon-button" aria-label="收起侧边栏" onClick={onCollapse}><PanelLeftClose size={17} /></button></div>
    <div className="sidebar-top-actions">
      <button className="new-chat" disabled={draft.busy} onClick={() => { workspace.newConversation(); onSelect() }}><SquarePen size={17} /><span>新的创作</span></button>
      <label className="sidebar-search"><Search size={16} /><input ref={searchInput} aria-label="搜索创作对话" placeholder="搜索对话" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>
    <div className="sidebar-section-heading"><span>项目</span><button className="icon-button" aria-label="创建项目" title="创建项目" disabled={unavailable} onClick={() => { $sidebar.set({ ...$sidebar.get(), error: '' }); setCreatingProject(true) }}><Plus size={15} /></button></div>
    <div className="sidebar-projects">
      {projects.map(project => {
        const projectSessions = sessions.filter(row => sidebarSessionProjectId(row.id, sidebar) === project.id)
        const expanded = !collapsed.has(project.id)
        const running = visible.some(row => sidebarSessionProjectId(row.id, sidebar) === project.id && isRunning(row))
        const unread = visible.some(row => sidebarSessionProjectId(row.id, sidebar) === project.id && isUnread(row))
        return <section key={project.id} className="sidebar-project" aria-label={project.title}>
          <div className={`sidebar-project-row ${selectedProject === project.id ? 'selected' : ''}`} onContextMenu={event => showMenu(event, 'project', project.id, project.title)}>
            <button className="project-group" aria-label={`选择项目${project.title}`} aria-current={selectedProject === project.id ? 'true' : undefined} aria-expanded={expanded} disabled={draft.busy} onClick={() => { selectProject(project.id); setCollapsed(current => { const next = new Set(current); if (selectedProject === project.id && expanded) next.add(project.id); else next.delete(project.id); return next }) }}><FolderOpen className="sidebar-project-folder" size={17} /><span className="sidebar-project-title">{project.title}</span>{!expanded && (running ? <span className="sidebar-project-status"><LoaderCircle className="sidebar-running" size={15} aria-label={`${project.title}中有创作正在进行`} /></span> : unread ? <span className="sidebar-project-status"><span className="sidebar-unread" aria-label={`${project.title}中有新回复`} /></span> : null)}{project.pinned && <Pin size={12} />}</button>
            <button className="icon-button sidebar-more" aria-label={`${project.title}的更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === 'project' && menu.id === project.id} disabled={unavailable} onClick={event => showMenu(event, 'project', project.id, project.title)}><MoreHorizontal size={16} /></button>
          </div>
          <div className="session-fold" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}><div className="session-fold-content">
            {projectSessions.map(renderSession)}
            {!projectSessions.length && <p className="sidebar-empty">{search ? '没有找到匹配的对话' : startup.history || navigation.loading ? '正在读取创作记录…' : '从一段新对话开始，\n你的剧本会保存在这里。'}</p>}
          </div></div>
        </section>
      })}
      {user && user.role !== 'employee' && <section className="sidebar-employee-groups" aria-label="员工对话">
        <div className="sidebar-section-heading"><span>员工对话</span><button className="icon-button" aria-label="管理员工对话查看" title="管理员工对话查看" onClick={() => onSettings('employee-access')}><Plus size={15} /></button></div>
        {!employeeGroups.length && <p className="sidebar-empty">点击加号，添加要查看的员工。</p>}
        {groupByRegion(employeeGroups, group => group.employee).filter(region => region.members.length).map(region => {
          const regionExpanded = openEmployees.has(`region:${region.id}`)
          return <section key={region.id} className="sidebar-employee-region" aria-label={`${region.label}员工对话`}>
            <button className="employee-region-toggle" aria-label={`${regionExpanded ? '收起' : '展开'}${region.label}分组`} aria-expanded={regionExpanded} onClick={() => toggleEmployees(`region:${region.id}`)}>
              <ChevronDown size={14} style={{ transform: regionExpanded ? undefined : 'rotate(-90deg)' }} /><strong>{region.label}</strong>
            </button>
            <div hidden={!regionExpanded}>
        {region.members.map(group => {
          const expanded = openEmployees.has(`employee:${group.id}`)
          return <section key={group.id} className="sidebar-employee-group" aria-label={`${group.employee.display_name}的对话`}>
            <div className="sidebar-project-row">
              <button className="icon-button project-toggle" aria-label={`${expanded ? '收起' : '展开'}${group.employee.display_name}的对话`} aria-expanded={expanded} onClick={() => toggleEmployees(`employee:${group.id}`)}><ChevronDown size={13} style={{ transform: expanded ? undefined : 'rotate(-90deg)' }} /></button>
              <div className="employee-group-label"><UserRound size={15} /><span>{group.employee.display_name}</span></div>
              <button className="icon-button employee-group-remove" aria-label={`移除${group.employee.display_name}的对话查看`} title="停止查看此员工" disabled={Boolean(removingEmployee) || sidebar.busy} onClick={event => { event.stopPropagation(); void removeEmployeeGroup(group) }}><Trash2 size={14} /></button>
            </div>
            <div className="session-fold" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}><div className="session-fold-content">
              {group.sessions.map(sessionRow => <button key={sessionRow.id} className="employee-session-row" title={sessionRow.title || '未命名对话'} onClick={() => void openEmployeeConversation(group, sessionRow)}><MessageSquare size={14} /><span>{sessionRow.title || '未命名对话'}{sessionRow.archived ? ' · 已归档' : ''}</span><time>{sessionRow.started_at ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(sessionRow.started_at * 1000)) : ''}</time></button>)}
              {!group.sessions.length && <p className="sidebar-empty">{group.sync_error || '暂无对话'}</p>}
            </div></div>
          </section>
        })}
            </div>
          </section>
        })}
      </section>}
      <section className="sidebar-recent" aria-label="最近">
        <div className="sidebar-section-heading"><button className="sidebar-recent-heading" aria-current={selectedProject === null ? 'page' : undefined} disabled={draft.busy} onClick={() => { selectProject(null); onSelect() }}>最近</button></div>
        {recent.map(renderSession)}
        {!recent.length && <p className="sidebar-empty">{search ? '没有找到匹配的对话' : startup.history ? '正在读取最近对话…' : '未选择项目的新对话会显示在这里。'}</p>}
      </section>
    </div>
    <div className="sidebar-bottom">
      {(notice || sidebar.error) && <p className={`sidebar-feedback ${sidebar.error ? 'sidebar-action-error' : ''}`} role={sidebar.error ? 'alert' : 'status'}>{sidebarError || notice}{sidebar.error && !sidebar.loaded && <button onClick={() => void loadSidebar()}>重新加载</button>}</p>}
      <div className="sidebar-account-row"><button className="account-button" aria-label="系统设置" onClick={() => onSettings()}><span className="workspace-avatar">{user?.username.slice(0, 1).toUpperCase() || '巨'}</span><span><strong>{user?.display_name || user?.username || '巨豹智能体'}</strong><small>{user ? `${user.username} · ${roleLabels[user.role]}` : '创作工作区'}</small></span><Settings2 size={16} /></button><button className="icon-button sidebar-theme" aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={onTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button></div>
    </div>
    {menu && <SidebarMenu anchor={menu.anchor} label={menu.kind === 'project' ? '项目操作' : '聊天操作'} actions={actions} onClose={closeMenu} />}
    {creatingProject && <CreateProjectDialog busy={sidebar.busy} error={sidebar.error} onClose={() => setCreatingProject(false)} onCreate={createProject} />}
    {deleting && <DeleteChatDialog title={deleting.title} busy={sidebar.busy} blocked={draft.busy || session.storedId === deleting.id && conversation.running} error={sidebar.error} onClose={() => setDeleting(null)} onDelete={async () => {
      if (workspace.composer.get().busy || workspace.session.get().storedId === deleting.id && workspace.conversation.get().running) return false
      if (!await deleteSidebarSession(deleting.id)) return false
      workspace.forgetConversation(deleting.id); setNotice('聊天已删除'); return true
    }} />}
    {dialog && <SidebarDialog title={dialog.kind === 'project-hide' ? '移除项目' : dialog.kind === 'project-name' ? '编辑项目' : '编辑聊天名称'} initialName={dialog.kind === 'project-hide' ? undefined : dialog.title}
      description={dialog.kind === 'project-hide' ? `“${dialog.title}”将从侧栏隐藏，聊天和稿件会保留。之后可在“系统设置 → 已归档”中恢复。` : dialog.kind === 'project-name' ? '为你的项目设置一个便于识别的名称。' : '为这段创作对话设置一个便于查找的名称。'}
      submitLabel={dialog.kind === 'project-hide' ? '移除项目' : '保存'} busy={sidebar.busy} error={sidebar.error} onClose={() => setDialog(null)} onSubmit={name => dialog.kind === 'session-name' ? updateSession(dialog.id, { title: name }, '聊天名称已更新') : updateProject(dialog.id, dialog.kind === 'project-hide' ? { hidden: true } : { title: name }, dialog.kind === 'project-hide' ? '' : '项目名称已更新')} />}
  </aside>
}
