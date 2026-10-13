import { useCallback, useEffect, useRef, useState } from 'react'

export const PANE_MIN_WIDTH = 240
export const PANE_MAX_WIDTH = 560
export const PANE_DEFAULT_WIDTH = 278
export const PANE_STORAGE_KEY = 'drama-studio:inspector-width'

export function maxPaneWidth(viewportWidth: number) {
  return Math.max(PANE_MIN_WIDTH, Math.min(PANE_MAX_WIDTH, viewportWidth - 360))
}

export function clampPaneWidth(width: number, viewportWidth: number) {
  return Math.round(Math.min(maxPaneWidth(viewportWidth), Math.max(PANE_MIN_WIDTH, width)))
}

export function paneWidthFromPointer(clientX: number, viewportWidth: number) {
  return clampPaneWidth(viewportWidth - clientX, viewportWidth)
}

function storedWidth() {
  if (typeof window === 'undefined') return PANE_DEFAULT_WIDTH
  const raw = window.localStorage.getItem(PANE_STORAGE_KEY)
  const value = Number(raw)
  return raw && Number.isFinite(value) ? clampPaneWidth(value, window.innerWidth) : PANE_DEFAULT_WIDTH
}

export function useResizablePane(enabled = true) {
  const [width, setWidth] = useState(storedWidth)
  const [dragging, setDragging] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  const update = useCallback((value: number) => setWidth(clampPaneWidth(value, window.innerWidth)), [])

  useEffect(() => {
    window.localStorage.setItem(PANE_STORAGE_KEY, String(width))
  }, [width])

  useEffect(() => {
    const resize = () => setWidth(current => clampPaneWidth(current, window.innerWidth))
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); cleanup.current?.(); document.body.style.removeProperty('user-select'); document.body.style.removeProperty('cursor') }
  }, [])

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
    const move = (moveEvent: PointerEvent) => update(paneWidthFromPointer(moveEvent.clientX, window.innerWidth))
    const end = () => stopDragging()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    cleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
  }, [enabled, stopDragging, update])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!enabled) return
    const step = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowLeft') { event.preventDefault(); update(width + step) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); update(width - step) }
    else if (event.key === 'Home') { event.preventDefault(); update(maxPaneWidth(window.innerWidth)) }
    else if (event.key === 'End') { event.preventDefault(); update(PANE_MIN_WIDTH) }
  }, [enabled, update, width])

  return {
    width,
    dragging,
    handleProps: {
      role: 'separator' as const,
      tabIndex: 0,
      'aria-label': '调整创作资料宽度',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': PANE_MIN_WIDTH,
      'aria-valuemax': maxPaneWidth(typeof window === 'undefined' ? PANE_MAX_WIDTH : window.innerWidth),
      'aria-valuenow': width,
      onPointerDown: startDragging,
      onKeyDown
    }
  }
}
