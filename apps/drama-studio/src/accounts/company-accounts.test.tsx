import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthGate } from './AuthGate'
import { UserEditor } from './UserEditor'
import { $currentUser, canManageUser, clearAuthentication, type StudioUser } from './api'

const manager: StudioUser = { id: 'manager', username: 'company-manager', display_name: '横店经理', profile: 'original-profile', role: 'admin', enabled: true,
  created_at: '2026-10-01', organization_policy: true, organization: 'hangzhou', auth_source: 'company', managed_organizations: ['chongqing'], conversation_organizations: [] }
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup(); clearAuthentication(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

test('新凭证优先清理旧身份，首次激活前保持工作区隐藏，激活后只初始化新身份', async () => {
  const calls: string[] = []
  let resolveLogin!: (response: Response) => void
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(url)
    if (url === '/studio/auth/options') return json({ company: true, organizations: true })
    if (url === '/studio/auth/company/launch') return new Promise<Response>(resolve => { resolveLogin = resolve })
    if (url === '/studio/auth/company/activate') {
      expect(new Headers(init?.headers).get('X-Studio-CSRF')).toBe('pending-csrf')
      expect(JSON.parse(String(init?.body))).toEqual({ activation_code: 'JB-ISOLATED' })
      return json({ user: { ...manager, activation_required: false }, csrfToken: 'ready-csrf' })
    }
    throw new Error('不应恢复旧员工会话')
  })
  $currentUser.set({ ...manager, id: 'old-employee', auth_source: 'local' })
  window.history.replaceState(null, '', '/#launch=' + 'L'.repeat(43))
  const authenticated = vi.fn()
  render(<AuthGate onAuthenticated={authenticated}><div>受保护工作区</div></AuthGate>)
  expect(screen.queryByText('受保护工作区')).toBeNull()
  expect($currentUser.get()).toBeNull()
  expect(window.location.hash).toBe('')
  await act(async () => { resolveLogin(json({ user: { ...manager, activation_required: true }, csrfToken: 'pending-csrf' })) })
  await screen.findByRole('heading', { name: '开通创作工作区' })
  expect(authenticated).not.toHaveBeenCalled()
  expect(screen.queryByText('受保护工作区')).toBeNull()
  fireEvent.change(screen.getByLabelText('绑定机器 ID'), { target: { value: 'JB-ISOLATED' } })
  fireEvent.click(screen.getByRole('button', { name: '激活并进入' }))
  await screen.findByText('受保护工作区')
  await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1))
  expect(authenticated.mock.calls[0][0].id).toBe(manager.id)
  expect(calls).not.toContain('/studio/auth/me')
})

test('管理员沿用原创建与角色限制，员工操作不按公司隐藏且无新增范围编辑入口', async () => {
  const saved = vi.fn()
  let payload: unknown
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    expect(url).toBe('/studio/admin/users')
    payload = JSON.parse(String(init?.body))
    return json({ user: { ...manager, id: 'new-branch', auth_source: 'local', organization: 'chongqing', role: 'employee' } })
  })
  render(<UserEditor actor={manager} mode={{ kind: 'create' }} onCancel={() => {}} onSaved={saved} />)
  expect((screen.getByLabelText('所属公司') as HTMLSelectElement).value).toBe('chongqing')
  expect(screen.queryByRole('radio', { name: '管理员' })).toBeNull()
  expect(screen.queryByText('人员管理范围')).toBeNull()
  expect(canManageUser(manager, { ...manager, id: 'hq-employee', role: 'employee' })).toBe(true)
  expect(canManageUser(manager, { ...manager, id: 'branch-employee', organization: 'chongqing', role: 'employee' })).toBe(true)
  expect(canManageUser(manager, { ...manager, id: 'another-admin', organization: 'chongqing', role: 'admin' })).toBe(false)
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'branch-new' } })
  fireEvent.change(screen.getByLabelText('姓名 / 备注'), { target: { value: '重庆新员工' } })
  fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'fixture-local-password' } })
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  expect(payload).toEqual({ username: 'branch-new', display_name: '重庆新员工', password: 'fixture-local-password', role: 'employee', organization: 'chongqing' })
})
