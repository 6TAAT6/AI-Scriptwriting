import { useStore } from '@nanostores/react'
import { ChevronLeft, Download, File, FileText, FolderOpen, Layers3, LoaderCircle, PanelRightClose, RefreshCw } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { gateway } from '../lib/gateway'
import { type Artifact } from '../lib/creative'
import { workspace } from '../store/workspace'
import { DocumentReader } from './DocumentReader'
import { SourceImage } from './SourceImage'
import { isImageFile } from '../../shared/attachments.mjs'
import { saveBlob } from '../lib/download'
import './Inspector.css'

interface InspectorProps { selected: Artifact | null; onSelect: (artifact: Artifact | null) => void; onClose: () => void }

export function Inspector({ selected, onSelect, onClose }: InspectorProps) {
  const project = useStore(workspace.project)
  const session = useStore(workspace.session)
  const composer = useStore(workspace.composer)
  const sources = useStore(workspace.sources)
  const materialError = useStore(workspace.materialError)
  const [tab, setTab] = useState('files')
  const [switchedTab, setSwitchedTab] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const tabId = useId()
  const [loaded, setLoaded] = useState('')
  const [error, setError] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  // App 只保留打开面板时的快照；项目回执刷新后，用同一 id 的最新 artifact
  // 补齐 Word 路径和状态，避免用户需要关闭再重新打开稿件。
  const activeSelected = useMemo(() => {
    if (!selected) return null
    const latest = project?.artifacts.find(artifact => artifact.id === selected.id)
    return latest ? { ...selected, ...latest } : selected
  }, [project, selected])
  useEffect(() => {
    let cancelled = false
    setLoaded(''); setError(''); setPreviewBusy(false); setTruncated(false)
    if (activeSelected?.content || !activeSelected?.path || !/\.(md|txt|csv|docx|xlsx)$/i.test(activeSelected.path)) return
    setPreviewBusy(true)
    const extension = activeSelected.path.split('.').pop()?.toLowerCase()
    const office = extension === 'docx' || extension === 'xlsx'
    void gateway.file(activeSelected.path, session.storedId, !office).then(async response => {
      if (!office) return response.json()
      const { readOfficeResponse } = await import('../lib/office-preview')
      return { text: await readOfficeResponse(response, extension), binary: false, truncated: false }
    }).then(data => {
      if (!cancelled) { setLoaded(data.binary ? '' : String(data.text ?? '')); setTruncated(Boolean(data.truncated)) }
    }).catch(() => { if (!cancelled) setError('文件预览暂时不可用，仍可尝试下载。') }).finally(() => { if (!cancelled) setPreviewBusy(false) })
    return () => { cancelled = true }
  }, [activeSelected, session.storedId])
  const download = async () => {
    if (!activeSelected) return
    const accountEpoch = workspace.accountEpoch, sessionId = session.storedId
    setDownloading(true); setError('')
    try {
      const path = activeSelected.downloadPath || activeSelected.path
      const name = activeSelected.downloadName || activeSelected.name
      if (path && !session.storedId) throw new Error('当前会话尚未准备好下载，请稍后重试。')
      const blob = path ? await (await gateway.file(path, sessionId)).blob() : new Blob([activeSelected.content || ''], { type: 'text/markdown;charset=utf-8' })
      if (path && (workspace.accountEpoch !== accountEpoch || workspace.session.get().storedId !== sessionId)) return
      await saveBlob(blob, path ? name : `${name}.md`)
    } catch (error) {
      if (workspace.accountEpoch === accountEpoch && workspace.session.get().storedId === sessionId) setError(error instanceof Error ? error.message : '文件下载失败。')
    }
    finally { setDownloading(false) }
  }
  const refresh = async () => {
    setRefreshing(true)
    try { await workspace.loadMaterials() }
    finally { setRefreshing(false) }
  }
  const allFiles: Artifact[] = [...(project?.artifacts ?? []), ...sources, ...composer.attachments.map(file => ({ id: file.path, name: file.name, path: file.path, kind: 'source' as const }))]
  const linkedExports = new Set(allFiles.filter(file => file.kind !== 'document' && file.downloadPath).map(file => file.downloadPath))
  const files = [...new Map(allFiles.filter(file => file.kind !== 'document' || !linkedExports.has(file.path)).map(file => [file.path || file.id, file])).values()]
  const selectedFormat = activeSelected?.downloadFormat || activeSelected?.path?.split('.').pop() || ''
  const selectedWord = selectedFormat.toLowerCase() === 'docx'
  const canDownload = Boolean(activeSelected?.downloadPath || activeSelected?.path || activeSelected?.content)
  const downloadLabel = selectedWord ? '下载 Word' : activeSelected?.path ? '下载当前稿件' : '下载源稿'
  return <aside className={`inspector ${activeSelected ? 'reading' : ''}`} aria-label="稿件与创作资料">
    <div className="inspector-header"><div><FileText size={16} /><strong>{activeSelected ? '稿件预览' : '创作资料'}</strong></div><button className="icon-button" aria-label="收起稿件面板" onClick={onClose}><PanelRightClose size={16} /></button></div>
    {activeSelected ? <>
      <div className="document-toolbar"><button className="text-button" onClick={() => onSelect(null)}><ChevronLeft size={14} />返回资料</button><span className="inspector-action-tooltip" data-tooltip={downloading ? '正在下载…' : downloadLabel}><button className="icon-button" disabled={downloading || !canDownload} aria-label={downloadLabel} onClick={() => void download()}><Download size={16} /></button></span></div>
      <div key={activeSelected.id} className="document-preview" aria-busy={previewBusy || downloading}><span className="document-type">{selectedFormat.toUpperCase() || '创作稿件'}</span>{activeSelected.downloadStatus && <span className="document-status">{activeSelected.downloadStatus === 'accepted' ? '已验收' : activeSelected.downloadStatus === 'reviewed' ? '已审核' : '草稿'}</span>}<h2>{activeSelected.name}</h2>
        {activeSelected.path && isImageFile(activeSelected.path) ? <SourceImage path={activeSelected.path} name={activeSelected.name} /> : previewBusy ? <div className="document-loading" role="status"><LoaderCircle size={18} className="spin" /><span>正在准备稿件…</span><div className="document-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></div> : activeSelected.content || loaded ? <DocumentReader text={activeSelected.content || loaded} /> : <div className="document-empty"><FileText size={36} /><p>文件已保存到工作区</p><button className="secondary-button" disabled={downloading || !canDownload} onClick={() => void download()}><Download size={14} />{downloadLabel}</button></div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {truncated && <p role="status">预览仅显示部分内容，请下载当前稿件查看全文。</p>}
      </div>
    </> : <>
      <div className="inspector-tabs" role="tablist" aria-label="资料视图"><button role="tab" id={`${tabId}-files`} aria-controls={`${tabId}-files-panel`} aria-selected={tab === 'files'} onClick={() => { setSwitchedTab(true); setTab('files') }}><FolderOpen size={14} />文件</button></div>
      <div className={`inspector-panels ${switchedTab ? 'has-switched' : ''}`}>
        <div id={`${tabId}-files-panel`} className="inspector-body" role="tabpanel" aria-labelledby={`${tabId}-files`} hidden={tab !== 'files'} inert={tab !== 'files'} aria-hidden={tab !== 'files'}>
          <div className="file-section-title">原稿与成果<span>{files.length}</span><span className="inspector-action-tooltip" data-tooltip={!session.storedId ? '连接创作服务后才能刷新资料。' : refreshing ? '正在刷新创作资料…' : '刷新创作资料'}><button className="icon-button" disabled={!session.storedId || refreshing} aria-label="刷新创作资料" aria-busy={refreshing} onClick={() => void refresh()}><RefreshCw size={13} className={refreshing ? 'spin' : undefined} /></button></span></div>
          {materialError && <p className="inline-error" role="alert">{materialError}</p>}
          {files.length ? files.map(file => <button key={file.id} className="file-row" onClick={() => onSelect(file)}><span className={`file-icon ${file.kind}`}><FileText size={17} /></span><span><strong>{file.name}</strong><small>{file.kind === 'source' ? '原始资料' : file.kind === 'document' ? '已导出文件' : file.downloadPath ? `阶段稿件 · 可下载 ${file.downloadFormat?.toUpperCase() || '文件'}` : '阶段稿件'}</small></span></button>) :
            <div className="files-empty"><span className="empty-file-icon"><File size={25} /></span><h3>故事的每一稿，都在这里</h3><p>上传的原稿、分析和成稿<br />会随创作逐步整理到这里。</p><span className="supported-files">TXT · DOCX · XLSX · MD</span></div>}
          <div className="inspector-note"><Layers3 size={16} /><div><strong>与对话一起推进</strong><p>从回复中的「在稿件面板阅读」打开正文，一边沟通，一边看稿。</p></div></div>
        </div>
      </div>
      <div className="inspector-footer"><span className="status-dot" />{project ? '已载入项目记录' : '准备好，就开始写吧'}</div>
    </>}
  </aside>
}
