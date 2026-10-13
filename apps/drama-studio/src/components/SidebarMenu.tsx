import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface MenuAction { label: string; icon: ReactNode; run: () => void; danger?: boolean; divider?: boolean; disabled?: boolean }
export interface MenuAnchor { x: number; y: number; trigger: HTMLElement }
interface SidebarMenuProps { anchor: MenuAnchor; label: string; actions: MenuAction[]; onClose: () => void }
export function SidebarMenu({ anchor, label, actions, onClose }: SidebarMenuProps) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({ left: anchor.x, top: anchor.y, visibility: 'hidden' })
  useLayoutEffect(() => {
    const box = panel.current!.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(anchor.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(anchor.y, window.innerHeight - box.height - 8)) })
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [anchor])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose() }
    const close = () => onClose()
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close); window.addEventListener('scroll', close, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true) }
  }, [onClose])
  return createPortal(<div ref={panel} role="menu" aria-label={label} className="sidebar-context-menu" style={position} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); anchor.trigger.focus(); return }
    if (event.key === 'Tab') { onClose(); anchor.trigger.focus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }}>
    {actions.map(action => <div key={action.label} className={action.divider ? 'sidebar-menu-divider' : undefined}><button role="menuitem" className={action.danger ? 'is-danger' : undefined} disabled={action.disabled} onClick={() => { onClose(); anchor.trigger.focus(); action.run() }}>{action.icon}<span>{action.label}</span></button></div>)}
  </div>, document.body)
}

interface SidebarDialogProps { title: string; initialName?: string; description: string; submitLabel: string; busy: boolean; error: string; danger?: boolean; disabled?: boolean; busyLabel?: string; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }
export function SidebarDialog({ title, initialName, description, submitLabel, busy, error, danger = false, disabled = false, busyLabel = '正在保存…', onClose, onSubmit }: SidebarDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [name, setName] = useState(initialName || '')
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal(); input.current?.select(); if (danger) cancel.current?.focus()
    return () => { if (trigger?.isConnected) trigger.focus() }
  }, [])
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!busy && !disabled && await onSubmit(name.trim())) onClose() }
  return createPortal(<dialog ref={dialog} className="sidebar-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={event => event.stopPropagation()} onClose={onClose} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }} onClick={event => { if (!busy && event.target === dialog.current) onClose() }}>
    <form onSubmit={event => void submit(event)}><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={17} /></button></header><p id={descriptionId}>{description}</p>
      {initialName !== undefined && <label>名称<input ref={input} aria-label="名称" value={name} autoFocus required maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} /></label>}
      {error && <p className="sidebar-action-error" role="alert">{error}</p>}
      <footer><button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className={`primary-button${danger ? ' is-danger' : ''}`} disabled={busy || disabled || initialName !== undefined && !name.trim()}>{busy ? busyLabel : submitLabel}</button></footer>
    </form>
  </dialog>, document.body)
}

interface DeleteChatDialogProps { title: string; busy: boolean; blocked: boolean; error: string; onClose: () => void; onDelete: () => Promise<boolean> }
export function DeleteChatDialog({ title, busy, blocked, error, onClose, onDelete }: DeleteChatDialogProps) {
  return <SidebarDialog title="删除聊天" description={`确定永久删除“${title}”及其消息记录？删除后不可恢复。已上传的原稿、项目稿件和导出文件会保留。`}
    submitLabel="永久删除" busyLabel="正在删除…" danger disabled={blocked} busy={busy}
    error={blocked ? '这段聊天正在创作中，请停止后再删除。' : error} onClose={onClose} onSubmit={onDelete} />
}
