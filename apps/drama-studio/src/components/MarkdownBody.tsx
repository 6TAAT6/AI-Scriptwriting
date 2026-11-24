import { Children, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Streamdown } from 'streamdown'
import { gateway } from '../lib/gateway'
import { workspace } from '../store/workspace'
import { ImageIcon, LoaderCircle } from 'lucide-react'
import { FileDownloadLink } from './FileDownloadLink'
import { isSupportedFile } from '../../shared/attachments.mjs'
import { emphasizeEpisodeHeadings } from '../lib/episode-headings'

function downloadPath(href: string): string | null {
  let path: string
  try { path = decodeURIComponent(href) } catch { return null }
  return /^\/assets-data\/[A-Za-z0-9_-]{32}\/[^/\\\x00-\x1f\x7f]+$/i.test(path) && isSupportedFile(path) ? path : null
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

// 列表项保留 pre-wrap（正文里的换行要原样显示），但解析器会在项内文字与嵌套列表、段落之间插入只含换行的文本节点，
// 在 pre-wrap 下它们显示成整行空白（员工看到的“列表空白很多”）。去掉这些空白节点，并去掉文字两端紧挨块元素的换行。
function listItemChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap(child => {
    if (typeof child !== 'string') return [child]
    const text = child.replace(/^\n+|\n+$/g, '')
    return text.trim() ? [text] : []
  })
}

// “**“战利品献礼”**”这类粗体紧贴中文引号或括号时，按 CommonMark 规则不算粗体，界面会露出星号。
// 把成对的中文标点移到粗体标记外面（“**战利品献礼**”），文字与原意不变。
// CommonMark 里“**”紧贴中文标点时常不能成对生效（“**承接与取舍：**保留”“文字**「标题」**”）。逐行把“**”两两配对，
// 把贴在内侧、阻止生效的标点移到加粗外面；配对后才处理，不会误连相邻两段加粗。代码块与含行内代码的行不改。
const EMPHASIS_LEAD = /^[“‘「『《（(【]+/
const EMPHASIS_TRAIL = /[”’」』》）)】，。：；！？、,.:;!?…]+$/

function emphasisLine(line: string): string {
  if (line.includes('`')) return line
  const parts = line.split('**')
  for (let index = 1; index + 1 < parts.length; index += 2) {
    let inner = parts[index]
    const lead = inner.match(EMPHASIS_LEAD)?.[0] ?? ''
    if (lead && lead.length < inner.length) { parts[index - 1] += lead; inner = inner.slice(lead.length) }
    const trail = inner.match(EMPHASIS_TRAIL)?.[0] ?? ''
    if (trail && trail.length < inner.length) { parts[index + 1] = trail + parts[index + 1]; inner = inner.slice(0, -trail.length) }
    parts[index] = inner
  }
  return parts.join('**')
}

export function cjkEmphasis(text: string): string {
  let fenced = false
  return text.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
    return fenced ? line : emphasisLine(line)
  }).join('\n')
}

// ----- 对话里的剧本稿页排版（只改显示）-----
function plainText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('')
}

const SCENE = /^(\d{1,3}\s*[-—]\s*\d{1,3})\s*场?[\s.．、]*(.*)$/
const SCENE_TAG = /^(?:[日夜晨昏午]|清晨|黄昏|傍晚|凌晨|深夜|雨夜|白天|夜晚|内|外|内外|内\/外|外\/内)$/

/** 场次标题：场次号悬在页边，地点在前，日夜、内外作为小标记。 */
function SceneHeading({ children }: { children: ReactNode }) {
  const text = plainText(children).trim()
  const match = text.match(SCENE)
  if (!match) return <h4>{children}</h4>
  const tokens = match[2].split(/\s+/).filter(Boolean)
  const tags: string[] = []
  while (tokens.length > 1 && SCENE_TAG.test(tokens[tokens.length - 1])) tags.unshift(tokens.pop()!)
  return <h4 className="scene-slug"><span className="scene-no">{match[1].replace(/\s+/g, '')}</span><span className="scene-place">{tokens.join(' ')}</span>{tags.map((tag, index) => <span key={index} className="scene-tag">{tag}</span>)}</h4>
}

function EpisodeHeading({ children }: { children: ReactNode }) {
  const text = plainText(children).trim()
  const match = text.match(/^(.*?)\s*⟨(\d+)⟩$/)
  if (!match) return <h3>{children}</h3>
  return <h3 className="episode-heading"><span>{match[1]}</span><span className="episode-count" title="本集汉字数（不含集标题）">{match[2]} 汉字</span></h3>
}

const SPEAKER = /^([^\s：:△▲【「“]{1,12})([：:])/
const CUE = /^\s*([（(][^）)]{0,20}[）)])/

/** 剧本行：△动作、“人物：”、“角色：（情绪）台词”分别排版，其余段落照常。 */
function ScriptParagraph({ children }: { children: ReactNode }) {
  const parts = Children.toArray(children)
  const first = parts[0]
  if (typeof first !== 'string') return <p style={{ whiteSpace: 'pre-wrap' }}>{children}</p>
  if (/^[△▲]/.test(first)) return <p className="script-act" style={{ whiteSpace: 'pre-wrap' }}>{children}</p>
  const speaker = first.match(SPEAKER)
  if (!speaker) return <p style={{ whiteSpace: 'pre-wrap' }}>{children}</p>
  if (speaker[1] === '人物' || speaker[1] === '出场人物') return <p className="script-cast" style={{ whiteSpace: 'pre-wrap' }}>{children}</p>
  let rest = first.slice(speaker[0].length)
  const cue = rest.match(CUE)
  if (cue) rest = rest.slice(cue[0].length)
  return <p className="script-line" style={{ whiteSpace: 'pre-wrap' }}><span className="speaker">{speaker[1]}{speaker[2]}</span>{cue && <span className="cue">{cue[1]}</span>}{rest}{parts.slice(1)}</p>
}

function PlainParagraph({ children }: { children?: ReactNode }) {
  return <p style={{ whiteSpace: 'pre-wrap' }}>{children}</p>
}

function ChatParagraph({ children }: { children?: ReactNode }) {
  return <ScriptParagraph>{children}</ScriptParagraph>
}

function EpisodeHeadingRenderer({ children }: { children?: ReactNode }) {
  return <EpisodeHeading>{children}</EpisodeHeading>
}

function SceneHeadingRenderer({ children }: { children?: ReactNode }) {
  return <SceneHeading>{children}</SceneHeading>
}

function ListItemRenderer({ children }: { children?: ReactNode }) {
  return <li style={{ whiteSpace: 'pre-wrap' }}>{listItemChildren(children)}</li>
}

// 用户和模型文本都作为 Markdown 数据解析，不接收原始 HTML。
const MarkdownBody = memo(function MarkdownBody({ text, streaming, onReadFile, chat = false }: { text: string; streaming: boolean; onReadFile?: (file: { path: string; name: string }) => void; chat?: boolean }) {
  // Streamdown memoizes parsed blocks by component identity. Keep this map stable while
  //正文增长；之前每次增量都新建箭头函数，导致已有文件按钮和图片节点整段重挂载。
  const onReadFileRef = useRef(onReadFile)
  onReadFileRef.current = onReadFile
  const handleReadFile = useCallback((file: { path: string; name: string }) => onReadFileRef.current?.(file), [])
  const components = useMemo(() => ({
    p: chat ? ChatParagraph : PlainParagraph,
    h3: chat ? EpisodeHeadingRenderer : ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
    h4: chat ? SceneHeadingRenderer : ({ children }: { children?: ReactNode }) => <h4>{children}</h4>,
    li: ListItemRenderer,
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const path = href ? downloadPath(href) : null
      if (path) return <FileDownloadLink path={path} onRead={onReadFile ? handleReadFile : undefined}>{children}</FileDownloadLink>
      if (!href || !/^https?:\/\//i.test(href)) return <span className="document-reference">{children}</span>
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    },
    img: ({ alt, src }: { alt?: string; src?: string }) => {
      const path = typeof src === 'string' ? imagePath(src) : null
      return path ? <InlineImage path={path} alt={alt || '参考图片'} /> : <span className="document-reference">{alt || '参考图片'}</span>
    }
  }), [chat])
  return <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} skipHtml controls={false} className="markdown"
    components={components}>{cjkEmphasis(emphasizeEpisodeHeadings(text, chat))}</Streamdown>
})

export default MarkdownBody
