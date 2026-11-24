import { useStore } from '@nanostores/react'
// 测试版静态边界不放行单独的图片文件，暗色标识以内联数据随脚本下发。
import markDark from '../assets/jubao-mark-dark.png?inline'
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Brand } from '../components/Brand'
import { $authenticationNotice, $currentUser, activateCompanyAccount, clearAuthentication, completeCompanyLogin, consumeCompanySwitchIntent, expireAuthentication, launchCompanyLogin, loadCurrentUser, login, loginOptions, logout, startCompanyLogin, type StudioUser } from './api'
import { FormNotice, PasswordField } from './Fields'
import { LoginBackdrop } from './LoginBackdrop'
import './accounts.css'
import './Login.css'

interface AuthGateProps {
  children: ReactNode
  onAuthenticated?: (user: StudioUser) => void
  onLogout?: () => void
}

export function AuthGate({ children, onAuthenticated, onLogout }: AuthGateProps) {
  const user = useStore($currentUser)
  const notice = useStore($authenticationNotice)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [companyEnabled, setCompanyEnabled] = useState(false)
  const [developerLogin, setDeveloperLogin] = useState(false)
  const [switchCompany, setSwitchCompany] = useState(() => consumeCompanySwitchIntent())
  const previous = useRef<string | null>(null)
  const notify = useEffectEvent((current: StudioUser | null) => {
    if (current) onAuthenticated?.(current)
    else onLogout?.()
  })
  useEffect(() => {
    let mounted = true
    let generation = 0
    const initialize = () => {
      const current = ++generation
      const params = new URLSearchParams(window.location.hash.slice(1))
      const launch = params.get('launch'), ticket = params.get('ticket'), state = params.get('state')
      setLoading(true); setError('')
      if (launch || ticket) {
        clearAuthentication()
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }
      const request = launch ? launchCompanyLogin(launch) : ticket ? completeCompanyLogin(ticket, state || '') : loadCurrentUser()
      void request.catch(reason => { if (mounted && current === generation) setError(reason instanceof Error ? reason.message : '账号信息读取失败。') })
        .finally(() => { if (mounted && current === generation) setLoading(false) })
    }
    void loginOptions().then(options => { if (mounted) setCompanyEnabled(options.company) }).catch(() => {})
    initialize()
    window.addEventListener('hashchange', initialize)
    return () => { mounted = false; generation += 1; window.removeEventListener('hashchange', initialize) }
  }, [])
  useEffect(() => {
    const requestSwitch = () => setSwitchCompany(true)
    window.addEventListener('studio:company-switch', requestSwitch)
    return () => window.removeEventListener('studio:company-switch', requestSwitch)
  }, [])
  useEffect(() => {
    window.addEventListener('studio:auth-expired', expireAuthentication)
    return () => window.removeEventListener('studio:auth-expired', expireAuthentication)
  }, [])
  useEffect(() => {
    const authenticated = user?.activation_required ? null : user
    if (loading || previous.current === (authenticated?.id ?? null)) return
    previous.current = authenticated?.id ?? null
    notify(authenticated)
  }, [loading, user?.id, user?.activation_required])
  if (loading) return <main className="studio-login account-loading"><Brand /><p role="status"><LoaderCircle className="account-spin" size={17} />正在打开工作区…</p></main>
  if (user?.activation_required && user.auth_source === 'company') return <CompanyActivation user={user} />
  if (user) return <>{children}</>
  if (companyEnabled && !developerLogin) return <CompanyLoginLanding initialError={error} switchAccount={switchCompany} onStart={startCompanyLogin} onDeveloperLogin={() => setDeveloperLogin(true)} />
  return <LoginForm initialError={error} notice={notice} companyEnabled={false} onBack={companyEnabled ? () => setDeveloperLogin(false) : undefined} />
}

export function CompanyLoginLanding({ initialError = '', switchAccount = false, onStart = startCompanyLogin, onDeveloperLogin }: {
  initialError?: string
  switchAccount?: boolean
  onStart?: (switchAccount?: boolean) => Promise<unknown>
  onDeveloperLogin: () => void
}) {
  const [error, setError] = useState(initialError)
  const start = () => { setError(''); void onStart(switchAccount).catch(reason => setError(reason instanceof Error ? reason.message : '公司登录暂不可用。')) }
  return <main className="studio-login company-login-landing">
    <header className="login-brand"><Brand subtitle="剧本创作工作区" /></header>
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-icon" aria-hidden="true"><img src="/jubao-mark.png" alt="" /><img className="login-icon-dark" src={markDark} alt="" /></div>
      <h1 id="login-title">欢迎回来</h1><div className="login-environment"></div>
      <p className="login-description" role="status">登录巨豹智能体</p>
      <FormNotice error={error} />
      <button type="button" className="primary-button login-submit" onClick={start}>{error ? '重新登录' : '登录'}</button>
      <button type="button" className="developer-login-link" onClick={onDeveloperLogin}>开发人员登录</button>
    </section>
    <footer className="login-footer">从第一份原稿，到值得交付的每一幕。</footer>
  </main>
}

function LoginForm({ initialError, notice, companyEnabled, onBack }: { initialError: string; notice: string; companyEnabled: boolean; onBack?: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [activationCode, setActivationCode] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { await login(username.trim(), password, activationCode) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败，请重试。'); setBusy(false) }
  }
  return <main className="studio-login">
    <LoginBackdrop />
    <header className="login-brand"><Brand subtitle="剧本创作工作区" /></header>
    <section className="login-card" aria-labelledby="login-title">
      {onBack && <button type="button" className="developer-back-button" aria-label="返回公司登录" title="返回公司登录" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /></button>}
      <div className="login-icon" aria-hidden="true"><img src="/jubao-mark.png" alt="" /><img className="login-icon-dark" src={markDark} alt="" /></div>
      <h1 id="login-title">欢迎回来</h1><div className="login-environment"></div>
      <p className="login-description">登录巨豹智能体，继续你的创作。</p>
      {companyEnabled && <div className="login-company-login"><button type="button" className="primary-button login-submit" disabled={busy} onClick={() => {
        setBusy(true); setError('')
        void startCompanyLogin().catch(reason => { setError(reason instanceof Error ? reason.message : '公司登录暂不可用。'); setBusy(false) })
      }}>公司账号登录<ArrowRight size={17} aria-hidden="true" /></button></div>}
      <form onSubmit={event => void submit(event)} className="account-form">
        <label className="account-field"><span>账号</span><input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" enterKeyHint="next" spellCheck={false} value={username} disabled={busy} required maxLength={64} placeholder="请输入账号" onChange={event => setUsername(event.target.value)} /></label>
        <PasswordField label="密码" name="password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" enterKeyHint="next" spellCheck={false} value={password} disabled={busy} required placeholder="请输入密码" onChange={event => setPassword(event.target.value)} />
        <div className="account-field"><label htmlFor="activation-code">绑定机器 ID</label><input id="activation-code" name="activation_code" autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" enterKeyHint="go" spellCheck={false} value={activationCode} disabled={busy} maxLength={100} placeholder="首次登录时填写" onChange={event => setActivationCode(event.target.value)} /></div>
        <FormNotice error={error || notice} />
        <button className="primary-button login-submit" type="submit" disabled={busy} aria-busy={busy}>{busy ? <><LoaderCircle size={17} className="account-spin" aria-hidden="true" />正在登录…</> : <>登录<ArrowRight size={17} aria-hidden="true" /></>}</button>
      </form>
      <div className="login-hint">没有账号？请联系管理员开通。</div>
    </section>
    <footer className="login-footer">从第一份原稿，到值得交付的每一幕。</footer>
  </main>
}

function CompanyActivation({ user }: { user: StudioUser }) {
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { await activateCompanyAccount(code.trim()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '激活未完成，请重试。') }
    finally { setBusy(false) }
  }
  return <main className="studio-login"><header className="login-brand"><Brand subtitle="剧本创作工作区" /></header>
    <section className="login-card"><h1>开通创作工作区</h1><p>{user.display_name}，公司身份已验证，请完成首次激活。</p>
      <form className="account-form" onSubmit={event => void submit(event)}><label className="account-field"><span>绑定机器 ID</span><input value={code} required maxLength={100} autoComplete="one-time-code" disabled={busy} onChange={event => setCode(event.target.value)} /></label>
        <FormNotice error={error} /><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在激活…' : '激活并进入'}</button>
      </form><button type="button" className="secondary-button" disabled={busy} onClick={() => { void logout({ switchCompany: true }).catch(() => setError('切换未完成，请重试。')) }}>切换公司账号</button>
    </section></main>
}
