import { ChevronDown, LoaderCircle, MapPin, PencilLine, Plus, RefreshCw, Search, ShieldCheck, Trash2, UserRound, UsersRound, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { canManageUser, deleteUser, listUsers, roleLabels, type StudioUser } from './api'
import { FormNotice } from './Fields'
import { UserEditor, type UserEditorMode } from './UserEditor'
import { groupByRegion } from './regions'

export function UsersPanel({ actor }: { actor: StudioUser }) {
  const [users, setUsers] = useState<StudioUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState({ chongqing: false, hangzhou: false })
  const [editor, setEditor] = useState<UserEditorMode | null>(null)
  const [deleting, setDeleting] = useState<StudioUser | null>(null)
  useEffect(() => {
    let mounted = true
    void listUsers().then(result => { if (mounted) setUsers(result) })
      .catch(reason => { if (mounted) setError(reason instanceof Error ? reason.message : '人员列表读取失败。') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])
  async function refresh() {
    setLoading(true); setError(''); setNotice('')
    try { setUsers(await listUsers()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '人员列表读取失败。') }
    finally { setLoading(false) }
  }
  function saved(user: StudioUser | null, message: string) {
    if (user) setUsers(previous => previous.some(item => item.id === user.id) ? previous.map(item => item.id === user.id ? user : item) : [...previous, user])
    setEditor(null); setNotice(message); setError('')
  }
  const matched = users.filter(user => `${user.username} ${user.display_name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const searching = Boolean(query.trim())
  const regions = groupByRegion(matched, user => user)
  if (editor) return <section className="account-editor-page">
    <UserEditor actor={actor} mode={editor} onCancel={() => setEditor(null)} onSaved={saved} />
  </section>
  if (deleting) return <DeleteUserDialog user={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setUsers(previous => previous.filter(item => item.id !== deleting.id)); setDeleting(null); setNotice('账号已删除'); setError('') }} />
  return <section className="account-users">
    <div className="account-page-heading"><div><h2>用户列表</h2><p>管理团队成员与账号访问权限。</p></div><button type="button" className="primary-button" onClick={() => setEditor({ kind: 'create' })}><Plus size={16} />创建账号</button></div>
    <div className="account-stats">
      <div><span className="account-stat-icon total"><UsersRound size={19} /></span><span><small>用户总数</small><strong>{loading ? '—' : users.length}</strong></span></div>
      <div><span className="account-stat-icon admin"><ShieldCheck size={19} /></span><span><small>管理员</small><strong>{loading ? '—' : users.filter(user => user.role !== 'employee').length}</strong></span></div>
      <div><span className="account-stat-icon employee"><UserRound size={19} /></span><span><small>员工</small><strong>{loading ? '—' : users.filter(user => user.role === 'employee').length}</strong></span></div>
    </div>
    <div className="account-list-toolbar"><label className="account-search"><Search size={16} /><input type="search" aria-label="搜索人员" placeholder="搜索用户名或昵称…" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading} aria-busy={loading}><RefreshCw size={15} className={loading ? 'account-spin' : ''} />刷新</button></div>
    <FormNotice error={error} message={notice} />
    <div className="account-table-wrap" aria-busy={loading}>
      <table className="account-table"><thead><tr><th>用户名</th><th>昵称</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
        {!loading && regions.filter(region => !searching || region.members.length > 0).map(region => {
          const expanded = searching || !collapsed[region.id]
          return <tbody key={region.id} className="account-region-group" data-region={region.id} aria-label={`${region.label}地区成员`}>
          <tr className="account-region-heading"><th colSpan={6} scope="rowgroup">
            <button type="button" className="account-region-toggle" aria-label={`${region.label}，${region.members.length} 人`} aria-expanded={expanded} disabled={searching} onClick={() => setCollapsed(previous => ({ ...previous, [region.id]: !previous[region.id] }))}>
              <MapPin size={17} aria-hidden="true" /><strong>{region.label}</strong><span className="account-region-count">{region.members.length} 人</span><small>{searching ? '搜索结果' : expanded ? '收起' : '展开'}</small><ChevronDown size={16} className="account-region-chevron" aria-hidden="true" />
            </button>
          </th></tr>
          {expanded && region.members.map(user => <tr key={user.id}>
          <td><strong>{user.username}</strong>{user.id === actor.id && <span className="account-self">我</span>}</td><td>{user.display_name}</td>
          <td><span className={`account-role ${user.role === 'employee' ? 'employee' : ''}`}>{roleLabels[user.role]}</span></td>
          <td><span className={`account-status ${!user.enabled ? 'disabled' : user.activation_required ? 'pending' : ''}`}><span />{!user.enabled ? '已停用' : user.activation_required ? '待激活' : user.role === 'super_admin' ? '正常' : '已激活'}</span></td>
          <td><time dateTime={user.created_at}>{formatDate(user.created_at)}</time></td>
          <td>{canManageUser(actor, user) ? <div className="account-row-actions">
            <button type="button" onClick={() => setEditor({ kind: 'edit', user })}><PencilLine size={12} />编辑</button>
            <button type="button" onClick={() => setEditor({ kind: 'password', user })}>重置密码</button>
            <button type="button" className={user.enabled ? 'is-danger' : 'is-enable'} onClick={() => setEditor({ kind: 'status', user })}>{user.enabled ? '停用' : '启用'}</button>
            {actor.role === 'super_admin' && user.role !== 'super_admin' && <button type="button" className="is-danger" onClick={() => setDeleting(user)}><Trash2 size={12} />删除</button>}
          </div> : <span className="account-protected">{user.role === 'super_admin' ? '受保护账号' : user.id === actor.id ? '在个人账号中设置' : '仅超级管理员可管理'}</span>}</td>
        </tr>)}</tbody>})}
        <tbody>
        {loading && <tr><td colSpan={6}><div className="account-table-empty" role="status"><LoaderCircle size={22} className="account-spin" aria-hidden="true" />正在加载人员…</div></td></tr>}
        {!loading && !matched.length && <tr><td colSpan={6}><div className="account-table-empty"><UsersRound size={26} /><strong>{error ? '人员列表暂不可用' : query ? '没有找到匹配的人员' : '暂无团队成员'}</strong><p>{error ? '请点击刷新重新加载。' : query ? '试试其他用户名或昵称。' : '创建账号，邀请成员开始创作。'}</p></div></td></tr>}
        </tbody>
      </table>
    </div>
    {!loading && users.length > 0 && <p className="account-list-summary">{query ? `已找到 ${matched.length} 位成员，共 ${users.length} 位` : `共 ${users.length} 位成员`}</p>}
  </section>
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: StudioUser; onClose: () => void; onDeleted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try { await deleteUser(user.id); onDeleted() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除账号失败，请重试。'); setBusy(false) }
  }
  return <dialog ref={dialog} className="sidebar-dialog account-delete-dialog" aria-labelledby="delete-user-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><h2 id="delete-user-title">删除账号</h2><button type="button" className="icon-button" disabled={busy} aria-label="关闭删除确认" onClick={onClose}><X size={17} /></button></header>
    <form onSubmit={event => void submit(event)}>
      <p>确定删除账号“{user.username}”（{user.display_name}）吗？该账号的登录状态、创作记录、独立工作区和员工进程都会被永久清理。</p>
      {error && <p className="sidebar-action-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button is-danger" disabled={busy}>{busy ? '正在删除…' : '确认删除'}</button></footer>
    </form>
  </dialog>
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}
