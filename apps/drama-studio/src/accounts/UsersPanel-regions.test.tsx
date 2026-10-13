import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { UsersPanel } from './UsersPanel'
import { clearAuthentication, type StudioUser } from './api'

const root: StudioUser = { id: 'region-root', username: 'root_fixture', display_name: '负责人', role: 'super_admin', enabled: true, created_at: '2026-10-01T00:00:00Z', profile: 'region-root' }
const manager: StudioUser = { ...root, id: '18311314-470b-471f-a907-199af477d6cb', username: 'cq_manager', display_name: '重庆主编', role: 'admin', profile: 'cq-manager' }
const chongqing: StudioUser = { ...root, id: 'd64dc6c0-9fc6-4c8f-911c-61957f4a4c63', username: 'cq_writer', display_name: '重庆编剧', role: 'employee', profile: 'cq-writer' }
const hangzhou: StudioUser = { ...root, id: 'hz-writer', username: 'hz_writer', display_name: '杭州编剧', role: 'employee', profile: 'hz-writer' }
const otherManager: StudioUser = { ...root, id: 'hz-manager', username: 'hz_manager', display_name: '杭州主编', role: 'admin', profile: 'hz-manager' }
const users = [root, manager, chongqing, hangzhou, otherManager]

beforeEach(() => {
  clearAuthentication()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/studio/admin/users') return new Response(JSON.stringify({ users }), { headers: { 'Content-Type': 'application/json' } })
    throw new Error(`测试中不应请求此接口：${url}`)
  })
})
afterEach(() => { cleanup(); clearAuthentication(); vi.unstubAllGlobals() })

test.each([root, manager])('$role 按地区查看人员时保留全局统计与原有管理权限', async actor => {
  render(<UsersPanel actor={actor} />)
  await screen.findByRole('button', { name: '重庆，2 人' })
  const cqGroup = screen.getByRole('rowgroup', { name: '重庆地区成员' })
  const hzGroup = screen.getByRole('rowgroup', { name: '横店地区成员' })
  expect(within(cqGroup).getByText('cq_manager')).toBeTruthy()
  expect(within(cqGroup).getByText('cq_writer')).toBeTruthy()
  expect(within(cqGroup).queryByText('hz_writer')).toBeNull()
  expect(within(hzGroup).getByText('hz_writer')).toBeTruthy()
  expect(screen.getByText('用户总数').parentElement?.textContent).toBe('用户总数5')
  expect(screen.getByText('共 5 位成员')).toBeTruthy()
  const writerRow = within(cqGroup).getByText('cq_writer').closest('tr')!
  expect(within(writerRow).getByRole('button', { name: '重置密码' })).toBeTruthy()
  expect(within(writerRow).getByRole('button', { name: '停用' })).toBeTruthy()
  expect(within(writerRow).queryByRole('button', { name: '删除' }) !== null).toBe(actor.role === 'super_admin')
  const managerRow = within(hzGroup).getByText('hz_manager').closest('tr')!
  expect(within(managerRow).queryByRole('button', { name: '编辑' }) !== null).toBe(actor.role === 'super_admin')
  fireEvent.click(within(writerRow).getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('heading', { name: '编辑账号' })).toBeTruthy()
  expect((screen.getByLabelText('账号') as HTMLInputElement).value).toBe('cq_writer')
  fireEvent.click(screen.getByRole('button', { name: '返回用户列表' }))
  if (actor.role === 'super_admin') {
    const row = screen.getByText('cq_writer').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    expect(screen.getByRole('dialog', { name: '删除账号' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy()
  }
})

test('地区可独立折叠，搜索自动展开匹配地区并保留原折叠选择', async () => {
  render(<UsersPanel actor={root} />)
  const cqButton = await screen.findByRole('button', { name: '重庆，2 人' })
  expect(cqButton.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(cqButton)
  expect(cqButton.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('cq_writer')).toBeNull()
  expect(screen.getByText('hz_writer')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索人员' }), { target: { value: 'cq_writer' } })
  expect(screen.getByRole('button', { name: '重庆，1 人' }).getAttribute('aria-expanded')).toBe('true')
  expect(within(screen.getByRole('rowgroup', { name: '重庆地区成员' })).getByText('cq_writer')).toBeTruthy()
  expect(screen.queryByText('hz_writer')).toBeNull()
  expect(screen.getByText('已找到 1 位成员，共 5 位')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索人员' }), { target: { value: '' } })
  expect(screen.getByRole('button', { name: '重庆，2 人' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('cq_writer')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重庆，2 人' }))
  expect(screen.getByText('cq_writer')).toBeTruthy()
})
