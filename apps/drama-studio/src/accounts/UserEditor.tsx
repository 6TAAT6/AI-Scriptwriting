import { ArrowLeft, KeyRound, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { createUser, resetPassword, updateUser, type StudioUser } from './api'
import { FormNotice, PasswordField } from './Fields'
import { ORGANIZATIONS, authorizedOrganizations, organizationIds, type OrganizationId } from '../../shared/organizations.mjs'

const companyOrganizations: OrganizationId[] = ['hangzhou', 'chongqing']

export type UserEditorMode = { kind: 'create' } | { kind: 'edit' | 'password' | 'status'; user: StudioUser }
interface UserEditorProps { actor: StudioUser; mode: UserEditorMode; onCancel: () => void; onSaved: (user: StudioUser | null, message: string) => void }

export function UserEditor({ actor, mode, onCancel, onSaved }: UserEditorProps) {
  const usernameId = useId()
  const organizationId = useId()
  const subject = mode.kind === 'create' ? null : mode.user
  const [username, setUsername] = useState(subject?.username || '')
  const [name, setName] = useState(subject?.display_name || '')
  const [role, setRole] = useState<'admin' | 'employee'>(subject?.role === 'admin' ? 'admin' : 'employee')
  const [password, setPassword] = useState('')
  const [organization, setOrganization] = useState<OrganizationId>(subject?.organization ?? 'chongqing')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titles = { create: '创建账号', edit: '编辑账号', password: '重置密码', status: subject?.enabled ? '停用账号' : '启用账号' }
  const submitLabels = { create: '确认创建', edit: '保存修改', password: '确认重置', status: subject?.enabled ? '确认停用' : '确认启用' }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      if (mode.kind === 'create') {
        const user = await createUser({ username: username.trim(), display_name: name.trim(), password, role, ...(actor.organization_policy ? { organization } : {}) })
        onSaved(user, `账号 ${user.username} 已创建。`)
      } else {
        const actions = {
          edit: async () => {
            const ownership = actor.organization_policy && actor.role === 'super_admin' ? { organization } : {}
            const user = await updateUser(mode.user.id, { display_name: name.trim(), role, ...ownership })
            onSaved(user, `账号 ${user.username} 已更新。`)
          },
          password: async () => {
            await resetPassword(mode.user.id, password)
            onSaved(null, `${mode.user.username} 的密码已重置，原有登录已失效。`)
          },
          status: async () => {
            const user = await updateUser(mode.user.id, { enabled: !mode.user.enabled })
            onSaved(user, `账号 ${user.username} 已${user.enabled ? '启用' : '停用'}。`)
          }
        }
        await actions[mode.kind]()
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试。'); setBusy(false) }
  }
  return <>
    <button type="button" className="account-back" onClick={onCancel} disabled={busy}><ArrowLeft size={15} />返回用户列表</button>
    <div className="account-page-heading"><div><h2>{titles[mode.kind]}</h2><p>{mode.kind === 'create' ? '为团队成员分配一个独立的创作账号。' : `正在管理 ${subject?.display_name || subject?.username}（${subject?.username}）`}</p></div></div>
    <form className="account-form account-user-form" onSubmit={event => void submit(event)}>
      {(mode.kind === 'create' || mode.kind === 'edit') && <>
        <div className="account-field"><label htmlFor={usernameId}>账号</label><input id={usernameId} aria-describedby={`${usernameId}-hint`} name="username" value={username} autoComplete="off" required minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,63}" disabled={mode.kind === 'edit'} placeholder="例如 writer_01" onChange={event => setUsername(event.target.value)} /><small id={`${usernameId}-hint`}>3–64 位字母、数字、下划线、点或短横线，以字母或数字开头。</small></div>
        <label className="account-field"><span>姓名 / 备注</span><input name="display_name" value={name} disabled={subject?.auth_source === 'company'} required maxLength={80} placeholder="用于识别团队成员" onChange={event => setName(event.target.value)} /></label>
        {actor.organization_policy && <div className="account-field"><label htmlFor={organizationId}>所属公司</label><select id={organizationId} aria-describedby={mode.kind === 'create' ? organizationId + '-hint' : undefined} value={organization} disabled={mode.kind !== 'create' && actor.role !== 'super_admin'} onChange={event => setOrganization(event.target.value as OrganizationId)}>
          {(mode.kind === 'create' ? authorizedOrganizations(actor).filter(value => value !== 'hangzhou') : subject?.auth_source === 'company' ? companyOrganizations : organizationIds).map(value => <option key={value} value={value}>{ORGANIZATIONS[value]}</option>)}
        </select>{mode.kind === 'create' && <small id={organizationId + '-hint'}>横店员工通过公司账号首次登录建立工作区。</small>}</div>}
        <fieldset className="account-role-field"><legend>角色</legend><div className="account-role-options">
          <label className={role === 'employee' ? 'is-selected' : ''}><input type="radio" name="role" value="employee" checked={role === 'employee'} onChange={() => setRole('employee')} aria-label="员工" /><UserRound size={18} /><span><strong>员工</strong><small>使用个人创作工作区</small></span></label>
          {actor.role === 'super_admin' && <label className={role === 'admin' ? 'is-selected' : ''}><input type="radio" name="role" value="admin" checked={role === 'admin'} onChange={() => setRole('admin')} aria-label="管理员" /><ShieldCheck size={18} /><span><strong>管理员</strong><small>创作并管理员工账号</small></span></label>}
        </div></fieldset>
      </>}
      {(mode.kind === 'create' || mode.kind === 'password') && <PasswordField label={mode.kind === 'create' ? '初始密码' : '新密码'} name="new-password" autoComplete="new-password" value={password} required minLength={6} maxLength={256} placeholder="至少 6 个字符" onChange={event => setPassword(event.target.value)} />}
      {mode.kind === 'password' && <p className="account-helper"><KeyRound size={15} />重置后该成员需要使用新密码重新登录。</p>}
      {mode.kind === 'status' && <div className="account-status-confirm"><ShieldCheck size={26} /><h3>{subject?.enabled ? '停用后，该成员将无法登录。' : '启用后，该成员可以恢复登录。'}</h3><p>{subject?.enabled ? '已保存的创作资料会保留，之后可以重新启用账号。' : '成员可以继续使用原有账号和密码登录。'}</p></div>}
      <FormNotice error={error} />
      <div className="account-form-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className={`primary-button ${mode.kind === 'status' && subject?.enabled ? 'account-danger-button' : ''}`} aria-busy={busy} disabled={busy}>{busy && <LoaderCircle size={15} className="account-spin" />}{busy ? '正在保存…' : submitLabels[mode.kind]}</button></div>
    </form>
  </>
}
