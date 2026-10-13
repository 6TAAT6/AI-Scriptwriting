import { afterEach, expect, test, vi } from 'vitest'
import { $currentUser, clearAuthentication, loadCurrentUser, refreshCsrfToken, studioRequest, updateAccount, type StudioUser } from './api'

const userA: StudioUser = { id: 'a', username: 'writer_a', display_name: '编剧甲', role: 'employee', enabled: true, created_at: '2026-10-04T08:00:00Z', profile: 'studio-a' }
const userB: StudioUser = { ...userA, id: 'b', username: 'writer_b', display_name: '编剧乙', profile: 'studio-b' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => { clearAuthentication(); vi.unstubAllGlobals() })

test('退出或切换账号后，之前的认证查询、昵称保存和失败响应不能覆盖当前身份', async () => {
  let complete!: (response: Response) => void
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { complete = resolve }))
  const previousLookup = loadCurrentUser()
  clearAuthentication()
  complete(json({ user: userA, csrfToken: 'csrf-a' }))
  await expect(previousLookup).rejects.toThrow('登录状态已变化')
  expect($currentUser.get()).toBeNull()

  vi.stubGlobal('fetch', () => Promise.resolve(json({ user: userA, csrfToken: 'csrf-a' })))
  await loadCurrentUser()
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { complete = resolve }))
  const previousUpdate = updateAccount('迟到的修改')
  const completeUpdate = complete
  const previousUnauthorized = loadCurrentUser()
  const completeUnauthorized = complete
  clearAuthentication()
  vi.stubGlobal('fetch', () => Promise.resolve(json({ user: userB, csrfToken: 'csrf-b' })))
  await loadCurrentUser()
  completeUpdate(json({ user: { ...userA, display_name: '迟到的修改' } }))
  completeUnauthorized(json({ error: '登录已失效' }, 401))
  await expect(previousUpdate).rejects.toThrow('登录状态已变化')
  await expect(previousUnauthorized).rejects.toThrow('登录状态已变化')
  expect($currentUser.get()?.id).toBe('b')
  expect($currentUser.get()?.display_name).toBe('编剧乙')
})

test('旁路管理请求将包含内部服务信息的错误转换为公开文案', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: '内部 provider grok-4.7 请求失败，详见 https://private.invalid' }, 502)))
  await expect(studioRequest('/employee-conversations')).rejects.toThrow('操作暂未完成，请稍后重试。')
  await expect(studioRequest('/employee-conversations')).rejects.not.toThrow(/provider|grok-4\.7|private\.invalid/)
})

test('服务重连更新 CSRF 后，后续写请求使用新值且保留当前账号', async () => {
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    calls += 1
    if (calls === 2) expect((init?.headers as Record<string, string>)?.['X-Studio-CSRF']).toBe('csrf-after-restart')
    return json({ user: userA, csrfToken: 'csrf-after-restart' })
  }))
  await loadCurrentUser()
  refreshCsrfToken('csrf-after-restart')
  await studioRequest('/account', 'PATCH', { display_name: '重连后保存' })
  expect($currentUser.get()?.id).toBe('a')
})
