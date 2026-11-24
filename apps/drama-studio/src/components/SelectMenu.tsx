import { ChevronDown, Search } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './SelectMenu.css'

export interface SelectOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
  searchText?: string
  badge?: string
}
interface SelectMenuProps {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  searchLabel?: string
  disabled?: boolean
  title?: string
  leading?: ReactNode
  className?: string
}

export function SelectMenu({ label, value, options, onChange, placeholder = '请选择', searchLabel, disabled, title, leading, className = '' }: SelectMenuProps) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [dialogHost, setDialogHost] = useState<HTMLDialogElement | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const filtered = options.filter(option => terms.every(term => `${option.label} ${option.group || ''} ${option.searchText || ''}`.toLocaleLowerCase().includes(term)))
  const selected = options.find(option => option.value === value)
  const activeIndex = Math.min(active, filtered.length - 1)
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }
  const show = () => {
    setDialogHost(trigger.current?.closest('dialog') ?? null)
    setQuery('')
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    setOpen(true)
  }
  const choose = (option: SelectOption) => { if (option.disabled) return; onChange(option.value); close(true) }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect()
      // 原生对话框之外的节点不可交互，菜单需要留在当前对话框内。
      const hostRect = dialogHost?.getBoundingClientRect()
      const left = hostRect ? hostRect.left + dialogHost!.clientLeft : 0
      const top = hostRect ? hostRect.top + dialogHost!.clientTop : 0
      const height = dialogHost?.clientHeight ?? window.innerHeight
      const hostWidth = dialogHost?.clientWidth ?? window.innerWidth
      const width = Math.min(searchLabel ? 320 : 240, hostWidth - 24)
      const below = height - (rect.bottom - top) - 20
      const above = rect.top - top - 20
      const up = below < 310 && above > below
      setPosition({
        position: dialogHost ? 'absolute' : 'fixed',
        width, left: Math.max(12, Math.min(rect.left - left, hostWidth - width - 12)),
        ...(up ? { bottom: height - (rect.top - top) + 8 } : { top: rect.bottom - top + 8 }),
        transformOrigin: up ? 'bottom left' : 'top left',
        maxHeight: Math.max(120, Math.min(400, up ? above : below))
      })
    }
    place()
    if (searchLabel) search.current?.focus()
    else panel.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, searchLabel, dialogHost])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, id])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(true); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const last = filtered.length - 1
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? Math.min(activeIndex + 1, last) : Math.max(0, activeIndex - 1))
    }
    if (event.key === 'Enter' && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex]) }
  }

  return <div className={`select-menu ${className}`}>
    <button ref={trigger} type="button" className="select-menu-trigger" role="combobox" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      disabled={disabled} title={title} onClick={() => open ? close() : show()}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show() } }}>
      {leading}<span key={value} className="select-menu-value">{selected?.label || placeholder}</span>{selected?.badge && <small className="select-menu-badge" aria-hidden="true">{selected.badge}</small>}<ChevronDown className="select-menu-chevron" size={13} />
    </button>
    {createPortal(<div ref={panel} hidden={!open} inert={!open} aria-hidden={!open} className={`select-menu-panel ${searchLabel ? 'is-searchable' : ''}`} style={position} onKeyDown={onKeyDown}>
      <div className="select-menu-heading"><strong>{label}</strong><span>{filtered.length} 项</span></div>
      {searchLabel && <div className="select-menu-search"><Search size={15} /><input ref={search} type="search" aria-label={searchLabel} placeholder="搜索模型或服务…" value={query}
        aria-controls={`${id}-list`} aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        onChange={event => { setQuery(event.target.value); setActive(0) }} /></div>}
      <div id={`${id}-list`} role="listbox" aria-label={label} tabIndex={-1} className="select-menu-list"
        aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}>
        {filtered.map((option, index) => <div key={option.value}>
          {option.group && option.group !== filtered[index - 1]?.group && <div className={`select-menu-group ${option.group === '生图模型' ? 'is-image' : 'is-text'}`}>{option.group}</div>}
          <div id={`${id}-option-${index}`} role="option" aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            className={`select-menu-option ${index === activeIndex ? 'is-active' : ''}`} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
            <span>{option.label}</span>{option.badge && <small className="select-menu-badge" aria-hidden="true">{option.badge}</small>}
          </div>
        </div>)}
        {!filtered.length && <div className="select-menu-empty" role="status">没有找到匹配的模型</div>}
      </div>
      {searchLabel && <div className="select-menu-footnote">↑ ↓ 选择 · Enter 确认 · Esc 关闭</div>}
    </div>, dialogHost ?? document.body)}
  </div>
}
