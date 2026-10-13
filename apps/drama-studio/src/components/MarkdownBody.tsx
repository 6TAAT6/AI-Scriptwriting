import { memo, useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { gateway } from '../lib/gateway'
import { workspace } from '../store/workspace'
import { ImageIcon, LoaderCircle } from 'lucide-react'
import { FileDownloadLink } from './FileDownloadLink'

function downloadPath(href: string): string | null {
  let path: string
  try { path = decodeURIComponent(href) } catch { return null }
  return /^\/assets-data\/[A-Za-z0-9_-]{32}\/[^/\\\x00-\x1f\x7f]+\.(?:txt|md|docx|xlsx|csv|pdf|png|jpe?g|webp)$/i.test(path) ? path : null
}

function imagePath(href: string): string | null {
  let path: string
  try { path = decodeURIComponent(href) } catch { return null }
  return /^\/assets-data\/[A-Za-z0-9_-]{32}\/[^/\\\x00-\x1f\x7f]+\.(?:png|jpe?g|webp)$/i.test(path) ? path : null
}

function InlineImage({ path, alt }: { path: string; alt: string }) {
  const session = workspace.session.get()
  const [url, setUrl] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true, objectUrl = ''
    setUrl(''); setError(false)
    void gateway.file(path, session.storedId).then(response => response.blob()).then(blob => {
      if (!active) return
      if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) throw new Error('图片格式无法预览')
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path, session.storedId])
  if (error) return <span className="document-reference"><ImageIcon size={14} />{alt || '图片加载失败'}</span>
  return url ? <figure className="markdown-image"><img src={url} alt={alt || '生成图片'} /></figure> : <span className="document-reference"><LoaderCircle size={14} className="spin" />正在载入图片…</span>
}

// 用户和模型文本都作为 Markdown 数据解析，不接收原始 HTML。
const MarkdownBody = memo(function MarkdownBody({ text, streaming, onReadFile }: { text: string; streaming: boolean; onReadFile?: (file: { path: string; name: string }) => void }) {
  return <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} skipHtml controls={false} className="markdown"
    components={{
      p: ({ children }) => <p style={{ whiteSpace: 'pre-wrap' }}>{children}</p>,
      li: ({ children }) => <li style={{ whiteSpace: 'pre-wrap' }}>{children}</li>,
      a: ({ href, children }) => {
        const path = href ? downloadPath(href) : null
        if (path) return <FileDownloadLink path={path} onRead={onReadFile}>{children}</FileDownloadLink>
        if (!href || !/^https?:\/\//i.test(href)) return <span className="document-reference">{children}</span>
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      },
      img: ({ alt, src }) => {
        const path = typeof src === 'string' ? imagePath(src) : null
        return path ? <InlineImage path={path} alt={alt || '参考图片'} /> : <span className="document-reference">{alt || '参考图片'}</span>
      }
    }}>{text}</Streamdown>
})

export default MarkdownBody
