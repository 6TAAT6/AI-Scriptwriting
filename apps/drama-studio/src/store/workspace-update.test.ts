import { afterEach, expect, it, vi } from 'vitest'
import { $updateAvailable, checkWorkspaceUpdate } from '../lib/workspace-update'
import { Workspace, workspace } from './workspace'

afterEach(() => { document.querySelector('[data-update-fixture]')?.remove(); workspace.reset(); $updateAvailable.set(false); vi.unstubAllGlobals() })

it('自动更新保护当前和其他项目的草稿，也等待生成和后台任务结束', () => {
  const local = new Workspace({ profile: 'update', materials: async () => ({ project: null, sources: [] }), rpc: () => { throw new Error('更新判断不应发送请求') } })
  expect(local.canAutoUpdate).toBe(true)
  local.editComposer({ text: '最近列表中的未发送输入' })
  local.newConversation('project-b')
  expect(local.composer.get().text).toBe('')
  expect(local.canAutoUpdate).toBe(false)
  local.newConversation(null)
  expect(local.composer.get().text).toBe('最近列表中的未发送输入')
  local.editComposer({ text: '' }); local.newConversation('project-b')
  expect(local.canAutoUpdate).toBe(true)
  local.conversation.set({ runtimeId: 'live', entries: [], running: true, error: '' })
  expect(local.canAutoUpdate).toBe(false)
  local.conversation.set({ runtimeId: 'live', entries: [], running: false, asyncPending: 1, error: '' })
  expect(local.canAutoUpdate).toBe(false)
  local.conversation.set({ runtimeId: 'live', entries: [], running: false, asyncPending: 0, error: '' })
  expect(local.canAutoUpdate).toBe(true)
})

it('关闭但留在 DOM 中的菜单不阻止空闲更新，真实打开的菜单和草稿仍会保护页面', async () => {
  workspace.reset()
  const root = document.createElement('div')
  root.dataset.updateFixture = ''
  root.innerHTML = '<script type="module" src="/assets/index-current.js"></script><div aria-hidden="true" inert><div role="listbox"></div></div>'
  document.body.append(root)
  vi.stubGlobal('fetch', async () => new Response('<script type="module" src="/assets/index-next.js"></script>', { headers: { 'Content-Type': 'text/html' } }))
  expect(await checkWorkspaceUpdate()).toBe(true)
  workspace.editComposer({ text: '保留草稿' })
  expect(await checkWorkspaceUpdate()).toBe(false)
  workspace.editComposer({ text: '' })
  const menu = root.querySelector('[aria-hidden]')!
  menu.removeAttribute('aria-hidden'); menu.removeAttribute('inert')
  expect(await checkWorkspaceUpdate()).toBe(false)
})
