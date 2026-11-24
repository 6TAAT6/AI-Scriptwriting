import { FileText, Check, Copy } from 'lucide-react'
import { memo, useId, useState } from 'react'
import type { Artifact } from '../lib/creative'
import { DocumentReader } from './DocumentReader'
import { documentVersion } from '../lib/document-names'
import { FileDownloadLink } from './FileDownloadLink'
import { copyText } from '../lib/copy'
import './ManuscriptDelivery.css'

interface ManuscriptDeliveryProps {
  artifact: Artifact
  showDownload: boolean
  /** 同一轮里后端按同名另存的更高版本号；有值时这张卡片是修订前的草稿，压成一行。 */
  newerVersion?: number
  /** 同一轮里同名稿件的版本数；本卡片是其中最新的一版时显示。 */
  roundVersions?: number
  onReadFile?: (file: { path: string; name: string }) => void
}

const LABELS: Record<string, string> = { script: '剧本正文', outline: '大纲', analysis: '分析稿', novel: '小说正文', document: '稿件' }
const count = (value: number) => value.toLocaleString('zh-CN')

/** 正文来自已授权的稿件快照；展开阅读不提交消息，也不重新生成。 */
export const ManuscriptDelivery = memo(function ManuscriptDelivery({ artifact, showDownload, newerVersion, roundVersions, onReadFile }: ManuscriptDeliveryProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const bodyId = useId()
  const label = LABELS[artifact.documentKind || ''] || '稿件'
  const statistics = artifact.textStatistics
  const version = documentVersion(artifact.downloadName)
  const copy = async () => { if (!artifact.content) return; try { await copyText(artifact.content); setCopied(true) } catch { setCopied(false) } }
  const actions = <div className="manuscript-delivery-actions">
    <button type="button" className="text-button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>{expanded ? '收起完整正文' : '展开完整正文'}</button>
    {artifact.content && <button type="button" className="text-button" aria-label={`复制全文：${artifact.name}`} onClick={() => void copy()}>{copied ? <><Check size={14} />已复制全文</> : <><Copy size={14} />复制全文</>}</button>}
    {showDownload && artifact.downloadPath && <FileDownloadLink path={artifact.downloadPath} downloadName={artifact.downloadName} onRead={onReadFile}>{artifact.downloadName || artifact.name}</FileDownloadLink>}
  </div>
  const body = expanded && <div id={bodyId} className="manuscript-delivery-body"><DocumentReader text={artifact.content!} /></div>
  if (newerVersion) return <section className="manuscript-delivery is-superseded" aria-label={`修订前的${label}：${artifact.name}`}>
    <div className="manuscript-delivery-heading"><strong>第 {version ?? newerVersion - 1} 版</strong><span>{artifact.name}</span>
      <small className="manuscript-versions">已有第 {newerVersion} 版，这一版是修订前的草稿</small></div>
    {actions}{body}
  </section>
  const latestVersion = (artifact.versions ?? 1) > 1 ? documentVersion(artifact.downloadName) ?? artifact.versions : roundVersions && roundVersions > 1 ? version ?? roundVersions : undefined
  return <section className="manuscript-delivery" aria-label={`完整${label}：${artifact.name}`}>
    <div className="manuscript-delivery-heading"><span className="manuscript-delivery-icon" aria-hidden="true"><FileText size={18} /></span><strong>完整{label}已保存</strong><span>{artifact.name}</span>
      {latestVersion && <small className="manuscript-versions" title="同一份稿件返修后保存的新版本；Word 文件名末尾带版本号">
        第 {latestVersion} 版（最新）· 前 {latestVersion - 1} 版是修订前的草稿</small>}
    </div>
    {statistics?.episodes ? <>
      <ul className="manuscript-episodes" aria-label="按集字数">{statistics.episodes.map(row =>
        <li key={row.episode}><span>{row.episode}</span>{count(row.hanCharacters)} 汉字 · {count(row.nonWhitespaceCharacters)} 非空白字符</li>)}</ul>
      <p className="manuscript-delivery-meta">全文（含集标题）{count(statistics.hanCharacters)} 汉字 · {count(statistics.nonWhitespaceCharacters)} 非空白字符</p>
    </> : <p className="manuscript-delivery-meta">{statistics
      ? `系统统计：${count(statistics.hanCharacters)} 汉字 · ${count(statistics.nonWhitespaceCharacters)} 非空白字符`
      : '读取已保存的完整稿件，无需重新生成。'}</p>}
    {artifact.contentVerified && <p className="manuscript-delivery-verification">文件内容已核对{!artifact.layoutVerified ? ' · 版式未检查' : ''}{!artifact.wpsVerified ? ' · WPS 未检查' : ''}</p>}
    {actions}{body}
  </section>
})
