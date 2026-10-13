// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
