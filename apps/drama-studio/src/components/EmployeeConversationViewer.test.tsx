import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { $employeeViewer, resetEmployeeConversations } from '../employee-access/api'
import { EmployeeConversationViewer } from './EmployeeConversationViewer'

const group = {
  id: 'access-1', employeeId: 'employee-1', createdBy: 'admin-1', createdAt: '2026-10-09T00:00:00.000Z',
  employee: { id: 'employee-1', username: 'writer', display_name: '编剧甲', role: 'employee' as const, profile: 'studio-employee' }, sessions: []
}
const session = { id: 'chat-1', title: '第一场' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  $employeeViewer.set({ group, session, entries: [{ id: 'reply', role: 'assistant', text: '已完成。\n\n```studio-suggestions\n[{"label":"检查","prompt":"请检查当前内容。"}]\n```', calls: [] }], loading: false, error: '' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetEmployeeConversations() })

test('只读员工会话剥离建议协议，避免把不可操作的 JSON 展示给管理员', () => {
  render(<EmployeeConversationViewer />)

  expect(screen.getByText(/已完成。/)).toBeTruthy()
  expect(screen.queryByText(/studio-suggestions|请检查当前内容/)).toBeNull()
})

test('员工只读创作步骤使用业务工具名称并脱敏原始回执', () => {
  $employeeViewer.set({ group, session, entries: [{ id: 'activity', role: 'activity', text: '', calls: [{
    id: 'call-1', name: 'read_file', label: 'read_file', state: 'error', resultSummary: '内部 provider grok-4.7 失败'
  }] }], loading: false, error: '' })
  render(<EmployeeConversationViewer />)

  fireEvent.click(screen.getByText(/创作步骤/))
  expect(screen.getByText('未能阅读资料 · 操作未完成，请稍后重试。')).toBeTruthy()
  expect(screen.queryByText(/read_file|provider|grok-4\.7/)).toBeNull()
})

test('员工查看错误不把服务端内部信息直接显示给管理员', () => {
  $employeeViewer.set({ group, session, entries: [], loading: false, error: '内部 provider grok-4.7 请求失败，详见 https://private.invalid' })
  render(<EmployeeConversationViewer />)

  expect(screen.getByRole('alert').textContent).toBe('员工对话暂时无法读取。')
  expect(screen.queryByText(/provider|grok-4\.7|private\.invalid/)).toBeNull()
})

test('员工成功步骤的内部回执仅显示通用完成摘要', () => {
  $employeeViewer.set({ group, session, entries: [{ id: 'activity', role: 'activity', text: '', calls: [{
    id: 'call-2', name: 'read_file', label: 'read_file', state: 'complete', resultSummary: '已使用 provider grok-4.7 完成'
  }] }], loading: false, error: '' })
  render(<EmployeeConversationViewer />)

  fireEvent.click(screen.getByText(/创作步骤/))
  expect(screen.getByText('已阅读资料')).toBeTruthy()
  expect(screen.queryByText(/provider|grok-4\.7/)).toBeNull()
})
