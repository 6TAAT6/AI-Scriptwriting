import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ExecutionProgress } from './ExecutionProgress'

afterEach(() => { cleanup(); vi.useRealTimers() })

test('运行中自动展开实时步骤，新内容即时可见，结束后折叠并可再次查看', () => {
  const { rerender } = render(<ExecutionProgress status="running" steps={[{ id: 'read', text: '正在读取原稿', at: 1000 }]} />)
  const log = screen.getByRole('log', { name: '思考与执行进度' })
  expect(log.closest('details')?.open).toBe(true)
  rerender(<ExecutionProgress status="running" steps={[{ id: 'read', text: '原稿已读取，正在核对人物关系', at: 2000 }]} />)
  expect(log.textContent).toContain('正在核对人物关系')
  rerender(<ExecutionProgress status="complete" steps={[{ id: 'read', text: '原稿已读取，正在核对人物关系', at: 2000 }]} />)
  expect(log.closest('details')?.open).toBe(false)
  expect(log.textContent).toContain('原稿已读取')
})

test('整轮计时从墙钟恢复，完成后冻结，未知起点不展示伪造的用时', () => {
  vi.useFakeTimers()
  const startedAt = Date.UTC(2026, 9, 4, 6)
  vi.setSystemTime(startedAt + 5000)
  const { rerender } = render(<ExecutionProgress status="running" startedAt={startedAt} currentStep="阅读原稿" />)
  expect(screen.getByRole('timer').textContent).toBe('本轮已用 5 秒')
  vi.setSystemTime(startedAt + 70000)
  act(() => { vi.advanceTimersByTime(1000) })
  expect(screen.getByRole('timer').textContent).toBe('本轮已用 1 分 11 秒')
  rerender(<ExecutionProgress status="waiting" startedAt={startedAt} />)
  expect(screen.getByRole('status').textContent).toContain('等待你的创作确认')
  act(() => { vi.advanceTimersByTime(2000) })
  expect(screen.getByRole('timer').textContent).toBe('本轮已用 1 分 13 秒')
  rerender(<ExecutionProgress status="disconnected" startedAt={startedAt} />)
  expect(screen.getByRole('status').textContent).toContain('进度待同步')
  expect(screen.getByRole('timer').textContent).toBe('本轮已用 1 分 13 秒')
  rerender(<ExecutionProgress status="complete" startedAt={startedAt} finishedAt={startedAt + 80000} />)
  expect(screen.getByRole('timer').textContent).toBe('本轮用时 1 分 20 秒')
  act(() => { vi.advanceTimersByTime(10000) })
  expect(screen.getByRole('timer').textContent).toBe('本轮用时 1 分 20 秒')
  rerender(<ExecutionProgress status="running" />)
  expect(screen.queryByRole('timer')).toBeNull()
  expect(screen.getByText('本轮起始时间未记录')).toBeTruthy()
  rerender(<ExecutionProgress status="interrupted" startedAt={startedAt} />)
  expect(screen.queryByRole('timer')).toBeNull()
  expect(screen.getByText('结束时间未记录')).toBeTruthy()
})

test('前置条件未满足时显示明确的阻塞状态', () => {
  render(<ExecutionProgress status="complete" steps={[{ id: 'review', text: '等待独立审核', at: 1000, state: 'blocked' }]} />)
  expect(screen.getByText('需前置操作')).toBeTruthy()
})
