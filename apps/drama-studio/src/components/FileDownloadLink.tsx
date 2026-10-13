import { Download, FileText } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { gateway } from '../lib/gateway'
import { saveBlob } from '../lib/download'
import { workspace } from '../store/workspace'

interface FileDownloadLinkProps {
  path: string
  children: ReactNode
  title?: string
  downloadName?: string
  onRead?: (file: { path: string; name: string }) => void
}

export function FileDownloadLink({ path, children, title, downloadName, onRead }: FileDownloadLinkProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const download = async () => {
    if (busy) return
    const epoch = workspace.accountEpoch, sessionId = workspace.session.get().storedId
    setBusy(true); setError(false)
    try {
      const blob = await (await gateway.file(path, sessionId)).blob()
      if (workspace.accountEpoch !== epoch || workspace.session.get().storedId !== sessionId) return
      await saveBlob(blob, downloadName || path.slice(path.lastIndexOf('/') + 1))
    } catch {
      if (workspace.accountEpoch === epoch && workspace.session.get().storedId === sessionId) setError(true)
    } finally { setBusy(false) }
  }
  const name = typeof children === 'string' ? children : path.slice(path.lastIndexOf('/') + 1)
  const format = path.split('.').pop()?.toLowerCase()
  const downloadLabel = format === 'docx' ? '下载 Word' : format === 'xlsx' ? '下载 Excel' : '下载文件'
  return <span className={`document-link${onRead ? ' document-link-with-actions' : ''}`}>
    {onRead ? <span className="document-reference" title={title}>{children}</span> : <button type="button" className="text-button document-reference" title={title} disabled={busy} aria-busy={busy} onClick={() => void download()}>{children}</button>}
    {onRead && <span className="document-link-actions" role="group" aria-label={`${name}文件操作`}>
      <span className="document-link-tooltip" data-tooltip="在稿件面板阅读"><button type="button" className="icon-button" aria-label={`在稿件面板阅读：${name}`} onClick={() => onRead({ path, name })}><FileText size={14} /></button></span>
      <span className="document-link-tooltip" data-tooltip={`${downloadLabel}：${name}`}><button type="button" className="icon-button" disabled={busy} aria-busy={busy} aria-label={`${downloadLabel}：${name}`} onClick={() => void download()}><Download size={14} /></button></span>
    </span>}
    {error && <span className="inline-error" role="alert">文件下载失败，请重试。</span>}
  </span>
}
