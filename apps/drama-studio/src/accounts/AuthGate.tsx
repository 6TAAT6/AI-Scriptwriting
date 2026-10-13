import { useStore } from '@nanostores/react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Brand } from '../components/Brand'
import { $authenticationNotice, $currentUser, expireAuthentication, loadCurrentUser, login, type StudioUser } from './api'
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
  const previous = useRef<string | null>(null)
  const notify = useEffectEvent((current: StudioUser | null) => {
    if (current) onAuthenticated?.(current)
    else onLogout?.()
  })
  useEffect(() => {
    let mounted = true
    void loadCurrentUser().catch(reason => { if (mounted) setError(reason instanceof Error ? reason.message : '账号信息读取失败。') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])
  useEffect(() => {
    window.addEventListener('studio:auth-expired', expireAuthentication)
    return () => window.removeEventListener('studio:auth-expired', expireAuthentication)
  }, [])
  useEffect(() => {
    if (loading || previous.current === (user?.id ?? null)) return
    previous.current = user?.id ?? null
    notify(user)
  }, [loading, user?.id])
  if (loading) return <main className="studio-login account-loading"><Brand /><p role="status"><LoaderCircle className="account-spin" size={17} />正在打开工作区…</p></main>
  if (user) return <>{children}</>
  return <LoginForm initialError={error} notice={notice} />
}

function LoginForm({ initialError, notice }: { initialError: string; notice: string }) {
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
      <div className="login-icon" aria-hidden="true"><img src="/jubao-mark.png" alt="" /></div>
      <h1 id="login-title">欢迎回来</h1>
      <p className="login-description">登录巨豹智能体，继续你的创作。</p>
      <form onSubmit={event => void submit(event)} className="account-form">
        <label className="account-field"><span>账号</span><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} disabled={busy} required maxLength={64} placeholder="请输入账号" onChange={event => setUsername(event.target.value)} /></label>
        <PasswordField label="密码" name="password" autoComplete="current-password" value={password} disabled={busy} required placeholder="请输入密码" onChange={event => setPassword(event.target.value)} />
        <div className="account-field"><label htmlFor="activation-code">绑定机器 ID</label><input id="activation-code" name="activation_code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={activationCode} disabled={busy} maxLength={100} placeholder="首次登录时填写" onChange={event => setActivationCode(event.target.value)} /></div>
        <FormNotice error={error || notice} />
        <button className="primary-button login-submit" type="submit" disabled={busy} aria-busy={busy}>{busy ? <><LoaderCircle size={17} className="account-spin" aria-hidden="true" />正在登录…</> : <>登录<ArrowRight size={17} aria-hidden="true" /></>}</button>
      </form>
      <div className="login-hint">没有账号？请联系管理员开通。</div>
    </section>
    <footer className="login-footer">从第一份原稿，到值得交付的每一幕。</footer>
  </main>
}
