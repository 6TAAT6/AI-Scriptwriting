// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { App } from './App'
import { workspace } from './store/workspace'

afterEach(cleanup)

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
