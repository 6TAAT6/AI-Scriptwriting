import { useStore } from '@nanostores/react'
import { Archive, ArchiveRestore, FolderOpen, LoaderCircle, MessageSquare, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { $sidebar, deleteSidebarProject, deleteSidebarSession, loadSidebar, patchSidebarProject, patchSidebarSession, sidebarSessionProjectId, sidebarSessionTitle } from '../lib/sidebar'
import { DeleteChatDialog, SidebarDialog } from '../components/SidebarMenu'
import { workspace } from '../store/workspace'
import { FormNotice } from './Fields'
import './ArchivedChatsPanel.css'

export function ArchivedChatsPanel() {
  const sidebar = useStore($sidebar)
  const navigation = useStore(workspace.navigation)
  const current = useStore(workspace.session)
  const conversation = useStore(workspace.conversation)
  const draft = useStore(workspace.composer)
  const [notice, setNotice] = useState('')
  const [restoring, setRestoring] = useState('')
  const [restoringProject, setRestoringProject] = useState('')
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const [deletingProject, setDeletingProject] = useState<{ id: string; title: string } | null>(null)
  useEffect(() => { void loadSidebar() }, [])
  const sessions = sidebar.sessions.filter(row => row.archived)
  const projects = sidebar.projects.filter(project => project.hidden)
  const history = new Map(navigation.sessions.map(row => [row.id, row]))
  async function restore(id: string, title: string) {
    if (sidebar.busy) return
    setRestoring(id); setNotice('')
    if (await patchSidebarSession(id, { archived: false })) setNotice(`“${title}”已恢复到${sidebarSessionProjectId(id) === null ? '最近' : '项目'}。`)
    setRestoring('')
  }
  async function restoreProject(id: string, title: string) {
    if (sidebar.busy) return
    setRestoringProject(id); setNotice('')
    if (await patchSidebarProject({ hidden: false }, id)) setNotice(`项目“${title}”已恢复到侧栏。`)
    setRestoringProject('')
  }
  return <section className="archived-chats-panel" aria-labelledby="archived-chats-title">
    <div className="account-page-heading"><div><h2 id="archived-chats-title">已归档</h2><p>已移除的项目和归档的聊天统一保留在这里，恢复后回到原来的位置。</p></div><span className="archived-chats-count">{projects.length} 个项目 · {sessions.length} 个聊天</span></div>
    <FormNotice error={sidebar.error} message={notice} />
    {projects.length > 0 && <section className="archived-projects" aria-label="已移除项目"><h3>项目</h3><ul className="archived-chats-list">{projects.map(project =>
      <li key={project.id}><span className="archived-chat-icon"><FolderOpen size={18} /></span><div><strong>{project.title}</strong><small>聊天与稿件已保留</small></div><button className="secondary-button" aria-label={`恢复项目${project.title}`} disabled={sidebar.busy} aria-busy={restoringProject === project.id} onClick={() => void restoreProject(project.id, project.title)}>{restoringProject === project.id ? <LoaderCircle size={15} className="account-spin" /> : <ArchiveRestore size={15} />}{restoringProject === project.id ? '正在恢复…' : '恢复项目'}</button><button className="secondary-button archived-chat-delete" aria-label={`彻底删除项目${project.title}`} disabled={sidebar.busy || draft.busy} onClick={() => { $sidebar.set({ ...sidebar, error: '' }); setDeletingProject(project) }}><Trash2 size={15} />彻底删除</button></li>
    )}</ul></section>}
    {projects.length > 0 && <h3>聊天</h3>}
    {!sidebar.loaded ? <div className="account-table-empty" role="status">{sidebar.error ? <button className="secondary-button" onClick={() => void loadSidebar()}>重新加载</button> : <><LoaderCircle size={20} className="account-spin" /><p>正在读取已归档聊天…</p></>}</div> : sessions.length ? <ul className="archived-chats-list">
      {sessions.map(row => {
        const stored = history.get(row.id)
        const title = sidebarSessionTitle(row.id, stored?.title, sidebar)
        return <li key={row.id}><span className="archived-chat-icon"><MessageSquare size={18} /></span><div><strong>{title}</strong>{stored?.started_at ? <time>{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(stored.started_at * 1000))}</time> : <small>已归档</small>}</div><button className="secondary-button" aria-label={`恢复${title}`} disabled={sidebar.busy} aria-busy={restoring === row.id} onClick={() => void restore(row.id, title)}>{restoring === row.id ? <LoaderCircle size={15} className="account-spin" /> : <ArchiveRestore size={15} />}{restoring === row.id ? '正在恢复…' : '恢复'}</button><button className="secondary-button archived-chat-delete" aria-label={`删除${title}`} disabled={sidebar.busy || draft.busy || current.storedId === row.id && conversation.running} onClick={() => { $sidebar.set({ ...$sidebar.get(), error: '' }); setNotice(''); setDeleting({ id: row.id, title }) }}><Trash2 size={15} />彻底删除</button></li>
      })}
    </ul> : <div className="account-table-empty archived-chats-empty"><Archive size={30} /><strong>还没有已归档的聊天</strong><p>在聊天的更多菜单中选择“归档聊天”，即可收起暂时不用的对话。</p></div>}
    {deleting && <DeleteChatDialog title={deleting.title} busy={sidebar.busy} blocked={draft.busy || current.storedId === deleting.id && conversation.running} error={sidebar.error} onClose={() => setDeleting(null)} onDelete={async () => {
      if (workspace.composer.get().busy || workspace.session.get().storedId === deleting.id && workspace.conversation.get().running) return false
      if (!await deleteSidebarSession(deleting.id)) return false
      workspace.forgetConversation(deleting.id); return true
    }} />}
    {deletingProject && <SidebarDialog title="彻底删除项目" description={`确定永久删除“${deletingProject.title}”及其中全部聊天记录？删除后不可恢复。已上传的原稿和导出文件会保留。`}
      submitLabel="彻底删除" busyLabel="正在删除…" danger busy={sidebar.busy} disabled={draft.busy} error={sidebar.error} onClose={() => setDeletingProject(null)} onSubmit={async () => {
        if (workspace.composer.get().busy) return false
        const ids = await deleteSidebarProject(deletingProject.id)
        if (!ids) return false
        for (const id of ids) workspace.forgetConversation(id)
        setNotice('项目及聊天记录已永久删除。')
        return true
      }} />}
  </section>
}
