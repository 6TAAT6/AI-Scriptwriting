import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { $authenticationNotice, $currentUser, clearAuthentication, loadCurrentUser, type StudioUser } from '../accounts/api'
import { workspace } from '../store/workspace'
import { MaintenanceGate } from './MaintenanceGate'
import { readMaintenanceDraft, restoreMaintenanceDraft } from './drafts'

const user: StudioUser = { id: 'member-a', username: 'member-a', display_name: '成员甲', role: 'employee', enabled: true, created_at: '', profile: 'profile-a' }
function Screen() { return useStore($currentUser) ? <p>当前工作区</p> : <p>登录页</p> }

afterEach(() => { cleanup(); workspace.reset(); workspace.api.profile = 'jubao-drama'; $currentUser.set(null); $authenticationNotice.set(''); sessionStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers() })

test('任一维护阶段先保存草稿再主动退出，断开WS也退到登录页，解除后只恢复原账号', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T04:00:00Z'))
  workspace.reset(); workspace.api.profile = user.profile; $currentUser.set(user)
  workspace.session.set({ storedId: 'saved-a', runtimeId: 'old-runtime', info: {} })
  workspace.connection.set('closed')
  workspace.composer.set({ ...workspace.composer.get(), text: '尚未发送的创作要求' })
  let state = { id: '', phase: 'inactive', version: '', message: '', deadline: null as string | null }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async path => new Response(JSON.stringify(path === '/studio/auth/me' ? { user: null } : state), { headers: { 'Content-Type': 'application/json' } }))
  const rpc = vi.spyOn(workspace.api, 'rpc')
  render(<MaintenanceGate><Screen /></MaintenanceGate>)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  await act(async () => { workspace.newConversation('empty-project') })
  expect(workspace.composer.get().text).toBe('')
  await act(async () => { clearAuthentication('系统维护中，结束后请重新登录。'); workspace.reset() })
  await act(async () => {
    workspace.api.profile = user.profile; $currentUser.set(user)
    workspace.session.set({ storedId: 'saved-a', runtimeId: 'restored-runtime', info: {} })
    workspace.connection.set('open')
  })
  expect(workspace.composer.get().text).toBe('尚未发送的创作要求')
  await act(async () => { workspace.connection.set('closed') })
  const clearing = vi.fn(() => expect(readMaintenanceDraft(user)?.composer.text).toBe('尚未发送的创作要求'))
  window.addEventListener('studio:auth-clearing', clearing)
  const blockedStorage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage unavailable') })
  state = { id: 'maint-1', phase: 'announced', version: 'v2.2.2', message: '系统即将维护，稍后暂停新提交。', deadline: '2026-10-26T04:02:00Z' }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByRole('alertdialog').textContent).toContain('系统即将维护，稍后暂停新提交。')
  expect(screen.getByRole('alertdialog').textContent).not.toContain('当前进度已自动保存')
  expect($currentUser.get()).toBeNull()
  expect($authenticationNotice.get()).toBe('系统维护中，结束后请重新登录。')
  expect(clearing).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: '知道了' })).toBeNull()
  const announced = screen.getByRole('alertdialog')
  fireEvent.keyDown(announced, { key: 'Escape' }); fireEvent.click(announced.parentElement!)
  expect(screen.getByRole('alertdialog')).toBe(announced)
  expect(screen.getByText(/距离维护还有/).textContent).toContain('1 分 55 秒')
  expect(screen.queryByText('当前工作区')).toBeNull()
  expect(screen.getByText('登录页')).toBeTruthy()
  expect(screen.getByRole('alertdialog').textContent).toContain('草稿已暂存在当前页面，请保留页面，维护后重新登录恢复。')
  expect(screen.getByRole('alertdialog').textContent).toContain('系统即将维护，稍后暂停新提交。')
  expect(screen.getByRole('alertdialog').textContent).not.toContain('当前进度已自动保存')
  expect(screen.getByRole('alertdialog').textContent).not.toMatch(/请先复制|手动保存/)
  blockedStorage.mockRestore()
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByRole('alertdialog').textContent).toContain('系统即将维护，稍后暂停新提交。')
  expect(screen.getByRole('alertdialog').textContent).not.toContain('当前进度已自动保存')
  await act(async () => { await loadCurrentUser(); workspace.reset() })
  expect(clearing).toHaveBeenCalledTimes(1)
  state = { ...state, phase: 'paused', message: '系统维护中，请稍后重新登录。' }
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
  expect($currentUser.get()).toBeNull()
  expect(screen.getByRole('alertdialog').textContent).toContain('系统维护中，请稍后重新登录。')
  expect(screen.getByRole('alertdialog').textContent).not.toContain('当前进度已自动保存')
  expect(screen.getByRole('alertdialog').textContent).toContain('草稿')
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  state = { id: '', phase: 'inactive', version: '', message: '', deadline: null }
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByText('登录页').closest('.maintenance-content')?.hasAttribute('inert')).toBe(false)
  expect(screen.queryByRole('button', { name: '继续使用' })).toBeNull()
  expect($authenticationNotice.get()).toContain('维护已结束')
  expect(clearing).toHaveBeenCalledTimes(1)
  window.removeEventListener('studio:auth-clearing', clearing)
  const other = { ...user, id: 'member-b', profile: 'profile-b' }
  await act(async () => { workspace.api.profile = other.profile; $currentUser.set(other); workspace.connection.set('open') })
  expect(restoreMaintenanceDraft(other)).toBe(false)
  expect(workspace.composer.get().text).toBe('')
  expect($currentUser.get()?.id).toBe(other.id)
  await act(async () => {
    workspace.reset(); workspace.api.profile = user.profile; $currentUser.set(user)
    workspace.session.set({ storedId: 'saved-a', runtimeId: 'new-runtime', info: {} })
    workspace.connection.set('open')
  })
  expect(workspace.composer.get().text).toBe('尚未发送的创作要求')
  expect(workspace.composer.get().busy).toBe(false)
  expect($currentUser.get()?.id).toBe(user.id)
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
  expect($currentUser.get()?.id).toBe(user.id)
  expect(clearing).toHaveBeenCalledTimes(1)
  window.addEventListener('studio:auth-clearing', clearing)
  state = { id: 'maint-1', phase: 'paused', version: 'v2.2.2', message: '新一轮维护中。', deadline: null }
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
  expect($currentUser.get()).toBeNull()
  expect(clearing).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(clearing).toHaveBeenCalledTimes(2)
  window.removeEventListener('studio:auth-clearing', clearing)
  expect(rpc).not.toHaveBeenCalled()
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})
