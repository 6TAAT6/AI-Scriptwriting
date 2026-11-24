import { afterEach, expect, test, vi } from 'vitest'
import { trackViewportResize } from './viewport-resize'

afterEach(() => { vi.useRealTimers() })

test('窗口尺寸持续变化时一直暂停面板过渡，最后一次变化稳定后才恢复', () => {
  vi.useFakeTimers()
  const root = document.documentElement
  const stop = trackViewportResize(root, 200)
  const resizing = () => root.classList.contains('viewport-resizing')
  expect(resizing()).toBe(false)
  window.dispatchEvent(new Event('resize'))
  expect(resizing()).toBe(true)
  vi.advanceTimersByTime(150)
  window.dispatchEvent(new Event('resize'))
  vi.advanceTimersByTime(150)
  expect(resizing()).toBe(true)
  vi.advanceTimersByTime(60)
  expect(resizing()).toBe(false)
  window.dispatchEvent(new Event('resize'))
  stop()
  expect(resizing()).toBe(false)
})
