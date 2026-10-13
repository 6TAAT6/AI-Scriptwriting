import { ChevronDown, List, Search } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { prepareDocument } from '../lib/document-layout'
import { Markdown } from './Markdown'
import './DocumentReader.css'

interface Chapter { id: string; label: string; level: number }
interface DocumentReaderProps { text: string }

export function DocumentReader({ text }: DocumentReaderProps) {
  const prefix = useId()
  const body = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const targets = useRef(new Map<string, HTMLHeadingElement>())
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState('')
  const formatted = useMemo(() => prepareDocument(text), [text])

  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    setQuery(''); setExpanded(false); setCurrent('')
    const collect = () => {
      const nodes = element.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6')
      const next: Chapter[] = []
      targets.current.clear()
      nodes.forEach((heading, index) => {
        const id = `${prefix}-chapter-${index}`
        heading.id = id
        heading.tabIndex = -1
        targets.current.set(id, heading)
        next.push({ id, label: heading.textContent?.trim() || '章节', level: Number(heading.tagName.slice(1)) })
      })
      setChapters(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    collect()
    // Markdown 延迟载入后才有标题节点，目录以实际渲染出的标题为准。
    const observer = new MutationObserver(collect)
    observer.observe(element, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [formatted, prefix])

  useEffect(() => {
    if (!chapters.length || typeof IntersectionObserver === 'undefined') return
    const visible = new Map<string, number>()
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top)
        else visible.delete(entry.target.id)
      }
      const first = [...visible].sort((a, b) => a[1] - b[1])[0]
      if (first) setCurrent(first[0])
    }, { root: body.current?.closest('.document-preview'), rootMargin: '-48px 0px -60% 0px' })
    targets.current.forEach(target => observer.observe(target))
    return () => observer.disconnect()
  }, [chapters])

  function jump(id: string) {
    const target = targets.current.get(id)
    if (!target) return
    setCurrent(id); setExpanded(false)
    target.scrollIntoView({ block: 'start', behavior: 'auto' })
    target.focus({ preventScroll: true })
  }

  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const filtered = chapters.filter(chapter => terms.every(term => chapter.label.toLocaleLowerCase().replace(/\s+/g, '').includes(term)))
  const baseLevel = chapters.reduce((level, chapter) => Math.min(level, chapter.level), 6)
  return <div className="document-reader">
    {chapters.length > 0 && <div className="document-toc">
      <button ref={toggle} type="button" className="document-toc-toggle" aria-expanded={expanded} aria-controls={`${prefix}-toc`} onClick={() => setExpanded(value => !value)}>
        <List size={15} /><strong>章节目录 · {chapters.length}</strong><span>{chapters.find(chapter => chapter.id === current)?.label || '快速跳转'}</span><ChevronDown size={14} />
      </button>
      <div id={`${prefix}-toc`} className="document-toc-menu" hidden={!expanded} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
        <label className="document-toc-search"><Search size={14} /><input type="search" aria-label="搜索章节" placeholder="搜索集数或章节标题" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <nav aria-label="章节目录">{filtered.map(chapter => <button type="button" key={chapter.id} className="document-toc-item" style={{ paddingLeft: 12 + Math.min(3, chapter.level - baseLevel) * 14 }} aria-current={current === chapter.id ? 'location' : undefined} onClick={() => jump(chapter.id)}>{chapter.label}</button>)}</nav>
        {!filtered.length && <p className="document-toc-empty">没有匹配的章节</p>}
      </div>
    </div>}
    <div ref={body} className="document-reader-body"><Markdown text={formatted} /></div>
  </div>
}
