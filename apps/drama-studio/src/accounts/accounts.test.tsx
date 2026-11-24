import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthGate } from './AuthGate'
import { AccountsSettings } from './AccountsSettings'
import { $currentUser, clearAuthentication, loadCurrentUser, logout, studioRequest, type StudioUser } from './api'

const root: StudioUser = { id: 'root-id', username: 'root', display_name: '负责人', role: 'super_admin', enabled: true, created_at: '2026-10-04T08:00:00Z', profile: 'default' }
const admin: StudioUser = { ...root, id: 'admin-id', username: 'manager', display_name: '主编', role: 'admin', profile: 'studio-admin' }
const employee: StudioUser = { ...root, id: 'writer-id', username: 'writer', display_name: '编剧', role: 'employee', profile: 'studio-writer' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  clearAuthentication()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
})
afterEach(() => { cleanup(); clearAuthentication(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test.each(['http', 'socket'])('%s 确认会话到期后，登录页显示到期原因', async channel => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/studio/auth/me') return json({ user: root, csrfToken: 'expiry-csrf', expiresAt: 2_000 })
    if (url === '/studio/account') return json({ error: '请先登录巨豹智能体。' }, 401)
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  render(<AuthGate><div>创作工作区已打开</div></AuthGate>)
  await screen.findByText('创作工作区已打开')
  expect(screen.queryByRole('alert')).toBeNull()
  clock.mockReturnValue(2_000)
  await act(async () => {
    if (channel === 'http') await expect(studioRequest('/account')).rejects.toThrow()
    else window.dispatchEvent(new Event('studio:auth-expired'))
  })
  expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toBe('你长时间未登录，请重新登录。')
  expect(screen.queryByText('创作工作区已打开')).toBeNull()
})

test.each([employee, admin])('$role 在登录页补填一次性激活码后进入工作区，账号密码重登可留空', async account => {
  const payloads: Record<string, string>[] = []
  let activated = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return json({ user: null })
    if (url === '/studio/auth/logout') return json({ ok: true })
    if (url === '/studio/auth/login') {
      const body = JSON.parse(String(init?.body)); payloads.push(body)
      if (!activated && body.activation_code !== 'JB-FIXTURE-CODE') return json({ error: '账号尚未激活，请填写一次性激活码。' }, 403)
      activated = true
      return json({ user: { ...account, activated_at: '2026-10-06T00:00:00Z', activation_required: false }, csrfToken: 'fixture-csrf' })
    }
    throw new Error('不应请求其他接口')
  })
  render(<AuthGate><div>员工创作区</div></AuthGate>)
  fireEvent.change(await screen.findByLabelText('账号'), { target: { value: account.username } })
  fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'fixture-password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('员工创作区')).toBeNull()
  fireEvent.change(screen.getByLabelText('绑定机器 ID'), { target: { value: 'JB-FIXTURE-CODE' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByText('员工创作区')
  expect(payloads.at(-1)).toEqual({ username: account.username, password: 'fixture-password', activation_code: 'JB-FIXTURE-CODE' })
  await act(async () => { await logout() })
  expect((screen.getByLabelText('绑定机器 ID') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: account.username } })
  fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'fixture-password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByText('员工创作区')
  expect(payloads.at(-1)?.activation_code).toBeUndefined()
})

test('超级管理员重新打开仍可查看完整码，并可删除记录，其他角色没有管理入口', async () => {
  let current = admin
  let generated = false
  let deleted = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return json({ user: current, csrfToken: 'activation-csrf' })
    if (url === '/studio/admin/users') return json({ users: [current, employee] })
    if (url === '/studio/admin/activation-codes') {
      if (init?.method === 'POST') { generated = true; expect(new Headers(init.headers).get('X-Studio-CSRF')).toBe('activation-csrf'); return json({ code: 'JB-SECRET-FIXTURE-CODE', activation_code: { id: 'code-a', code: 'JB-SECRET-FIXTURE-CODE', suffix: 'RE-CODE', status: 'unused', created_at: '2026-10-06T00:00:00Z', used_at: null, used_by: null } }) }
      return json({ codes: generated && !deleted ? [{ id: 'code-a', code: 'JB-SECRET-FIXTURE-CODE', suffix: 'RE-CODE', status: 'unused', created_at: '2026-10-06T00:00:00Z', used_at: null, used_by: null }] : [] })
    }
    if (url === '/studio/admin/activation-codes/code-a' && init?.method === 'DELETE') { deleted = true; expect(new Headers(init.headers).get('X-Studio-CSRF')).toBe('activation-csrf'); return json({ ok: true, deleted: 'code-a' }) }
    throw new Error('不应请求其他接口')
  })
  await loadCurrentUser()
  render(<AccountsSettings onClose={() => {}} />)
  expect(screen.queryByRole('button', { name: '激活码管理' })).toBeNull()
  await act(async () => { current = root; await loadCurrentUser() })
  fireEvent.click(screen.getByRole('button', { name: '激活码管理' }))
  await screen.findByText('暂无激活码，点击上方按钮生成。')
  fireEvent.click(await screen.findByRole('button', { name: '生成激活码' }))
  expect((await screen.findByLabelText('激活码 RE-CODE') as HTMLInputElement).value).toBe('JB-SECRET-FIXTURE-CODE')
  fireEvent.click(screen.getByRole('button', { name: '个人账号' }))
  fireEvent.click(screen.getByRole('button', { name: '激活码管理' }))
  await screen.findByText('未使用')
  expect((screen.getByLabelText('激活码 RE-CODE') as HTMLInputElement).value).toBe('JB-SECRET-FIXTURE-CODE')
  expect(screen.getByRole('button', { name: '复制激活码 RE-CODE' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '删除激活码 RE-CODE' }))
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.queryByLabelText('激活码 RE-CODE')).toBeNull())
  await act(async () => { current = employee; await loadCurrentUser() })
  expect(screen.queryByRole('button', { name: '激活码管理' })).toBeNull()
})

test.each(['连接通知先到', '退出响应先到'])('未登录时保护创作区，登录失败保留表单，成功后接入账号并在退出后清除（%s）', async order => {
  let signedIn = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return json({ user: signedIn ? root : null, csrfToken: signedIn ? 'test-csrf' : '', expiresAt: signedIn ? Date.now() + 60_000 : undefined })
    if (url === '/studio/auth/login') {
      const body = JSON.parse(String(init?.body))
      if (body.username !== 'root' || body.password !== 'fixture-password') return json({ error: '账号或密码不正确' }, 401)
      signedIn = true
      return json({ user: root, csrfToken: 'test-csrf', expiresAt: Date.now() + 60_000 })
    }
    if (url === '/studio/auth/logout') {
      if (new Headers(init?.headers).get('X-Studio-CSRF') !== 'test-csrf') return json({ error: '请求无效' }, 403)
      signedIn = false
      if (order === '连接通知先到') window.dispatchEvent(new Event('studio:auth-expired'))
      return json({ ok: true })
    }
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  render(<AuthGate><div>创作工作区已打开</div></AuthGate>)
  expect(screen.queryByText('创作工作区已打开')).toBeNull()
  const username = await screen.findByLabelText('账号')
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(username, { target: { value: 'root' } })
  fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'wrong-password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '账号或密码不正确')
  expect((username as HTMLInputElement).value).toBe('root')
  expect(screen.queryByText('创作工作区已打开')).toBeNull()
  fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'fixture-password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByText('创作工作区已打开')
  expect($currentUser.get()?.id).toBe(root.id)
  await act(async () => { window.dispatchEvent(new Event('studio:auth-expired')) })
  expect(screen.getByRole('alert').textContent).toBe('登录已失效，请重新登录。')
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'root' } })
  fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'fixture-password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByText('创作工作区已打开')
  await act(async () => {
    if (order === '连接通知先到') await expect(logout()).rejects.toThrow('登录状态已变化')
    else await logout()
  })
  expect(screen.queryByText('创作工作区已打开')).toBeNull()
  await screen.findByRole('button', { name: '登录' })
  await act(async () => { window.dispatchEvent(new Event('studio:auth-expired')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

test('人员表单遵守角色边界，创建的员工进入列表，员工只有个人账号入口', async () => {
  let current = admin
  const users = [root, admin, employee]
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return json({ user: current, csrfToken: 'staff-csrf' })
    if (url === '/studio/admin/users' && (!init?.method || init.method === 'GET')) return json({ users })
    if (url === '/studio/admin/users' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      if (new Headers(init.headers).get('X-Studio-CSRF') !== 'staff-csrf' || body.role !== 'employee') return json({ error: '没有权限执行此操作' }, 403)
      const created: StudioUser = { ...employee, id: 'new-writer-id', username: body.username, display_name: body.display_name }
      users.push(created)
      return json({ user: created })
    }
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  await loadCurrentUser()
  const view = render(<AccountsSettings onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '人员管理' }))
  const rootRow = (await screen.findByText('负责人')).closest('tr')!
  expect(within(rootRow).queryByRole('button', { name: '停用' })).toBeNull()
  expect(within(rootRow).queryByRole('button', { name: '编辑' })).toBeNull()
  const adminRow = screen.getByText('manager').closest('tr')!
  expect(within(adminRow).queryByRole('button', { name: '停用' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '创建账号' }))
  expect(screen.queryByRole('radio', { name: '管理员' })).toBeNull()
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'new_writer' } })
  fireEvent.change(screen.getByLabelText('姓名 / 备注'), { target: { value: '新编剧' } })
  fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'new-fixture-password' } })
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
  const newRow = (await screen.findByText('new_writer')).closest('tr')!
  expect(within(newRow).getByText('新编剧')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索人员' }), { target: { value: 'new_writer' } })
  expect(screen.queryByText('负责人')).toBeNull()
  expect(screen.getByText('new_writer')).toBeTruthy()
  view.unmount()
  current = employee
  await loadCurrentUser()
  render(<AccountsSettings onClose={() => {}} />)
  expect(screen.queryByRole('button', { name: '人员管理' })).toBeNull()
  expect(screen.getByRole('heading', { name: '个人账号' })).toBeTruthy()
  await waitFor(() => expect((screen.getByLabelText('昵称') as HTMLInputElement).value).toBe('编剧'))
})

test('设置等待退出动效完成再关闭，Escape 与关闭按钮遵守同一生命周期', async () => {
  $currentUser.set(employee)
  const onClose = vi.fn()
  const view = render(<AccountsSettings onClose={onClose} />)
  const dialog = screen.getByRole('dialog') as HTMLDialogElement
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  dialog.getAnimations = () => [{ finished } as unknown as Animation]
  const cancel = new Event('cancel', { cancelable: true })
  fireEvent(dialog, cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(dialog.open).toBe(true)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  expect(dialog.open).toBe(true)
  await act(async () => { finish(); await finished })
  expect(dialog.open).toBe(false)
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
})

test('没有退出动画时设置可以立即关闭，不依赖动画结束事件', async () => {
  $currentUser.set(employee)
  const onClose = vi.fn()
  render(<AccountsSettings onClose={onClose} />)
  const dialog = screen.getByRole('dialog') as HTMLDialogElement
  dialog.getAnimations = () => []
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  expect(dialog.open).toBe(false)
  expect(onClose).toHaveBeenCalledOnce()
})

test('停用的模型接入在后台标出，绑定到它的品牌入口提示改选', async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/studio/auth/me') return json({ user: root, csrfToken: 'paused-csrf' })
    if (url === '/studio/admin/users') return json({ users: [root] })
    if (url === '/studio/admin/models') return json({ endpoints: [{ id: 'paused', name: 'GPT', base_url: 'https://paused.example/v1', model: 'paused-model', models: ['paused-model'], api_mode: 'codex_responses', has_api_key: true, enabled: false }] })
    if (url === '/studio/admin/model-names') return json({ models: [{ id: 'brand-text-1', kind: 'text', provider: 'paused', model: 'paused-model', display_name: '巨豹满血版 V1.1', visible: true }], targets: [], disabled_targets: [{ provider: 'paused', provider_name: 'GPT' }] })
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  await loadCurrentUser()
  render(<AccountsSettings onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '模型接入' }))
  expect((await screen.findByRole('heading', { name: /GPT/ })).textContent).toContain('已停用')
  await screen.findByText('接入「GPT」已停用，员工看不到这个入口。请改选已启用的接入，或删除该入口。')
})

test('接入卡片可停用和重新启用，默认接入不提供停用按钮，失败原因原样提示', async () => {
  const toggles: unknown[] = []
  let endpoints = [
    { id: 'base', name: '默认 GPT', base_url: 'https://base.example/v1', model: 'base-model', models: ['base-model'], api_mode: 'chat_completions', has_api_key: true, is_current: true, enabled: true },
    { id: 'proxy', name: '代理谷歌官key', base_url: 'http://127.0.0.1:18080/v1beta/openai', model: 'gemini-4-hydrogen', models: ['gemini-4-hydrogen'], api_mode: 'chat_completions', has_api_key: true, enabled: true }
  ]
  let refuse = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return json({ user: root, csrfToken: 'toggle-csrf' })
    if (url === '/studio/admin/users') return json({ users: [root] })
    if (url === '/studio/admin/models') return json({ endpoints })
    if (url === '/studio/admin/model-names') return json({ models: [], targets: [] })
    if (url === '/studio/admin/models/enabled') {
      const body = JSON.parse(String(init?.body)); toggles.push(body)
      if (refuse) return json({ error: '停用后员工将没有可用的文字模型入口。' }, 400)
      endpoints = endpoints.map(row => row.id === body.id ? { ...row, enabled: body.enabled } : row)
      return json({ ok: true, endpoints, message: body.enabled ? '已启用「代理谷歌官key」。' : '已停用「代理谷歌官key」。' })
    }
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  await loadCurrentUser()
  render(<AccountsSettings onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '模型接入' }))
  await screen.findByRole('heading', { name: /代理谷歌官key/ })
  expect(screen.queryByRole('switch', { name: /默认 GPT/ })).toBeNull()
  expect(screen.getByText('默认接入')).toBeTruthy()
  const changed = vi.fn(); window.addEventListener('studio:models-changed', changed)
  fireEvent.click(screen.getByRole('switch', { name: '停用代理谷歌官key' }))
  await screen.findByText('已停用「代理谷歌官key」。')
  expect((await screen.findByRole('heading', { name: /代理谷歌官key/ })).textContent).toContain('已停用')
  expect(screen.getByRole('switch', { name: '启用代理谷歌官key' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('switch', { name: '启用代理谷歌官key' }))
  await screen.findByText('已启用「代理谷歌官key」。')
  expect(screen.getByRole('heading', { name: /代理谷歌官key/ }).textContent).not.toContain('已停用')
  refuse = true
  fireEvent.click(screen.getByRole('switch', { name: '停用代理谷歌官key' }))
  await screen.findByText('停用后员工将没有可用的文字模型入口。')
  expect(screen.getByRole('switch', { name: '停用代理谷歌官key' }).getAttribute('aria-checked')).toBe('true')
  expect(toggles).toEqual([{ id: 'proxy', enabled: false }, { id: 'proxy', enabled: true }, { id: 'proxy', enabled: false }])
  expect(changed).toHaveBeenCalledTimes(2)
  window.removeEventListener('studio:models-changed', changed)
})

test('模型接入仅超级管理员可见，保存后清空密钥并展示已配置状态', async () => {
  let current = admin
  const saved: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return json({ user: current, csrfToken: 'models-csrf' })
    if (url === '/studio/admin/users') return json({ users: [current] })
    if (url === '/studio/admin/models') {
      if (init?.method === 'POST') {
        saved.push(JSON.parse(String(init.body)))
        return json({ ok: true, endpoints: [{ id: 'writer', name: '写作接口', base_url: 'https://models.example/v1', model: 'writer-model', models: ['writer-model'], api_mode: 'chat_completions', has_api_key: true }], message: '模型接入已保存' })
      }
      return json({ endpoints: [] })
    }
    throw new Error(`测试中没有实现此接口：${url}`)
  })
  await loadCurrentUser()
  const view = render(<AccountsSettings onClose={() => {}} />)
  expect(screen.queryByRole('button', { name: '模型接入' })).toBeNull()
  await act(async () => { current = root; await loadCurrentUser() })
  fireEvent.click(screen.getByRole('button', { name: '模型接入' }))
  await screen.findByRole('button', { name: '新增接入' })
  fireEvent.click(screen.getByRole('button', { name: '新增接入' }))
  fireEvent.change(screen.getByLabelText('接入名称'), { target: { value: '写作接口' } })
  fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://models.example/v1' } })
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'writer-model' } })
  fireEvent.change(screen.getByLabelText('模型列表'), { target: { value: 'writer-model' } })
  const key = screen.getByLabelText('API Key') as HTMLInputElement
  expect(key.type).toBe('password')
  fireEvent.change(key, { target: { value: 'fixture-secret-never-persisted-in-ui' } })
  fireEvent.click(screen.getByRole('button', { name: '保存接入' }))
  await screen.findByText('密钥已配置')
  expect(saved).toHaveLength(1)
  expect(screen.queryByLabelText('API Key')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '编辑写作接口' }))
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
  view.unmount()
  $currentUser.set(employee)
  render(<AccountsSettings onClose={() => {}} />)
  expect(screen.queryByRole('button', { name: '模型接入' })).toBeNull()
})
