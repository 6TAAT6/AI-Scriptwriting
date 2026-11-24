import { afterEach, expect, test, vi } from 'vitest'
import { $authenticationNotice, $currentUser, clearAuthentication, loadCurrentUser, type StudioUser } from '../accounts/api'
import { CAPABILITIES } from '../lib/capabilities'
import { $selectedSidebarProjectId } from '../lib/sidebar'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { captureMaintenanceDraft, discardMaintenanceDraft, readMaintenanceDraft, restoreMaintenanceDraft } from './drafts'

const user: StudioUser = { id: 'member-a', username: 'member-a', display_name: '成员甲', role: 'employee', enabled: true, created_at: '', profile: 'profile-a' }

afterEach(() => { workspace.reset(); workspace.api.profile = 'jubao-drama'; $currentUser.set(null); $authenticationNotice.set(''); sessionStorage.clear(); vi.restoreAllMocks() })

test('维护草稿仅由同账号同profile恢复一次，保留附件与选择但绝不发送或恢复忙碌态', async () => {
  sessionStorage.clear(); workspace.reset(); workspace.api.profile = user.profile; $currentUser.set(user)
  workspace.session.set({ storedId: 'saved-a', runtimeId: 'old-runtime', info: {} })
  workspace.composer.set({ ...workspace.composer.get(), text: '继续改写第三集', busy: true,
    attachments: [{ attached: true, uploaded: true, name: '原稿.txt', path: '/owned/a.txt', ref_path: '/owned/a.txt', ref_text: '@file:`/owned/a.txt`' }],
    capabilityCommands: [{ action: '调用', capability: CAPABILITIES[0] }] })
  expect(captureMaintenanceDraft(user)).toBe('saved')
  const saved = readMaintenanceDraft(user)
  expect(saved?.storedId).toBe('saved-a')
  const serialized = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i)!)).join('')
  expect(serialized).not.toMatch(/csrf|token|password|apiKey/i)
  const clearing = vi.fn()
  window.addEventListener('studio:auth-clearing', clearing)
  clearAuthentication('系统维护中，结束后请重新登录。'); workspace.reset()
  window.removeEventListener('studio:auth-clearing', clearing)
  expect(clearing).toHaveBeenCalledTimes(1)
  expect($currentUser.get()).toBeNull()
  expect($authenticationNotice.get()).toBe('系统维护中，结束后请重新登录。')
  const rpc = vi.spyOn(workspace.api, 'rpc')
  const other = { ...user, id: 'member-b', profile: 'profile-b' }
  $currentUser.set(other)
  expect(restoreMaintenanceDraft(other)).toBe(false)
  expect(restoreMaintenanceDraft({ ...user, profile: 'another-profile' })).toBe(false)
  expect(workspace.composer.get().text).toBe('')
  $currentUser.set(user)
  workspace.session.set({ storedId: 'saved-a', runtimeId: 'new-runtime', info: {} })
  workspace.composer.set({ ...workspace.composer.get(), text: '维护后的新草稿' })
  expect(restoreMaintenanceDraft(user)).toBe(false)
  expect(workspace.composer.get().text).toBe('维护后的新草稿')
  workspace.composer.set({ ...workspace.composer.get(), text: '', attachments: [{ attached: true, uploaded: true, name: '新附件.txt', path: '/owned/new.txt', ref_path: '/owned/new.txt', ref_text: '@file:`/owned/new.txt`' }] })
  expect(restoreMaintenanceDraft(user)).toBe(false)
  expect(workspace.composer.get().attachments[0].name).toBe('新附件.txt')
  workspace.composer.set({ ...workspace.composer.get(), attachments: [], busy: true })
  expect(restoreMaintenanceDraft(user)).toBe(false)
  expect(workspace.composer.get().busy).toBe(true)
  workspace.composer.set({ ...workspace.composer.get(), busy: false })
  expect(restoreMaintenanceDraft(user)).toBe(true)
  expect(workspace.composer.get()).toMatchObject({ text: '继续改写第三集', busy: false, attachments: [{ name: '原稿.txt', ref_path: '/owned/a.txt' }] })
  expect(workspace.composer.get().capabilityCommands?.[0].capability.id).toBe(CAPABILITIES[0].id)
  workspace.composer.set({ ...workspace.composer.get(), text: '登录后的新输入' })
  expect(restoreMaintenanceDraft(user)).toBe(false)
  expect(workspace.composer.get().text).toBe('登录后的新输入')
  workspace.newConversation('project-a')
  workspace.editComposer({ text: '新项目的草稿' })
  expect(captureMaintenanceDraft(user)).toBe('saved')
  workspace.composer.set({ ...workspace.composer.get(), text: '', attachments: [], capabilityCommands: [] })
  $selectedSidebarProjectId.set('project-b')
  expect(restoreMaintenanceDraft(user)).toBe(false)
  $selectedSidebarProjectId.set('project-a')
  expect(restoreMaintenanceDraft(user)).toBe(true)
  const swapping = vi.fn()
  window.addEventListener('studio:auth-clearing', swapping)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user: other, csrfToken: 'fixture' })))
  await loadCurrentUser()
  expect(swapping).toHaveBeenCalledTimes(1)
  expect(readMaintenanceDraft(other)).toBeNull()
  clearAuthentication()
  expect(swapping).toHaveBeenCalledTimes(2)
  window.removeEventListener('studio:auth-clearing', swapping)
  expect(rpc).not.toHaveBeenCalled()
})

function historyOnly(aliases: Record<string, string> = {}) {
  vi.spyOn(workspace.api, 'materials').mockResolvedValue({ project: null, sources: [] })
  return vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method === 'session.resume') {
      const id = String((params as { session_id: string }).session_id)
      return { session_id: `runtime-${aliases[id] || id}`, stored_session_id: aliases[id] || id, info: {}, messages: [], running: false }
    }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'session.events.since') return { events: [], open_requests: [] }
    throw new Error('草稿恢复不得提交或创建任务：' + method)
  }) as WorkspaceApi['rpc'])
}

test('维护保存全部会话草稿，空reset不覆盖旧副本，明确清空与后台删除不会幽灵恢复', async () => {
  const owner = { ...user, id: 'multi-owner', profile: 'multi-profile' }
  workspace.reset(); workspace.api.profile = owner.profile; $currentUser.set(owner)
  const aliases: Record<string, string> = {}, rpc = historyOnly(aliases)
  await workspace.open('A'); expect(workspace.session.get().storedId).toBe('A')
  workspace.editComposer({ text: 'A 对话未发送的草稿' })
  await workspace.open('B'); expect(workspace.session.get().storedId).toBe('B')
  workspace.editComposer({ text: 'B 对话未发送的草稿' })
  expect(captureMaintenanceDraft(owner)).toBe('saved')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 48 * 60 * 60 * 1000)
  clearAuthentication('系统维护中'); workspace.reset()
  const other = { ...owner, id: 'other-owner', profile: 'other-profile' }
  workspace.api.profile = other.profile; $currentUser.set(other)
  expect(readMaintenanceDraft(other)).toBeNull()
  workspace.api.profile = owner.profile; $currentUser.set(owner)
  expect(captureMaintenanceDraft(owner)).toBe('saved')
  workspace.session.set({ storedId: 'A2', runtimeId: 'unconfirmed-runtime', info: {} })
  expect(restoreMaintenanceDraft(owner)).toBe(false)
  aliases.A = 'A2'
  await workspace.open('A'); expect(workspace.session.get().storedId).toBe('A2')
  captureMaintenanceDraft(owner)
  expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('A 对话未发送的草稿')
  await workspace.open('B'); expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('B 对话未发送的草稿')
  expect(restoreMaintenanceDraft(owner)).toBe(false)
  workspace.reset(); workspace.api.profile = owner.profile
  aliases.A = 'A3'
  await workspace.open('A'); expect(workspace.session.get().storedId).toBe('A3')
  captureMaintenanceDraft(owner)
  expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('A 对话未发送的草稿')
  workspace.editComposer({ text: '', attachments: [], capabilityCommands: [] })
  await workspace.open('B'); expect(captureMaintenanceDraft(owner)).toBe('saved')
  workspace.forgetConversation('A3')
  expect(captureMaintenanceDraft(owner)).toBe('saved')
  workspace.reset(); workspace.api.profile = owner.profile
  await workspace.open('A'); expect(restoreMaintenanceDraft(owner)).toBe(false)
  expect(workspace.composer.get().text).toBe('')
  workspace.forgetConversation('B'); captureMaintenanceDraft(owner)
  workspace.reset(); workspace.api.profile = owner.profile
  await workspace.open('B'); expect(restoreMaintenanceDraft(owner)).toBe(false)
  expect(workspace.composer.get().text).toBe('')
  await workspace.open('C'); workspace.editComposer({ text: '压缩续接中的 C 草稿' })
  aliases.C = 'C2'; await workspace.open('C')
  aliases.C = 'C3'; await workspace.open('C')
  expect(workspace.composer.get().text).toBe('压缩续接中的 C 草稿')
  captureMaintenanceDraft(owner); workspace.reset(); workspace.api.profile = owner.profile
  aliases.C = 'C4'; await workspace.open('C'); captureMaintenanceDraft(owner)
  expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('压缩续接中的 C 草稿')
  await workspace.open('D'); workspace.editComposer({ text: '旧 D 草稿' })
  await workspace.open('D2'); workspace.editComposer({ text: '新 D2 草稿' })
  captureMaintenanceDraft(owner)
  aliases.D = 'D2'; await workspace.open('D'); captureMaintenanceDraft(owner)
  expect(workspace.composer.get().text).toBe('新 D2 草稿')
  workspace.editComposer({ text: '', attachments: [], capabilityCommands: [] }); captureMaintenanceDraft(owner)
  workspace.reset(); workspace.api.profile = owner.profile
  await workspace.open('D'); captureMaintenanceDraft(owner)
  expect(restoreMaintenanceDraft(owner)).toBe(false)
  expect(workspace.composer.get().text).toBe('')
  workspace.editComposer({ text: '清空后新写的 D2 草稿' }); captureMaintenanceDraft(owner)
  workspace.reset(); workspace.api.profile = owner.profile
  await workspace.open('D'); captureMaintenanceDraft(owner)
  expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('清空后新写的 D2 草稿')
  expect(rpc.mock.calls.some(([method]) => method === 'prompt.submit' || method === 'session.create')).toBe(false)
})

test('存储不可用时全部项目草稿仅内存保留，不谎报持久化，恢复存储后再明确保存', () => {
  const owner = { ...user, id: 'memory-owner', profile: 'memory-profile' }
  workspace.reset(); workspace.api.profile = owner.profile; $currentUser.set(owner)
  workspace.newConversation('project-a'); workspace.editComposer({ text: '项目 A 的草稿' })
  workspace.newConversation('project-b'); workspace.editComposer({ text: '项目 B 的草稿' })
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes('maintenance-draft')) throw new DOMException('容量不足', 'QuotaExceededError')
    return setItem.call(this, key, value)
  })
  expect(captureMaintenanceDraft(owner)).toBe('memory')
  clearAuthentication(); workspace.reset(); workspace.api.profile = owner.profile; $currentUser.set(owner)
  workspace.newConversation('project-a'); expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('项目 A 的草稿')
  workspace.newConversation('project-b'); expect(restoreMaintenanceDraft(owner)).toBe(true)
  expect(workspace.composer.get().text).toBe('项目 B 的草稿')
  expect(captureMaintenanceDraft(owner)).toBe('memory')
  vi.restoreAllMocks()
  expect(captureMaintenanceDraft(owner)).toBe('saved')
  expect(Object.values(sessionStorage).some(value => value.includes('项目 A 的草稿') && value.includes('项目 B 的草稿'))).toBe(true)
})

test('员工丢弃不再需要的维护草稿后提示不再出现，其他对话保留的草稿不受影响', () => {
  // 草稿副本在页面内存里按账号缓存，用另一个账号避免沿用前一用例的记录
  const member: StudioUser = { ...user, id: 'member-c', profile: 'profile-c' }
  sessionStorage.clear(); workspace.reset(); workspace.api.profile = member.profile; $currentUser.set(member)
  workspace.session.set({ storedId: 'saved-a', runtimeId: 'runtime-a', info: {} })
  workspace.composer.set({ ...workspace.composer.get(), text: '维护前写到一半的要求' })
  expect(captureMaintenanceDraft(member)).toBe('saved')
  workspace.newConversation('project-b')
  workspace.editComposer({ text: '另一个项目的草稿' })
  expect(captureMaintenanceDraft(member)).toBe('saved')
  const first = readMaintenanceDraft(member)!
  expect(discardMaintenanceDraft(member, first)).toBe(true)
  const other = readMaintenanceDraft(member)!
  expect([other.storedId, other.projectId]).not.toEqual([first.storedId, first.projectId])
  expect(discardMaintenanceDraft(member, other)).toBe(true)
  expect(readMaintenanceDraft(member)).toBeNull()
  const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i) || '')
  expect(keys.some(key => key.startsWith('drama-studio:maintenance-draft'))).toBe(false)
})
