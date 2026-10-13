import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { $currentUser, clearAuthentication } from '../accounts/api'
import { $employeeGroups, resetEmployeeConversations } from '../employee-access/api'
import { $sidebar } from '../lib/sidebar'
import { workspace } from '../store/workspace'

afterEach(() => { cleanup(); clearAuthentication(); resetEmployeeConversations(); workspace.reset(); vi.unstubAllGlobals() })

test.each(['super_admin', 'admin'] as const)('%s 在员工对话中按地区折叠，保留授权人员和对话', async role => {
  workspace.reset()
  $currentUser.set({ id: 'viewer', username: 'viewer', display_name: '查看者', role, enabled: true, created_at: '', profile: 'viewer-profile' })
  const project = { id: 'default', title: '我的剧本', pinned: false, hidden: false }
  const sidebar = { project, projects: [project], sessions: [], canReveal: false }
  $sidebar.set({ ...sidebar, loaded: true, busy: false, error: '' })
  $employeeGroups.set([
    { id: 'cq-access', employeeId: 'd64dc6c0-9fc6-4c8f-911c-61957f4a4c63', createdBy: 'viewer', createdAt: '', employee: { id: 'd64dc6c0-9fc6-4c8f-911c-61957f4a4c63', username: 'cq-member', display_name: '重庆成员', role: 'employee', profile: 'cq-profile' }, sessions: [{ id: 'cq-chat', title: '重庆稿件' }] },
    { id: 'hz-access', employeeId: 'hz-member', createdBy: 'viewer', createdAt: '', employee: { id: 'hz-member', username: 'hz-member', display_name: '杭州成员', role: 'employee', profile: 'hz-profile' }, sessions: [{ id: 'hz-chat', title: '杭州稿件' }] }
  ])
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(sidebar), { headers: { 'Content-Type': 'application/json' } }))
  await act(async () => { render(<Sidebar active theme="light" onTheme={() => {}} onSettings={() => {}} onCollapse={() => {}} onSelect={() => {}} />) })
  const chongqing = screen.getByRole('region', { name: '重庆员工对话' })
  const hangzhou = screen.getByRole('region', { name: '横店员工对话' })
  expect(within(chongqing).getByTitle('重庆稿件')).toBeTruthy()
  expect(within(chongqing).queryByText('杭州成员')).toBeNull()
  fireEvent.click(within(chongqing).getByRole('button', { name: '收起重庆分组' }))
  expect(within(chongqing).queryByRole('button', { name: '重庆稿件' })).toBeNull()
  expect(within(hangzhou).getByTitle('杭州稿件')).toBeTruthy()
  fireEvent.click(within(chongqing).getByRole('button', { name: '展开重庆分组' }))
  expect(within(chongqing).getByTitle('重庆稿件')).toBeTruthy()
  expect($employeeGroups.get()).toHaveLength(2)
})
