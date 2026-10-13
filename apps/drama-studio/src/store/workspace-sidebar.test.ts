import { afterEach, expect, it, vi } from 'vitest'
import type { SessionListRow } from '../../../shared/src/gateway-contract.generated'
import { Workspace, type WorkspaceApi } from './workspace'

afterEach(() => localStorage.clear())

function fixture() {
  let stored: SessionListRow[] = [], sequence = 0
  const workspace = new Workspace({ profile: 'sidebar', materials: async () => ({ project: null, sources: [] }),
    rpc: (async method => {
      if (method === 'session.create') { const id = ++sequence; return { session_id: `live-${id}`, stored_session_id: `saved-${id}`, info: {}, messages: [], message_count: 0 } }
      if (method === 'session.list') return { sessions: stored }
      throw new Error('侧栏验收不发起模型生成')
    }) as WorkspaceApi['rpc'] })
  return { workspace, save(rows: SessionListRow[]) { stored = rows } }
}

it('新对话获得真实创建回执后立即进入侧栏，数据库列表稍后追上时不重复或丢失', async () => {
  const { workspace, save } = fixture()
  workspace.editComposer({ text: '新剧本的人物分析' })
  await workspace.ensureSession()
  expect(workspace.navigation.get().sessions).toMatchObject([{ id: 'saved-1', title: '新剧本的人物分析' }])
  workspace.receive({ type: 'session.title', session_id: 'live-1', payload: { title: '人物关系与核心期待' } })
  await workspace.refresh()
  expect(workspace.navigation.get().sessions[0].title).toBe('人物关系与核心期待')
  workspace.newConversation()
  await workspace.ensureSession()
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['saved-2', 'saved-1'])
  save([{ id: 'saved-1', title: '已保存的正式标题' }])
  await workspace.refresh()
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['saved-2', 'saved-1'])
  expect(workspace.navigation.get().sessions[1].title).toBe('已保存的正式标题')
})

it('删除或退出账号后，尚未写入数据库的新对话不会被后续刷新重新显示', async () => {
  const { workspace } = fixture()
  await workspace.ensureSession()
  workspace.forgetConversation('saved-1')
  await workspace.refresh()
  expect(workspace.navigation.get().sessions).toEqual([])
  await workspace.ensureSession()
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['saved-2'])
  workspace.reset()
  await workspace.refresh()
  expect(workspace.navigation.get().sessions).toEqual([])
})

it('其他对话或后台任务完成也更新列表，保持当前会话和未发送草稿', async () => {
  const { workspace, save } = fixture()
  workspace.session.set({ storedId: 'current', runtimeId: 'current-live', info: {} })
  workspace.conversation.set({ runtimeId: 'current-live', entries: [], running: false, error: '' })
  workspace.editComposer({ text: '不能被刷新覆盖的输入' })
  save([{ id: 'other', title: '另一段新对话' }])
  workspace.receive({ type: 'message.complete', session_id: 'other-live', payload: { text: '已完成' } })
  await vi.waitFor(() => expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['other']))
  save([{ id: 'other', title: '后台完成后的标题' }])
  workspace.receive({ type: 'subagent.complete', session_id: 'other-live', payload: { subagent_id: 'child', status: 'completed' } })
  await vi.waitFor(() => expect(workspace.navigation.get().sessions[0].title).toBe('后台完成后的标题'))
  expect(workspace.session.get().storedId).toBe('current')
  expect(workspace.composer.get().text).toBe('不能被刷新覆盖的输入')
})
