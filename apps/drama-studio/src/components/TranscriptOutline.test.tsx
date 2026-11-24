import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { workspace } from '../store/workspace'
import type { Entry } from '../lib/transcript'
import { Transcript } from './Transcript'

beforeEach(() => workspace.reset())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('一轮和超过百轮都保留完整目录，摘要、键盘与切换对话使用对应的消息身份', () => {
  const entries: Entry[] = Array.from({ length: 125 }, (_, index) => [
    { id: `问题:"${index}`, role: 'user' as const, text: `第${index + 1}个创作要求`, calls: [] },
    { id: `answer-${index}`, role: 'assistant' as const, text: `第${index + 1}轮的处理结果`, calls: [] }
  ]).flat()
  workspace.conversation.set({ runtimeId: 'long', entries, running: false, error: '' })
  render(<Transcript />)
  const outline = screen.getByRole('navigation', { name: '对话目录' })
  const buttons = within(outline).getAllByRole('button', { name: /^跳转到第/ })
  expect(buttons).toHaveLength(entries.filter(entry => entry.role === 'user').length)
  fireEvent.mouseEnter(buttons[0])
  expect(screen.getByRole('tooltip').textContent).toContain('第1个创作要求')
  expect(screen.getByRole('tooltip').textContent).toContain('第1轮的处理结果')
  fireEvent.keyDown(buttons[0], { key: 'End' })
  expect(document.activeElement).toBe(buttons.at(-1))
  fireEvent.keyDown(buttons.at(-1)!, { key: 'Home' })
  expect(document.activeElement).toBe(buttons[0])

  act(() => workspace.conversation.set({ runtimeId: 'single', entries: [
    { id: 'only', role: 'user', text: '', attachments: [{ name: '故事原稿.docx', path: '/assets-data/example.docx' }], calls: [] }
  ], running: false, error: '' }))
  expect(within(screen.getByRole('navigation', { name: '对话目录' })).getAllByRole('button', { name: /^跳转到第/ })).toHaveLength(1)
  expect(screen.getByRole('button', { name: /跳转到第 1 轮：故事原稿.docx/ })).toBeTruthy()
  expect(screen.queryByRole('tooltip')).toBeNull()
})

test('从底部平滑定位旧消息时，滚动事件和流式更新均不能抢回底部，主动提交仍恢复跟随', () => {
  const entries: Entry[] = [
    { id: 'first', role: 'user', text: '最初的要求', calls: [] },
    { id: 'answer', role: 'assistant', text: '正在生成正文', pending: true, calls: [] },
    { id: 'latest', role: 'user', text: '后续要求', calls: [] }
  ]
  workspace.conversation.set({ runtimeId: 'stream', entries, running: true, error: '' })
  const view = render(<Transcript />)
  const scroll = view.container.querySelector<HTMLDivElement>('.transcript-scroll')!
  let top = 1800, height = 2400
  Object.defineProperties(scroll, {
    clientHeight: { get: () => 600 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: value => { top = Math.min(value, height - 600) } }
  })
  const scrollTo = vi.fn()
  scroll.scrollTo = scrollTo
  fireEvent.click(screen.getByRole('button', { name: '跳转到第 1 轮：最初的要求' }))
  expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
  fireEvent.scroll(scroll)
  height = 3000
  act(() => workspace.conversation.set({ ...workspace.conversation.get(), entries: [...entries,
    { id: 'delta', role: 'assistant', text: '继续返回正文', pending: true, calls: [] }
  ] }))
  expect(top).toBe(1800)
  top = 120
  fireEvent.scroll(scroll)
  act(() => workspace.conversation.set({ ...workspace.conversation.get(), running: false }))
  expect(top).toBe(120)
  fireEvent.pointerDown(scroll)
  top = height - 600
  fireEvent.scroll(scroll)
  height = 3600
  act(() => workspace.conversation.set({ ...workspace.conversation.get(), entries: [...workspace.conversation.get().entries,
    { id: 'after-drag', role: 'assistant', text: '拖动滚动条回到底部后继续跟随', pending: true, calls: [] }
  ] }))
  expect(top).toBe(height - 600)
  top = 120
  fireEvent.scroll(scroll)
  act(() => workspace.lastSubmissionId.set('new-submission'))
  expect(top).toBe(height - 600)
})
