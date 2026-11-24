import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { TranscriptBlock } from '../lib/transcript-blocks'
import { splitCapabilityDraft } from '../lib/capabilities'
import './TranscriptOutline.css'

interface OutlineItem { id: string; title: string; summary: string }
interface TranscriptOutlineProps {
  blocks: TranscriptBlock[]
  scroll: RefObject<HTMLDivElement | null>
  onNavigate: () => void
}

function excerpt(text: string, length: number) {
  const plain = text.slice(0, length * 3).replace(/[`#*_>]/g, '').replace(/\s+/g, ' ').trim()
  return plain.length > length ? `${plain.slice(0, length)}…` : plain
}

function outlineItems(blocks: TranscriptBlock[]): OutlineItem[] {
  const items: OutlineItem[] = []
  for (const { entry } of blocks) {
    if (entry.role === 'user') {
      const body = splitCapabilityDraft(entry.text).body
      const files = [...(entry.attachments ?? []), ...(entry.images ?? [])].map(file => file.name).join('、')
      items.push({ id: entry.id, title: excerpt(body || files || '创作请求', 80), summary: '' })
    } else if (entry.role === 'assistant' && items.length && entry.text.trim()) {
      items[items.length - 1].summary = excerpt(entry.text, 160)
    }
  }
  return items
}

export function TranscriptOutline({ blocks, scroll, onNavigate }: TranscriptOutlineProps) {
  const items = useMemo(() => outlineItems(blocks), [blocks])
  const anchors = useRef(new Map<string, HTMLElement>())
  const track = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [activeId, setActiveId] = useState('')
  const [preview, setPreview] = useState<{ id: string; top: number } | null>(null)
  const tooltipId = useId()
  const anchorKey = JSON.stringify(items.map(item => item.id))

  useEffect(() => {
    const root = scroll.current
    if (!root) return
    const ids: string[] = JSON.parse(anchorKey)
    const targets = new Map<string, HTMLElement>()
    root.querySelectorAll<HTMLElement>('[data-conversation-anchor]').forEach(element => {
      targets.set(element.dataset.conversationAnchor!, element)
    })
    anchors.current = targets
    let frame = 0
    const measure = () => {
      frame = 0
      let index = 0
      if (root.scrollHeight - root.clientHeight - root.scrollTop < 8 && root.scrollHeight > root.clientHeight) index = ids.length - 1
      else {
        const threshold = root.getBoundingClientRect().top + 72
        let low = 0, high = ids.length - 1
        while (low <= high) {
          const middle = (low + high) >>> 1
          const element = targets.get(ids[middle])
          if (element && element.getBoundingClientRect().top <= threshold) { index = middle; low = middle + 1 }
          else high = middle - 1
        }
      }
      setActiveId(ids[index] ?? '')
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (root.firstElementChild) observer?.observe(root.firstElementChild)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [scroll, anchorKey])

  useEffect(() => {
    const list = track.current, button = buttons.current.get(activeId)
    if (!list || !button) return
    if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop
    else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight
  }, [activeId])

  const showPreview = (item: OutlineItem, button: HTMLButtonElement) => {
    const nav = button.closest('nav')!
    const bounds = nav.getBoundingClientRect()
    setPreview({ id: item.id, top: Math.max(0, Math.min(button.getBoundingClientRect().top - bounds.top - 34, bounds.height - 158)) })
  }
  const navigate = (item: OutlineItem) => {
    const root = scroll.current, target = anchors.current.get(item.id)
    if (!root || !target) return
    onNavigate()
    setActiveId(item.id)
    const top = Math.max(0, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 28)
    root.scrollTo({ top, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    target.focus({ preventScroll: true })
    target.animate?.([{ backgroundColor: 'var(--purple-light)' }, { backgroundColor: 'transparent' }], {
      duration: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 800
    })
    setPreview(null)
  }
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: items.length - 1 }[event.key]
    if (next !== undefined) {
      event.preventDefault()
      const button = buttons.current.get(items[Math.max(0, Math.min(next, items.length - 1))].id)
      button?.focus({ preventScroll: true })
      if (button && track.current) {
        const list = track.current
        if (button.offsetTop < list.scrollTop || button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = button.offsetTop - list.clientHeight / 2
      }
    } else if (event.key === 'Escape') setPreview(null)
  }
  const previewIndex = items.findIndex(item => item.id === preview?.id)
  const previewItem = items[previewIndex]
  if (!items.length) return null
  return <nav className="transcript-outline" aria-label="对话目录" onMouseLeave={() => setPreview(null)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreview(null) }}>
    <div className="outline-track" ref={track} onScroll={() => {
      const focused = document.activeElement
      const item = items.find(item => buttons.current.get(item.id) === focused)
      if (item && focused instanceof HTMLButtonElement) showPreview(item, focused)
      else setPreview(null)
    }}>
      {items.map((item, index) => <button key={item.id} type="button" className={`outline-tick ${index % 5 === 0 ? 'is-major' : ''}`}
        ref={button => { if (button) buttons.current.set(item.id, button); else buttons.current.delete(item.id) }}
        aria-label={`跳转到第 ${index + 1} 轮：${item.title}`} aria-current={item.id === activeId ? 'location' : undefined}
        aria-describedby={item.id === preview?.id ? tooltipId : undefined}
        onMouseEnter={event => showPreview(item, event.currentTarget)} onFocus={event => showPreview(item, event.currentTarget)}
        onKeyDown={event => handleKey(event, index)} onClick={() => navigate(item)}><span /></button>)}
    </div>
    {previewItem && <div key={previewItem.id} id={tooltipId} className="outline-preview" role="tooltip" style={{ top: preview!.top }}>
      <div className="outline-preview-heading"><span>对话目录</span><span>{previewIndex + 1} / {items.length}</span></div>
      <strong>{previewItem.title}</strong><p>{previewItem.summary || '查看本轮对话'}</p>
      <span className="outline-preview-hint">点击刻度，回到这轮对话</span>
    </div>}
  </nav>
}
