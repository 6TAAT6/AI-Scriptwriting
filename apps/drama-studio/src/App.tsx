import { useStore } from '@nanostores/react'
import { ChevronRight, FileText, FolderOpen, PanelLeft, PanelRight, X } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import type { Artifact } from './lib/creative'
import { publicText } from './lib/transcript'
import { useDrawerFocus } from './lib/use-drawer-focus'
import { connectWorkspace, workspace } from './store/workspace'
import { Composer } from './components/Composer'
import { ReleaseNotice } from './components/ReleaseNotice'
import { FileDropOverlay } from './components/FileDropOverlay'
import { Inspector } from './components/Inspector'
import { RequestCards } from './components/RequestCards'
import { AccountsSettings } from './accounts/AccountsSettings'
import { Brand } from './components/Brand'
import { Sidebar } from './components/Sidebar'
import { $selectedSidebarProjectId, $sidebar, sidebarSessionProjectId, sidebarSessionTitle } from './lib/sidebar'
import { Transcript } from './components/Transcript'
import { EmployeeConversationViewer } from './components/EmployeeConversationViewer'
import { $employeeViewer } from './employee-access/api'
import { $updateAvailable } from './lib/workspace-update'
import { useResizablePane } from './lib/resizable-pane'
import { trackViewportResize } from './lib/viewport-resize'
import { useWelcomeGreeting } from './lib/use-welcome-greeting'

/** 顶栏连接状态：直接显示创作服务连接的真实状态，不推算延迟等没有的数据。 */
const CONNECTION_LABELS: Record<string, string> = { idle: '准备连接', connecting: '正在连接创作服务', open: '创作服务已连接', closed: '连接已断开', error: '连接异常' }

function Welcome() {
  const greeting = useWelcomeGreeting()
  return <div className="welcome">
    <div className="welcome-heading"><span className="welcome-mark"><Brand markOnly /></span><h1>{greeting.title}</h1>{greeting.note && <p>{greeting.note}</p>}</div>
    <Composer />
  </div>
}

export function App() {
  const conversation = useStore(workspace.conversation)
  const navigation = useStore(workspace.navigation)
  const session = useStore(workspace.session)
  const project = useStore(workspace.project)
  const updateAvailable = useStore($updateAvailable)
  const employeeViewer = useStore($employeeViewer)
  const connection = useStore(workspace.connection)
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760)
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1180)
  const [selected, setSelected] = useState<Artifact | null>(null)
  const [settings, setSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'employee-access' | undefined>()
  const [width, setWidth] = useState(window.innerWidth)
  const [theme, setTheme] = useState(() => localStorage.getItem('drama-studio:theme') === 'dark' ? 'dark' : 'light')
  const inspectorPane = useResizablePane(width > 760 && inspector)
  const sidebarPane = useResizablePane(width > 760 && sidebar, 'left')
  useEffect(() => {
    const resize = () => { setWidth(window.innerWidth); if (window.innerWidth <= 760) { setSidebar(false); setInspector(false) } }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => trackViewportResize(), [])
  useDrawerFocus('.sidebar', sidebar && width <= 760 && !settings)
  useDrawerFocus('.inspector', inspector && width <= 760 && !sidebar && !settings)
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('drama-studio:theme', theme) }, [theme])
  useEffect(() => { setSelected(null) }, [session.storedId])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); workspace.newConversation() }
      if (event.key === 'Escape' && !document.querySelector('dialog[open]') && window.innerWidth < 1100) { setInspector(false); setSidebar(false) }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  const active = navigation.sessions.find(row => row.id === session.storedId)
  const sidebarData = useStore($sidebar)
  const selectedProjectId = useStore($selectedSidebarProjectId)
  const displayedProjectId = session.storedId ? sidebarSessionProjectId(session.storedId, sidebarData) : selectedProjectId
  const selectedProject = sidebarData.projects.find(project => project.id === displayedProjectId)
  const title = (active ? sidebarData.sessions.find(row => row.id === active.id)?.title : undefined) || project?.title || (active ? sidebarSessionTitle(active.id, active.title, sidebarData) : '新的创作')
  const inspectFile = (file: { path: string; name: string }) => {
    setSelected({ id: file.path, name: file.name, path: file.path, kind: 'document' }); setInspector(true)
  }
  const closeMobileSidebar = () => { if (window.innerWidth <= 760) setSidebar(false) }
  return <div className={`studio-app ${sidebar ? 'sidebar-open' : ''} ${inspector ? 'inspector-open' : ''} ${selected ? 'document-open' : ''}`}>
    <button className="sidebar-backdrop" aria-label="关闭会话列表" hidden={!sidebar} onClick={() => setSidebar(false)} />
    <div className={`sidebar-panel ${sidebarPane.dragging ? 'is-resizing' : ''}`} inert={!sidebar} aria-hidden={!sidebar} style={width > 760 ? { '--sidebar-width': `${sidebarPane.width}px` } as CSSProperties : undefined}>
      {sidebar && width > 760 && <div className={`sidebar-resize-handle ${sidebarPane.dragging ? 'is-dragging' : ''}`} {...sidebarPane.handleProps} />}
      <Sidebar active={sidebar} theme={theme} onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} onSettings={section => { closeMobileSidebar(); setSettingsSection(section); setSettings(true) }} onCollapse={() => setSidebar(false)} onSelect={closeMobileSidebar} />
    </div>
    <main className="workspace-main" inert={width <= 760 && (sidebar || inspector)}>
      <FileDropOverlay disabled={settings} />
      <header className="workspace-header"><div className="workspace-breadcrumb">{!sidebar && <button className="icon-button" aria-label="展开会话列表" onClick={() => setSidebar(true)}><PanelLeft size={18} /></button>}<FolderOpen size={15} /><span className="breadcrumb-parent">{selectedProject?.title || '最近'}</span><ChevronRight size={12} /><strong>{title}</strong></div>
        <div className="workspace-header-actions"><span className="connection-pill" data-state={connection}><span aria-hidden="true" />{CONNECTION_LABELS[connection] ?? '准备连接'}</span>
        <button className={`text-button pane-toggle ${inspector ? 'selected' : ''}`} aria-label={inspector ? '隐藏创作资料' : '打开创作资料'} onClick={() => setInspector(!inspector)}>{inspector ? <PanelRight size={16} /> : <FileText size={16} />}<span>创作资料</span></button></div>
      </header>
      <ReleaseNotice />
      {updateAvailable && <div className="update-banner" role="status">新版本已就绪，将在当前创作和输入结束后自动更新。</div>}
      {(navigation.error || conversation.error) && <div className="error-banner" role="alert"><span>{publicText(navigation.error || conversation.error)}</span>{navigation.error && <button onClick={() => void connectWorkspace()}>重试连接</button>}<button className="icon-button" aria-label="关闭提示" onClick={() => { workspace.navigation.set({ ...navigation, error: '' }); workspace.conversation.set({ ...conversation, error: '' }) }}><X size={14} /></button></div>}
      {employeeViewer.group ? <EmployeeConversationViewer /> : navigation.loading ? <div className="loading-conversation" role="status"><span className="thinking-dot" />正在打开创作记录…</div> : conversation.entries.length ? <><Transcript onReadFile={inspectFile} /><div className="conversation-dock"><RequestCards /><Composer /></div></> : <Welcome />}
    </main>
    <div className="inspector-panel" inert={!inspector} aria-hidden={!inspector} style={{ '--inspector-width': `${inspectorPane.width}px` } as CSSProperties}>
      {inspector && <div className={`inspector-resize-handle ${inspectorPane.dragging ? 'is-dragging' : ''}`} {...inspectorPane.handleProps} />}
      <Inspector selected={selected} onSelect={setSelected} onClose={() => setInspector(false)} />
    </div>
    {settings && <AccountsSettings initialSection={settingsSection} onClose={() => { setSettings(false); setSettingsSection(undefined) }} />}
  </div>
}
