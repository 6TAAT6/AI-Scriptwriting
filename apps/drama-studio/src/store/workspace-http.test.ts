import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it('内网 HTTP 缺少 randomUUID 时仍可初始化工作区和切换新创作', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
  const { Workspace } = await import('./workspace')
  const workspace = new Workspace({ profile: 'http', materials: async () => ({ project: null, sources: [] }),
    rpc: () => { throw new Error('初始化不应发送创作请求') } })
  workspace.newConversation()
  workspace.editComposer({ text: '新的剧本' })
  expect(workspace.composer.get().text).toBe('新的剧本')
  workspace.reset()
  expect(workspace.conversation.get().entries).toEqual([])
})
