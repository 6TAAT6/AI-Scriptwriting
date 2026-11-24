// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from './App'
import { welcomeGreeting } from './lib/greeting'
import { workspace } from './store/workspace'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('侧栏关闭期间不可操作，重新展开后保留搜索条件', () => {
  workspace.navigation.set({ sessions: [], loading: false, error: '' })
  workspace.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
  render(<App />)
  fireEvent.change(screen.getByRole('textbox', { name: '搜索创作对话' }), { target: { value: '灯火' } })
  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
  expect(screen.queryByRole('textbox', { name: '搜索创作对话' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }))
  expect((screen.getByRole('textbox', { name: '搜索创作对话' }) as HTMLInputElement).value).toBe('灯火')
})

test('首页只显示按时段变化的问候主标题', () => {
  workspace.navigation.set({ sessions: [], loading: false, error: '' })
  workspace.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
  render(<App />)

  expect(screen.getByRole('heading', { level: 1, name: welcomeGreeting() })).toBeTruthy()
  expect(screen.queryByText('巨豹智能体', { selector: '.eyebrow' })).toBeNull()
  expect(screen.queryByText('直接提问，或开始你的创作。')).toBeNull()
})

test('首页停留跨时段及重新聚焦时更新问候，夜深提示在早晨消失并清理订阅', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 19, 8, 59, 59, 500))
  const windowAdded = vi.spyOn(window, 'addEventListener')
  const windowRemoved = vi.spyOn(window, 'removeEventListener')
  const documentAdded = vi.spyOn(document, 'addEventListener')
  const documentRemoved = vi.spyOn(document, 'removeEventListener')
  workspace.navigation.set({ sessions: [], loading: false, error: '' })
  workspace.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
  const view = render(<App />)

  expect(screen.getByRole('heading', { level: 1, name: '早上好，开始创作吧！' })).toBeTruthy()
  act(() => { vi.advanceTimersByTime(500) })
  expect(screen.getByRole('heading', { level: 1, name: '上午好，开始创作吧！' })).toBeTruthy()

  vi.setSystemTime(new Date(2026, 9, 19, 17, 47))
  fireEvent.focus(window)
  expect(screen.getByRole('heading', { level: 1, name: '下午好，开始创作吧！' })).toBeTruthy()

  vi.setSystemTime(new Date(2026, 9, 19, 21, 59, 59, 500))
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.getByRole('heading', { level: 1, name: '晚上好，开始创作吧！' })).toBeTruthy()
  expect(screen.queryByText('夜深了，还在工作嘛？')).toBeNull()
  act(() => { vi.advanceTimersByTime(500) })
  expect(screen.getByText('夜深了，还在工作嘛？')).toBeTruthy()

  vi.setSystemTime(new Date(2026, 9, 20, 4, 59, 59, 500))
  fireEvent.focus(window)
  expect(screen.getByText('夜深了，还在工作嘛？')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(500) })
  expect(screen.getByRole('heading', { level: 1, name: '早上好，开始创作吧！' })).toBeTruthy()
  expect(screen.queryByText('夜深了，还在工作嘛？')).toBeNull()

  const focusSubscription = windowAdded.mock.calls.find(([event]) => event === 'focus')
  const visibilitySubscription = documentAdded.mock.calls.find(([event]) => event === 'visibilitychange')
  expect(focusSubscription).toBeTruthy()
  expect(visibilitySubscription).toBeTruthy()
  view.unmount()
  expect(windowRemoved.mock.calls).toContainEqual(focusSubscription)
  expect(documentRemoved.mock.calls).toContainEqual(visibilitySubscription)
  // 状态订阅会延迟卸载；清空这些任务后不应留下重复排期的问候计时器。
  act(() => { vi.runOnlyPendingTimers() })
  expect(vi.getTimerCount()).toBe(0)
})
