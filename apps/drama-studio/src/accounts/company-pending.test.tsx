import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { UsersPanel } from './UsersPanel'
import { clearAuthentication, type StudioUser } from './api'

const root: StudioUser = { id: 'root', username: 'root', display_name: '系统管理员', role: 'super_admin', enabled: true, created_at: '2026-10-01T00:00:00Z', profile: 'jubao-drama',
  organization_policy: true, organization: 'unassigned', auth_source: 'local', managed_organizations: [] }
const removed: StudioUser = { ...root, id: 'removed', username: 'gone', display_name: '离职员工', role: 'employee', enabled: false, profile: 'gone', organization: 'hangzhou',
  auth_source: 'company', company_removed_at: '2026-11-09T04:40:00Z', company_sync_disabled: true }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => { cleanup(); clearAuthentication(); vi.unstubAllGlobals() })

test('同步建号后刷新人员列表，管理员为待分配员工选公司建号，已删除员工带标注', async () => {
  const calls: string[] = []
  let users = [root, removed], posted: unknown
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === '/studio/admin/users') return json({ users })
    if (url === '/studio/admin/company-employees' && init?.method === 'POST') {
      posted = JSON.parse(String(init.body))
      return json({ user: { ...removed, id: 'new', username: '18223922979', display_name: '混合部门新人', enabled: true, organization: 'chongqing', company_removed_at: undefined, company_sync_disabled: undefined } }, 201)
    }
    if (url === '/studio/admin/company-employees') {
      users = [...users, { ...removed, id: 'auto', username: 'auto', display_name: '自动建号', enabled: true, company_removed_at: undefined, company_sync_disabled: undefined }]
      return json({ available: true, changed: true, employees: [{ employee_id: '375', name: '混合部门新人', account: '18223922979', department_name: '编剧七部', position_name: '编剧',
        department_organizations: ['chongqing', 'hangzhou'], username_conflict: false }] })
    }
    throw new Error(`测试中不应请求此接口：${url}`)
  })
  render(<UsersPanel actor={root} />)
  const panel = (await screen.findByRole('heading', { name: '待分配的公司员工（1）' })).closest('section')!
  expect(within(panel).getByText('同部门已有：重庆、横店')).toBeTruthy()
  await screen.findByText('自动建号')
  expect(calls.filter(call => call === 'GET /studio/admin/users').length).toBe(2)
  expect(screen.getByText('公司后台已删除，已自动停用，资料保留')).toBeTruthy()
  const create = within(panel).getByRole('button', { name: '为混合部门新人创建账号' }) as HTMLButtonElement
  expect(create.disabled).toBe(true)
  fireEvent.change(within(panel).getByLabelText('混合部门新人的所属公司'), { target: { value: 'chongqing' } })
  fireEvent.click(create)
  await screen.findByText('已为 混合部门新人 创建重庆账号，员工现在可以用公司账号直接登录。')
  expect(posted).toEqual({ employee_id: '375', organization: 'chongqing' })
  await waitFor(() => expect(screen.queryByRole('heading', { name: /待分配的公司员工/ })).toBeNull())
  expect(screen.getByText('18223922979')).toBeTruthy()
})

test('公司目录读取失败只在区块内提示，人员列表照常显示', async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/studio/admin/users') return json({ users: [root] })
    if (url === '/studio/admin/company-employees') return json({ error: '暂时无法读取公司员工目录，请检查公司后台应用授权。' }, 503)
    throw new Error(`测试中不应请求此接口：${url}`)
  })
  render(<UsersPanel actor={root} />)
  expect((await screen.findByRole('alert')).textContent).toBe('暂时无法读取公司员工目录，请检查公司后台应用授权。')
  expect(await screen.findByText('root')).toBeTruthy()
})
