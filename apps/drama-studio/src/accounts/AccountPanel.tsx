import { Check, KeyRound, LoaderCircle, Save, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { changePassword, roleLabels, updateAccount, type StudioUser } from './api'
import { FormNotice, PasswordField } from './Fields'

export function AccountPanel({ user }: { user: StudioUser }) {
  const [name, setName] = useState(user.display_name)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState('')
  const [notice, setNotice] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState('')

  async function saveName(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true); setNameError(''); setNotice('')
    try { await updateAccount(name.trim()); setNotice('昵称已更新。') }
    catch (reason) { setNameError(reason instanceof Error ? reason.message : '昵称保存失败。') }
    finally { setSaving(false) }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault()
    if (passwordBusy) return
    setPasswordError('')
    if (password !== confirmation) { setPasswordError('两次输入的新密码不一致。'); return }
    if (password === currentPassword) { setPasswordError('新密码不能与当前密码相同。'); return }
    setPasswordBusy(true)
    try { await changePassword(currentPassword, password) }
    catch (reason) { setPasswordError(reason instanceof Error ? reason.message : '密码修改失败。'); setPasswordBusy(false) }
  }
  return <section className="account-personal">
    <div className="account-page-heading"><div><h2>个人账号</h2><p>管理你的个人信息与登录密码。</p></div></div>
    <div className="account-profile-card"><span className="account-avatar large">{(user.display_name || user.username).slice(0, 1)}</span><div><strong>{user.display_name || user.username}</strong><span>@{user.username}</span></div><span className="account-role"><ShieldCheck size={13} />{roleLabels[user.role]}</span></div>
    <form className="account-form account-section" onSubmit={event => void saveName(event)}>
      <h3>基本信息</h3>
      <div className="account-field-grid"><label className="account-field"><span>登录账号</span><input value={user.username} disabled /></label><label className="account-field"><span>昵称</span><input value={name} required maxLength={80} onChange={event => { setName(event.target.value); setNotice('') }} /></label></div>
      <div className="account-inline-footer"><FormNotice error={nameError} message={notice} /><button type="submit" className="secondary-button" aria-busy={saving} disabled={saving || !name.trim() || name.trim() === user.display_name}>{saving ? <LoaderCircle size={15} className="account-spin" /> : notice && !nameError ? <Check size={15} /> : <Save size={15} />}{saving ? '正在保存…' : '保存信息'}</button></div>
    </form>
    <form className="account-form account-section" onSubmit={event => void savePassword(event)}>
      <div className="account-section-heading"><KeyRound size={17} /><h3>修改密码</h3></div><p className="account-helper">修改成功后需要重新登录，其他设备上的登录也会失效。</p>
      <PasswordField label="当前密码" value={currentPassword} required maxLength={256} autoComplete="current-password" onChange={event => setCurrentPassword(event.target.value)} />
      <div className="account-field-grid"><PasswordField label="新密码" value={password} required minLength={8} maxLength={256} autoComplete="new-password" placeholder="至少 8 个字符" onChange={event => setPassword(event.target.value)} /><PasswordField label="确认新密码" value={confirmation} required minLength={8} maxLength={256} autoComplete="new-password" placeholder="再次输入新密码" onChange={event => setConfirmation(event.target.value)} /></div>
      <div className="account-inline-footer"><FormNotice error={passwordError} /><button type="submit" className="primary-button" aria-busy={passwordBusy} disabled={passwordBusy}>{passwordBusy && <LoaderCircle size={15} className="account-spin" />}{passwordBusy ? '正在修改…' : '修改密码'}</button></div>
    </form>
  </section>
}
