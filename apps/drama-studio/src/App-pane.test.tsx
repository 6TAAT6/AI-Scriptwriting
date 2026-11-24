// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { App } from './App'
import { workspace } from './store/workspace'

beforeEach(() => {
  localStorage.clear()
  workspace.navigation.set({ sessions: [], loading: false, error: '' })
  workspace.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
})
afterEach(cleanup)

test('创作资料面板可用左边界拖动调整宽度并保留可访问拖动句柄', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: '打开创作资料' }))
  const handle = screen.getByRole('separator', { name: '调整创作资料宽度' })
  const panel = handle.parentElement!
  expect(handle.getAttribute('aria-valuenow')).toBe('278')
  fireEvent.pointerDown(handle, { button: 0, clientX: 746 })
  fireEvent.pointerMove(window, { clientX: 600 })
  fireEvent.pointerUp(window)
  expect(panel.getAttribute('style')).toContain('--inspector-width: 424px')
  expect(handle.getAttribute('aria-valuenow')).toBe('424')
})


test('左侧会话栏支持拖动和键盘调宽，收起展开及重新打开保留宽度', () => {
  const view = render(<App />)
  const handle = screen.getByRole('separator', { name: '调整会话列表宽度' })
  fireEvent.pointerDown(handle, { button: 0, clientX: 246 })
  fireEvent.pointerMove(window, { clientX: 330 })
  fireEvent.pointerUp(window)
  expect(handle.getAttribute('aria-valuenow')).toBe('330')
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle.getAttribute('aria-valuenow')).toBe('346')
  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }))
  expect(screen.getByRole('separator', { name: '调整会话列表宽度' }).getAttribute('aria-valuenow')).toBe('346')
  view.unmount()
  render(<App />)
  expect(screen.getByRole('separator', { name: '调整会话列表宽度' }).getAttribute('aria-valuenow')).toBe('346')
})


test('手机仍用抽屉且不提供拖宽句柄，回到桌面保持上次左栏宽度', () => {
  const previous = window.innerWidth
  localStorage.setItem('drama-studio:sidebar-width', '360')
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
  const view = render(<App />)
  fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }))
  expect(screen.queryByRole('separator', { name: '调整会话列表宽度' })).toBeNull()
  act(() => { window.innerWidth = previous; window.dispatchEvent(new Event('resize')) })
  expect(screen.getByRole('separator', { name: '调整会话列表宽度' }).getAttribute('aria-valuenow')).toBe('360')
  view.unmount()
})
