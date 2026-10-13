import { useStore } from '@nanostores/react'
import { Archive, Eye, KeyRound, TicketCheck, LoaderCircle, LogOut, Settings2, ShieldCheck, UserRound, UsersRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { $currentUser, logout, roleLabels } from './api'
import { AccountPanel } from './AccountPanel'
import { UsersPanel } from './UsersPanel'
import { ModelsPanel } from './ModelsPanel'
import { ActivationCodesPanel } from './ActivationCodesPanel'
import { ArchivedChatsPanel } from './ArchivedChatsPanel'
import { FormNotice } from './Fields'
import { EmployeeAccessPanel } from '../employee-access/EmployeeAccessPanel'
import './accounts.css'

interface AccountsSettingsProps { onClose: () => void; initialSection?: 'account' | 'users' | 'archived' | 'models' | 'activation' | 'employee-access' }

export function AccountsSettings({ onClose, initialSection }: AccountsSettingsProps) {
  const user = useStore($currentUser)
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<NonNullable<AccountsSettingsProps['initialSection']>>(() => (initialSection === 'users' && user?.role === 'employee' || ['models', 'activation', 'employee-access'].includes(initialSection || '') && user?.role === 'employee') ? 'account' : initialSection || (user?.role === 'employee' ? 'account' : 'users'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (!closing || !dialog.current) return
    const element = dialog.current
    const animations = element.getAnimations?.() ?? []
    if (!animations.length) { element.close(); return }
    let active = true
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (active) element.close()
    })
    return () => { active = false }
  }, [closing])
  if (!user) return null
  const canManage = user.role !== 'employee'
  async function signOut() {
    setBusy(true); setError('')
    try { await logout() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '退出失败，请重试。'); setBusy(false) }
  }
  return <dialog ref={dialog} className={`accounts-dialog${closing ? ' is-closing' : ''}`} aria-labelledby="accounts-title" onClose={onClose}
    onCancel={event => { event.preventDefault(); setClosing(true) }}
    onClick={event => { if (event.target === dialog.current) setClosing(true) }}>
    <div className="accounts-shell">
      <header className="accounts-header"><div><Settings2 size={19} /><h1 id="accounts-title">系统设置</h1></div><button type="button" className="icon-button" aria-label="关闭设置" onClick={() => setClosing(true)}><X size={19} /></button></header>
      <div className="accounts-body">
        <nav className="accounts-nav" aria-label="设置分类">
          <div className="accounts-nav-caption">工作区</div>
          <button type="button" className={tab === 'account' ? 'is-active' : ''} aria-current={tab === 'account' ? 'page' : undefined} onClick={() => setTab('account')}><UserRound size={17} />个人账号</button>
          {canManage && <button type="button" className={tab === 'users' ? 'is-active' : ''} aria-current={tab === 'users' ? 'page' : undefined} onClick={() => setTab('users')}><UsersRound size={17} />人员管理</button>}
          {canManage && <button type="button" className={tab === 'employee-access' ? 'is-active' : ''} aria-current={tab === 'employee-access' ? 'page' : undefined} onClick={() => setTab('employee-access')}><Eye size={17} />员工对话</button>}
          {user.role === 'super_admin' && <button type="button" className={tab === 'models' ? 'is-active' : ''} aria-current={tab === 'models' ? 'page' : undefined} onClick={() => setTab('models')}><KeyRound size={17} />模型接入</button>}
          {user.role === 'super_admin' && <button type="button" className={tab === 'activation' ? 'is-active' : ''} aria-current={tab === 'activation' ? 'page' : undefined} onClick={() => setTab('activation')}><TicketCheck size={17} />激活码管理</button>}
          <button type="button" className={tab === 'archived' ? 'is-active' : ''} aria-current={tab === 'archived' ? 'page' : undefined} onClick={() => setTab('archived')}><Archive size={17} />已归档</button>
          <div className="accounts-nav-bottom"><div className="accounts-identity"><span className="account-avatar">{(user.display_name || user.username).slice(0, 1)}</span><span><strong>{user.display_name || user.username}</strong><small><ShieldCheck size={12} />{roleLabels[user.role]}</small></span></div><FormNotice error={error} /><button type="button" disabled={busy} aria-busy={busy} onClick={() => void signOut()}>{busy ? <LoaderCircle size={16} className="account-spin" /> : <LogOut size={16} />}{busy ? '正在退出…' : '退出登录'}</button></div>
        </nav>
        <div className="accounts-content" key={tab}>
          {tab === 'account' && <AccountPanel key={user.id} user={user} />}
          {tab === 'users' && canManage && <UsersPanel actor={user} />}
          {tab === 'employee-access' && canManage && <EmployeeAccessPanel />}
          {tab === 'models' && user.role === 'super_admin' && <ModelsPanel />}
          {tab === 'activation' && user.role === 'super_admin' && <ActivationCodesPanel />}
          {tab === 'archived' && <ArchivedChatsPanel />}
        </div>
      </div>
    </div>
  </dialog>
}
