import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearAuthentication, type StudioUser } from '../accounts/api'
import { EmployeeAccessPanel } from './EmployeeAccessPanel'
import { resetEmployeeConversations, type EmployeeConversationGroup } from './api'

const chongqing: StudioUser = { id: 'd64dc6c0-9fc6-4c8f-911c-61957f4a4c63', username: 'cq-writer', display_name: '重庆员工', role: 'employee', enabled: true, created_at: '2026-10-01T00:00:00Z', profile: 'studio-cq' }
const hangzhou: StudioUser = { ...chongqing, id: 'hangzhou-writer', username: 'hz-writer', display_name: '杭州员工', profile: 'studio-hz' }
const admin: StudioUser = { ...chongqing, id: '18311314-470b-471f-a907-199af477d6cb', username: 'cq-admin', display_name: '重庆管理员', role: 'admin' }
const disabled: StudioUser = { ...hangzhou, id: 'disabled-writer', username: 'disabled', display_name: '停用员工', enabled: false }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const access = (employee: StudioUser): EmployeeConversationGroup => ({ id: `access-${employee.id}`, employeeId: employee.id, createdBy: 'viewer', createdAt: '2026-10-12T00:00:00Z', employee, sessions: [{ id: `session-${employee.id}` }] })

beforeEach(() => { clearAuthentication(); resetEmployeeConversations() })
afterEach(() => { cleanup(); clearAuthentication(); resetEmployeeConversations(); vi.unstubAllGlobals() })

test('地区员工选项保持权限过滤，添加后加入对应分组并隐藏空选项组', async () => {
  const groups: EmployeeConversationGroup[] = []
  const added: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/admin/users') return json({ users: [admin, chongqing, hangzhou, disabled] })
    if (url === '/studio/employee-conversations') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)); added.push(body.employee_id)
        groups.push(access(chongqing))
        return json({ ok: true })
      }
      return json({ groups })
    }
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  render(<EmployeeAccessPanel />)
  await screen.findByRole('option', { name: '重庆员工（cq-writer）' })
  const select = screen.getByRole('combobox', { name: '选择员工' })
  expect(within(select).getByRole('group', { name: '重庆' }).textContent).toBe('重庆员工（cq-writer）')
  expect(within(select).getByRole('group', { name: '横店' }).textContent).toBe('杭州员工（hz-writer）')
  expect(screen.queryByRole('option', { name: /重庆管理员|停用员工/ })).toBeNull()

  fireEvent.change(select, { target: { value: chongqing.id } })
  fireEvent.click(screen.getByRole('button', { name: '添加查看' }))
  await screen.findByText('已添加员工对话查看授权。')
  expect(added).toEqual([chongqing.id])
  expect(screen.getByRole('button', { name: /重庆分组.*1 人/ }).getAttribute('aria-expanded')).toBe('true')
  expect(within(screen.getByRole('rowgroup', { name: '重庆分组' })).getByText('重庆员工')).toBeTruthy()
  expect(within(select).queryByRole('group', { name: '重庆' })).toBeNull()
  expect(within(select).getByRole('group', { name: '横店' })).toBeTruthy()
})

test('地区授权分组默认展开，可分别折叠并正确移除同步异常员工', async () => {
  const cqAccess = { ...access(chongqing), sync_error: '暂时无法同步' }
  const groups = [cqAccess, access(hangzhou)]
  const removed: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/admin/users') return json({ users: [chongqing, hangzhou] })
    if (url === '/studio/employee-conversations') return json({ groups })
    if (url === `/studio/employee-conversations/assignments/${cqAccess.id}` && init?.method === 'DELETE') {
      removed.push(cqAccess.id)
      return json({ ok: true })
    }
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  render(<EmployeeAccessPanel />)
  await screen.findByText('同步中，稍后自动重试')
  const cqToggle = screen.getByRole('button', { name: /重庆分组.*1 人/ })
  const hzToggle = screen.getByRole('button', { name: /横店分组.*1 人/ })
  expect(cqToggle.getAttribute('aria-expanded')).toBe('true')
  expect(hzToggle.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(cqToggle)
  expect(cqToggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('同步中，稍后自动重试')).toBeNull()
  expect(screen.getByText('杭州员工')).toBeTruthy()
  fireEvent.click(cqToggle)
  const cqSection = screen.getByRole('rowgroup', { name: '重庆分组' })
  fireEvent.click(within(cqSection).getByRole('button', { name: '移除查看' }))
  await screen.findByText('已移除对 重庆员工 的查看授权。')
  expect(removed).toEqual([cqAccess.id])
  await waitFor(() => expect(screen.getByRole('button', { name: /重庆分组.*0 人/ })).toBeTruthy())
  expect(within(cqSection).queryByText('重庆员工')).toBeNull()
  expect(screen.getByRole('button', { name: /横店分组.*1 人/ })).toBeTruthy()
  expect(screen.getByRole('option', { name: '重庆员工（cq-writer）' })).toBeTruthy()
})
