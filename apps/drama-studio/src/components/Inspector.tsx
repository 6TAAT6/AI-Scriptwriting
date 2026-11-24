import { useStore } from '@nanostores/react'
import { BookOpen, ChevronLeft, Download, FileText, LoaderCircle, PanelRightClose, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { gateway } from '../lib/gateway'
import { type Artifact } from '../lib/creative'
import { workspace } from '../store/workspace'
import { DocumentReader } from './DocumentReader'
import { SourceImage } from './SourceImage'
import { isDocumentFile, isImageFile } from '../../shared/attachments.mjs'
import { saveBlob } from '../lib/download'
import { documentVersion } from '../lib/document-names'
import { latestDocumentVersions } from '../lib/document-versions'
import './Inspector.css'

/** 稿件只展示版本与下载信息，修改内容由正文中的说明呈现。 */
function versionLabel(file: Artifact): string {
  const version = documentVersion(file.downloadName) ?? file.versions ?? 1
  return version > 1 ? ` · 第 ${version} 版（最新）` : ''
}

interface InspectorProps { selected: Artifact | null; onSelect: (artifact: Artifact | null) => void; onClose: () => void }

export function Inspector({ selected, onSelect, onClose }: InspectorProps) {
  const project = useStore(workspace.project)
  const session = useStore(workspace.session)
  const composer = useStore(workspace.composer)
  const sources = useStore(workspace.sources)
  const materialError = useStore(workspace.materialError)
  const [refreshing, setRefreshing] = useState(false)
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
    if (activeSelected?.content || !activeSelected?.path || !isDocumentFile(activeSelected.path) || /\.(xls|pdf)$/i.test(activeSelected.path)) return
    setPreviewBusy(true)
    const extension = activeSelected.path.split('.').pop()?.toLowerCase()
    const office = extension === 'docx' || extension === 'xlsx' || extension === 'xlsm'
    void gateway.file(activeSelected.path, session.storedId, !office).then(async response => {
      if (!office) return response.json()
      const { readOfficeResponse } = await import('../lib/office-preview')
      return { text: await readOfficeResponse(response, extension === 'docx' ? 'docx' : 'xlsx'), binary: false, truncated: false }
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
  // 已列出阶段稿件的导出 Word 不再单独列为“已导出文件”；仅按授权的文件路径识别。
  const unique = [...new Map(allFiles.filter(file => file.kind !== 'document' || !linkedExports.has(file.path))
    .map(file => [file.path || file.id, file])).values()]
  const files = latestDocumentVersions(unique)
  const selectedFormat = activeSelected?.downloadFormat || activeSelected?.path?.split('.').pop() || ''
  const selectedWord = selectedFormat.toLowerCase() === 'docx'
  const canDownload = Boolean(activeSelected?.downloadPath || activeSelected?.path || activeSelected?.content)
  const downloadLabel = selectedWord ? '下载 Word' : activeSelected?.path ? '下载当前稿件' : '下载源稿'
  return <aside className={`inspector ${activeSelected ? 'reading' : ''}`} aria-label="稿件与创作资料">
    <div className="inspector-header"><div><FileText size={16} /><strong>{activeSelected ? '稿件预览' : '创作资料'}</strong></div><button className="icon-button" aria-label="收起稿件面板" onClick={onClose}><PanelRightClose size={16} /></button></div>
    {activeSelected ? <>
      <div className="document-toolbar"><button className="text-button" onClick={() => onSelect(null)}><ChevronLeft size={14} />返回资料</button><span className="inspector-action-tooltip" data-tooltip={downloading ? '正在下载…' : downloadLabel}><button className="icon-button" disabled={downloading || !canDownload} aria-label={downloadLabel} onClick={() => void download()}><Download size={16} /></button></span></div>
      <div key={activeSelected.id} className="document-preview" aria-busy={previewBusy || downloading}><span className="document-type">{selectedFormat.toUpperCase() || '创作稿件'}</span><h2>{activeSelected.name}</h2>
        {activeSelected.path && isImageFile(activeSelected.path) ? <SourceImage path={activeSelected.path} name={activeSelected.name} /> : previewBusy ? <div className="document-loading" role="status"><LoaderCircle size={18} className="spin" /><span>正在准备稿件…</span><div className="document-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></div> : activeSelected.content || loaded ? <DocumentReader text={activeSelected.content || loaded} /> : <div className="document-empty"><FileText size={36} /><p>{selectedFormat.toLowerCase() === 'xls' ? 'XLS 暂不支持页面正文预览，可下载查看，或在对话中请智能体读取。' : '文件已保存到工作区'}</p><button className="secondary-button" disabled={downloading || !canDownload} onClick={() => void download()}><Download size={14} />{downloadLabel}</button></div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {truncated && <p role="status">预览仅显示部分内容，请下载当前稿件查看全文。</p>}
      </div>
    </> : <>
      <div className="inspector-body">
          <div className="file-section-title">原稿与成果<span>{files.length}</span><span className="inspector-action-tooltip" data-tooltip={!session.storedId ? '连接创作服务后才能刷新资料。' : refreshing ? '正在刷新创作资料…' : '刷新创作资料'}><button className="icon-button" disabled={!session.storedId || refreshing} aria-label="刷新创作资料" aria-busy={refreshing} onClick={() => void refresh()}><RefreshCw size={13} className={refreshing ? 'spin' : undefined} /></button></span></div>
          {materialError && <p className="inline-error" role="alert">{materialError}</p>}
          {files.length ? files.map(file => <button key={file.id} className="file-row" onClick={() => onSelect(file)}><span className={`file-icon ${file.kind}`}><FileText size={17} /></span><span><strong>{file.name}</strong><small>{file.kind === 'source' ? '原始资料' : file.kind === 'document' ? '已导出文件' : file.downloadPath ? `阶段稿件 · 可下载 ${file.downloadFormat?.toUpperCase() || '文件'}` : '阶段稿件'}{file.kind === 'result' ? versionLabel(file) : ''}</small></span></button>) :
            <div className="files-empty inspector-files-empty"><span className="inspector-empty-illustration" aria-hidden="true"><BookOpen size={32} /><Sparkles size={15} className="inspector-empty-sparkle" /></span><p>上传资料，开始创作</p></div>}
      </div>
      <div className="inspector-footer"><span className="status-dot" />{project ? '已载入项目记录' : '准备好，就开始写吧'}</div>
    </>}
  </aside>
}
