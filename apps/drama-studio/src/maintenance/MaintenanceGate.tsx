import { useStore } from '@nanostores/react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { $authenticationNotice, $currentUser, clearAuthentication, type StudioUser } from '../accounts/api'
import { $selectedSidebarProjectId } from '../lib/sidebar'
import { workspace } from '../store/workspace'
import { captureMaintenanceDraft, discardMaintenanceDraft, hasMaintenanceDrafts, matchesMaintenanceDraft, readMaintenanceDraft, restoreMaintenanceDraft, type DraftCaptureStatus, type MaintenanceDraft } from './drafts'
import './maintenance.css'

interface MaintenanceState {
  id: string
  phase: 'inactive' | 'announced' | 'paused'
  version: string
  message: string
  deadline: string | null
}
interface MaintenanceGateProps { children: ReactNode }
const inactive: MaintenanceState = { id: '', phase: 'inactive', version: '', message: '', deadline: null }
const maintenanceNotice = '系统维护中，结束后请重新登录。'
const hasDraft = () => {
  const draft = workspace.composer.get()
  return Boolean(draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length)
}

function publicState(value: unknown): MaintenanceState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as MaintenanceState
  if (!['inactive', 'announced', 'paused'].includes(row.phase) || typeof row.id !== 'string' || row.id.length > 128
    || typeof row.version !== 'string' || row.version.length > 80 || typeof row.message !== 'string' || row.message.length > 4000
    || !(row.deadline === null || typeof row.deadline === 'string' && Number.isFinite(Date.parse(row.deadline)))) return null
  return { id: row.id, phase: row.phase, version: row.version, message: row.message, deadline: row.deadline }
}

function remaining(deadline: string | null, now: number) {
  if (!deadline) return ''
  const seconds = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000))
  return seconds ? `距离维护还有 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : '正在等待维护操作，请暂时不要提交新内容。'
}

export function MaintenanceGate({ children }: MaintenanceGateProps) {
  const user = useStore($currentUser), connection = useStore(workspace.connection)
  const selectedProject = useStore($selectedSidebarProjectId)
  const composer = useStore(workspace.composer)
  const draftVersion = useStore(workspace.draftChanges)
  const session = useStore(workspace.session), startup = useStore(workspace.startup), navigation = useStore(workspace.navigation)
  const [state, setState] = useState(inactive), [now, setNow] = useState(Date.now)
  const [draftStatus, setDraftStatus] = useState<DraftCaptureStatus | 'none'>('none'), [recovery, setRecovery] = useState<MaintenanceDraft | null>(null)
  const [restored, setRestored] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const latest = useRef(state), dialog = useRef<HTMLDialogElement>(null)
  const currentDraftStatusRef = useRef<DraftCaptureStatus | 'none'>('none')
  const captureOwner = useRef('')
  const clearedAccounts = useRef({ id: null as string | null, accounts: new Set<string>() })
  const titleId = useId(), descriptionId = useId()
  latest.current = state
  const active = state.phase !== 'inactive'
  const currentDraftStatus = user && captureOwner.current !== JSON.stringify([user.id, user.profile]) ? 'none' : draftStatus
  currentDraftStatusRef.current = currentDraftStatus
  const draftNotice = currentDraftStatus === 'memory' ? '草稿已暂存在当前页面，请保留页面，维护后重新登录恢复。'
    : currentDraftStatus === 'unconfirmed' ? '当前草稿保存状态尚未确认，系统正在核对。请保留页面。' : ''
  const currentInput = Boolean(composer.busy || composer.text.trim() || composer.attachments.length || composer.capabilityCommands?.length)
  const dialogVisible = active
  const saveDraft = (current: StudioUser) => {
    captureOwner.current = JSON.stringify([current.id, current.profile])
    setDraftStatus(captureMaintenanceDraft(current))
  }
  const clearForMaintenance = (next: MaintenanceState) => {
    const cycle = clearedAccounts.current
    if (next.phase === 'inactive') {
      cycle.id = null; cycle.accounts.clear()
      if (!$currentUser.get() && $authenticationNotice.get() === maintenanceNotice) {
        $authenticationNotice.set('维护已结束，请重新登录后继续。')
      }
      return
    }
    if (cycle.id !== next.id) { cycle.id = next.id; cycle.accounts.clear() }
    const current = $currentUser.get()
    if (!current) return
    const key = JSON.stringify([current.id, current.profile])
    if (cycle.accounts.has(key)) return
    // WS 可能已经断开，先同步保留原账号草稿，再让 AuthGate 回到登录页。
    saveDraft(current)
    cycle.accounts.add(key)
    clearAuthentication(maintenanceNotice)
  }

  useEffect(() => {
    let accountEpoch = workspace.accountEpoch
    const capture = (force = false, clearEmpty = false) => {
      const current = $currentUser.get()
      if (current && (clearEmpty || hasDraft()) && (force || latest.current.phase !== 'inactive' || hasMaintenanceDrafts(current))) saveDraft(current)
    }
    const beforeLogout = () => capture(true, true)
    const stopComposer = workspace.composer.listen(() => {
      // 登录切换的 reset 清空画面，不代表用户放弃维护前的草稿。
      if (accountEpoch !== workspace.accountEpoch) { accountEpoch = workspace.accountEpoch; return }
      capture(false, true)
    })
    const stopDrafts = workspace.draftChanges.listen(() => capture(false, true))
    window.addEventListener('studio:auth-clearing', beforeLogout)
    return () => { stopComposer(); stopDrafts(); window.removeEventListener('studio:auth-clearing', beforeLogout) }
  }, [])

  useEffect(() => {
    let disposed = false, pending = false
    let controller: AbortController | undefined
    const refresh = async () => {
      if (pending || disposed) return
      pending = true; controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 4000)
      try {
        const response = await fetch('/studio/maintenance', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        const next = response.ok && publicState(await response.json())
        if (!next || disposed) return
        const previous = latest.current
        clearForMaintenance(next)
        if (previous.phase !== 'inactive' && next.phase === 'inactive' && previous.id) {
          const current = $currentUser.get()
          const key = `drama-studio:maintenance-refresh:${previous.id}`
          let already = false
          try { already = sessionStorage.getItem(key) === 'done' } catch { /* 存储不可用时保留页面 */ }
          const draft = workspace.composer.get()
          const safeToRefresh = !current || currentDraftStatusRef.current === 'saved' || (!draft.text.trim() && !draft.attachments.length && !draft.capabilityCommands?.length && !hasMaintenanceDrafts(current))
          if (!already && safeToRefresh) {
            try { sessionStorage.setItem(key, 'done') } catch { /* 仍允许本次刷新 */ }
            latest.current = next
            setState(next)
            window.location.reload()
            return
          }
          if (!already) setRefreshRequired(true)
        }
        latest.current = next
        setState(next); setNow(Date.now())
      } catch { /* 断网或状态不可解析时保留最近状态，不自行解除维护。 */ }
      finally { clearTimeout(timeout); pending = false }
    }
    const wake = () => { if (document.visibilityState !== 'hidden') void refresh() }
    void refresh()
    const poll = setInterval(() => { void refresh() }, 5000)
    window.addEventListener('focus', wake); window.addEventListener('online', wake)
    window.addEventListener('studio:reconnected', wake); document.addEventListener('visibilitychange', wake)
    return () => {
      disposed = true; controller?.abort(); clearInterval(poll)
      window.removeEventListener('focus', wake); window.removeEventListener('online', wake)
      window.removeEventListener('studio:reconnected', wake); document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  useEffect(() => {
    if (active) clearForMaintenance(state)
  }, [active, state.id, user?.id, user?.profile])

  useEffect(() => {
    if (!active || !state.deadline) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, state.deadline])

  useEffect(() => { setRestored(false) }, [user?.id, user?.profile])

  useEffect(() => {
    if (!user || active || connection !== 'open' || startup.history || startup.models || navigation.loading) { setRecovery(null); return }
    const saved = readMaintenanceDraft(user)
    const draft = workspace.composer.get()
    if (saved && !saved.submitting && matchesMaintenanceDraft(saved) && !draft.text.trim() && !draft.attachments.length && !draft.capabilityCommands?.length
      && restoreMaintenanceDraft(user)) { setRecovery(null); setRestored(true) }
    else setRecovery(saved)
  }, [user?.id, user?.profile, active, connection, startup.history, startup.models, navigation.loading, session.storedId, selectedProject, draftVersion])

  useEffect(() => {
    if (!dialogVisible) return
    const previous = document.activeElement, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; dialog.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [dialogVisible, state.phase])

  const restore = () => { if (user && restoreMaintenanceDraft(user)) { setRecovery(null); setRestored(true) } }
  // 原对话已不需要或找不到时，员工可以直接丢弃，提示不再常驻。
  const discard = () => { if (user && recovery && discardMaintenanceDraft(user, recovery)) setRecovery(null) }
  const title = state.phase === 'paused' ? '系统维护中' : '维护通知'
  return <>
    <div className="maintenance-content" inert={dialogVisible}>{children}</div>
    {refreshRequired && <div className="maintenance-recovery maintenance-refresh-required" role="status">
      <span>维护已结束。当前草稿尚未确认保存，请先备份后刷新页面。</span>
      <button type="button" className="text-button" onClick={() => window.location.reload()}>刷新页面</button>
    </div>}
    {!active && user && (recovery || restored) && <div className="maintenance-recovery" role="status">
      <span>{recovery ? currentInput ? '维护前草稿已保留；请先处理当前输入或等待操作完成，再恢复。' : recovery.submitting ? '维护前的提交结果需核对，草稿已保留。' : '维护前草稿已保留，请在原对话中恢复。' : '维护前的草稿已恢复，尚未发送。'}</span>
      {recovery && <button type="button" className="text-button" disabled={currentInput || !matchesMaintenanceDraft(recovery) || connection !== 'open'} title={currentInput ? '当前有新输入或操作未完成，暂不覆盖。' : !matchesMaintenanceDraft(recovery) ? '请先回到维护前的对话或项目。' : undefined} onClick={restore}>恢复草稿</button>}
      {recovery && <button type="button" className="text-button" title="删除这份维护前保留的草稿，提示不再出现" onClick={discard}>丢弃草稿</button>}
      {restored && !recovery && <button type="button" className="text-button" onClick={() => setRestored(false)}>知道了</button>}
    </div>}
    {dialogVisible && <div className="maintenance-layer"><dialog open ref={dialog} tabIndex={-1} className="maintenance-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape') event.preventDefault()
        if (event.key === 'Tab') {
          const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]') || [])]
          const first = controls[0], last = controls.at(-1)
          if (!first) { event.preventDefault(); dialog.current?.focus() }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
      <div className="maintenance-kicker">巨豹智能体{state.version ? ` · ${state.version}` : ''}</div>
      <h1 id={titleId}>{title}</h1>
      <p id={descriptionId}>{state.message || '系统维护中，维护结束后可重新登录。'}</p>
      {active && state.deadline && <p className="maintenance-countdown">{state.phase === 'announced' ? remaining(state.deadline, now) : '维护完成后会自动更新此提示。'}</p>}
      <p className="maintenance-draft-note">已保存的聊天和稿件保留。未发送草稿仅在原账号恢复，不会自动发送或继续任务。</p>
      {draftNotice && <p className="maintenance-warning" role="alert">{draftNotice}</p>}
      <div className="maintenance-actions">
        <p>维护结束前暂不可登录，此页面会自动检查维护状态。</p>
      </div>
    </dialog></div>}
  </>
}
