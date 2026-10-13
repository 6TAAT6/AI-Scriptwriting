import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { $currentUser } from '../accounts/api'
import { $employeeGroups, $employeeViewer, loadEmployeeConversations, openEmployeeConversation, refreshEmployeeConversation, removeEmployeeConversationAccess, resetEmployeeConversations } from './api'

const group = { id: 'access-1', employeeId: 'employee-1', createdBy: 'admin-1', createdAt: '2026-10-09T00:00:00.000Z', employee: { id: 'employee-1', username: 'writer', display_name: '编剧甲', role: 'employee' as const, profile: 'studio-employee' }, sessions: [{ id: 'chat-1', title: '第一场' }] }

beforeEach(() => {
  $currentUser.set({ id: 'admin-1', username: 'admin', display_name: '管理员', role: 'admin', enabled: true, created_at: '', profile: 'studio-admin' })
  resetEmployeeConversations()
})
afterEach(() => { vi.unstubAllGlobals(); $currentUser.set(null); resetEmployeeConversations() })

test('加载员工分组并打开对话时只读映射为可展示的历史条目', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/employee-conversations') ? { groups: [group] } : { messages: [{ role: 'user', row_id: 'm1', text: '员工消息' }, { role: 'assistant', row_id: 'm2', text: '已收到' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  await loadEmployeeConversations()
  expect($employeeGroups.get()).toHaveLength(1)
  await openEmployeeConversation(group, group.sessions[0])
  expect($employeeViewer.get()).toMatchObject({ loading: false, group, session: group.sessions[0] })
  expect($employeeViewer.get().entries.map(entry => [entry.role, entry.text])).toEqual([['user', '员工消息'], ['assistant', '已收到']])
})

test('打开员工会话后刷新会合并员工刚写入的新消息', async () => {
  let latest = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const messages = latest ? [{ role: 'user', row_id: 'm1', text: '员工消息' }, { role: 'assistant', row_id: 'm2', text: '新的回复' }] : [{ role: 'user', row_id: 'm1', text: '员工消息' }]
    return new Response(JSON.stringify(url.includes('/sessions/') ? { messages } : { groups: [group] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  await openEmployeeConversation(group, group.sessions[0])
  latest = true
  await refreshEmployeeConversation()
  expect($employeeViewer.get().entries.map(entry => entry.text)).toEqual(['员工消息', '新的回复'])
})

test('移除查看授权只清除管理员侧分组和当前查看页', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  $employeeGroups.set([group])
  $employeeViewer.set({ group, session: group.sessions[0], entries: [], loading: false, error: '' })
  await removeEmployeeConversationAccess(group.id)
  expect($employeeGroups.get()).toEqual([])
  expect($employeeViewer.get().group).toBeNull()
})
