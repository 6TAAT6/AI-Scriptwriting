import { memo, useId, useState } from 'react'
import type { Artifact } from '../lib/creative'
import { DocumentReader } from './DocumentReader'
import { FileDownloadLink } from './FileDownloadLink'
import './ManuscriptDelivery.css'

interface ManuscriptDeliveryProps {
  artifact: Artifact
  showDownload: boolean
  onReadFile?: (file: { path: string; name: string }) => void
}

const LABELS: Record<string, string> = { script: '剧本正文', outline: '大纲', analysis: '分析稿', novel: '小说正文', document: '稿件' }

/** 正文来自已授权的稿件快照；展开阅读不提交消息，也不重新生成。 */
export const ManuscriptDelivery = memo(function ManuscriptDelivery({ artifact, showDownload, onReadFile }: ManuscriptDeliveryProps) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const label = LABELS[artifact.documentKind || ''] || '稿件'
  const statistics = artifact.textStatistics
  return <section className="manuscript-delivery" aria-label={`完整${label}：${artifact.name}`}>
    <div className="manuscript-delivery-heading"><strong>完整{label}已保存</strong><span>{artifact.name}</span></div>
    <p className="manuscript-delivery-meta">{statistics
      ? `系统统计：${statistics.hanCharacters.toLocaleString('zh-CN')} 汉字 · ${statistics.nonWhitespaceCharacters.toLocaleString('zh-CN')} 非空白字符`
      : '读取已保存的完整稿件，无需重新生成。'}</p>
    {artifact.contentVerified && <p className="manuscript-delivery-verification">文件内容已核对{!artifact.layoutVerified ? ' · 版式未检查' : ''}{!artifact.wpsVerified ? ' · WPS 未检查' : ''}</p>}
    <div className="manuscript-delivery-actions">
      <button type="button" className="text-button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>{expanded ? '收起完整正文' : '展开完整正文'}</button>
      {showDownload && artifact.downloadPath && <FileDownloadLink path={artifact.downloadPath} downloadName={artifact.downloadName} onRead={onReadFile}>{artifact.downloadName || artifact.name}</FileDownloadLink>}
    </div>
    {expanded && <div id={bodyId} className="manuscript-delivery-body"><DocumentReader text={artifact.content!} /></div>}
  </section>
})
