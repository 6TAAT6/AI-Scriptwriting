import { useCallback, useEffect, useRef, useState } from 'react'

export const PANE_MIN_WIDTH = 240
export const PANE_MAX_WIDTH = 560
export const PANE_DEFAULT_WIDTH = 278
export const PANE_STORAGE_KEY = 'drama-studio:inspector-width'
type PaneSide = 'left' | 'right'
const storageKey = (side: PaneSide) => side === 'left' ? 'drama-studio:sidebar-width' : PANE_STORAGE_KEY
const defaultWidth = (side: PaneSide) => side === 'left' ? 246 : PANE_DEFAULT_WIDTH
const minWidth = (side: PaneSide) => side === 'left' ? 180 : PANE_MIN_WIDTH
const maxWidth = (side: PaneSide) => side === 'left' ? 480 : PANE_MAX_WIDTH

export function maxPaneWidth(viewportWidth: number, side: PaneSide = 'right') {
  return Math.max(minWidth(side), Math.min(maxWidth(side), viewportWidth - 360))
}

export function clampPaneWidth(width: number, viewportWidth: number, side: PaneSide = 'right') {
  return Math.round(Math.min(maxPaneWidth(viewportWidth, side), Math.max(minWidth(side), width)))
}

export function paneWidthFromPointer(clientX: number, viewportWidth: number) {
  return clampPaneWidth(viewportWidth - clientX, viewportWidth)
}

function storedWidth(side: PaneSide) {
  if (typeof window === 'undefined') return defaultWidth(side)
  const raw = window.localStorage.getItem(storageKey(side))
  const value = Number(raw)
  return raw && Number.isFinite(value) ? clampPaneWidth(value, Math.max(840, window.innerWidth), side) : defaultWidth(side)
}

export function useResizablePane(enabled = true, side: PaneSide = 'right') {
  const [width, setWidth] = useState(() => storedWidth(side))
  const [dragging, setDragging] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  const update = useCallback((value: number) => setWidth(clampPaneWidth(value, window.innerWidth, side)), [side])

  useEffect(() => {
    window.localStorage.setItem(storageKey(side), String(width))
  }, [side, width])

  useEffect(() => {
    const resize = () => { if (window.innerWidth > 760) setWidth(current => clampPaneWidth(current, window.innerWidth, side)) }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); cleanup.current?.(); document.body.style.removeProperty('user-select'); document.body.style.removeProperty('cursor') }
  }, [side])

  const stopDragging = useCallback(() => {
    cleanup.current?.()
    cleanup.current = null
    setDragging(false)
    document.body.style.removeProperty('user-select')
    document.body.style.removeProperty('cursor')
  }, [])

  const startDragging = useCallback((event: React.PointerEvent) => {
    if (!enabled || event.button !== 0) return
    event.preventDefault()
    setDragging(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const move = (moveEvent: PointerEvent) => update(side === 'left' ? moveEvent.clientX : paneWidthFromPointer(moveEvent.clientX, window.innerWidth))
    const end = () => stopDragging()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
    cleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [enabled, side, stopDragging, update])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!enabled) return
    const step = event.shiftKey ? 48 : 16
    const direction = side === 'left' ? -1 : 1
    if (event.key === 'ArrowLeft') { event.preventDefault(); update(width + step * direction) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); update(width - step * direction) }
    else if (event.key === 'Home') { event.preventDefault(); update(maxPaneWidth(window.innerWidth, side)) }
    else if (event.key === 'End') { event.preventDefault(); update(minWidth(side)) }
  }, [enabled, side, update, width])

  return {
    width,
    dragging,
    handleProps: {
      role: 'separator' as const,
      tabIndex: 0,
      'aria-label': side === 'left' ? '调整会话列表宽度' : '调整创作资料宽度',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': minWidth(side),
      'aria-valuemax': maxPaneWidth(typeof window === 'undefined' ? PANE_MAX_WIDTH : window.innerWidth, side),
      'aria-valuenow': width,
      onPointerDown: startDragging,
      onKeyDown
    }
  }
}
