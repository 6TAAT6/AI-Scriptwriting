import { randomId } from '../lib/id'
import { FolderOpen, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'

interface CreateProjectDialogProps {
  busy: boolean
  error: string
  onClose: () => void
  onCreate: (name: string, requestId: string) => Promise<boolean>
}

export function CreateProjectDialog({ busy, error, onClose, onCreate }: CreateProjectDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)
  const [name, setName] = useState('')
  const [requestId, setRequestId] = useState(() => randomId())
  const titleId = useId()
  const errorId = useId()
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    input.current?.focus()
    return () => { if (trigger?.isConnected) trigger.focus() }
  }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || submitting.current || !name.trim()) return
    submitting.current = true
    try { if (await onCreate(name.trim(), requestId)) onClose() }
    finally { submitting.current = false }
  }
  return createPortal(<dialog ref={dialog} className="sidebar-dialog create-project-dialog" aria-labelledby={titleId}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
    onClose={onClose} onClick={event => { if (!busy && event.target === dialog.current) onClose() }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id={titleId}>创建项目</h2><button type="button" className="icon-button" aria-label="关闭创建项目" disabled={busy} onClick={onClose}><X size={17} /></button></header>
      <label className="create-project-name"><FolderOpen size={17} aria-hidden="true" /><input ref={input} aria-label="项目名称" aria-describedby={error ? errorId : undefined} placeholder="项目名称" required maxLength={80} autoComplete="off" value={name} disabled={busy} onChange={event => { setName(event.target.value); setRequestId(randomId()) }} /></label>
      {error && <p id={errorId} className="sidebar-action-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? '正在创建…' : '创建项目'}</button></footer>
    </form>
  </dialog>, document.body)
}
