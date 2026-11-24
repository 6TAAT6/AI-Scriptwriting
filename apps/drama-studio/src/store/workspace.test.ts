import { beforeEach, expect, it } from 'vitest'
import type { RpcMethods, SessionCreateResult, SessionResumeResult } from '../../../shared/src/gateway-contract.generated'
import type { ServerRequest } from '../../../shared/src/json-rpc-channel'
import { Workspace, clearConnectionErrorOnOpen, type WorkspaceApi, type WorkspaceProjects } from './workspace'
import { DEFAULT_DIALOGUE_LANGUAGE } from '../lib/creative'
import { buildLanguageAwarePrompt } from '../lib/prompt-language'
import { historyEntries } from '../lib/transcript'

beforeEach(() => localStorage.clear())

it('数字回复只解析当前已完成回复的明确选项，并保留用户原文回显', async () => {
  const submitted: string[] = []
  const workspace = new Workspace({ profile: 'numeric-choice', materials: async () => ({ project: null, sources: [] }),
    rpc: (async (method, params) => {
      if (method !== 'prompt.submit') throw new Error('不应创建其他请求')
      submitted.push((params as { text: string }).text)
      return { status: 'streaming' }
    }) as WorkspaceApi['rpc'] })
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  const answer = '请问接下来希望执行哪项操作？\n```json\n' + JSON.stringify([
    { label: '整理剧情摘要', prompt: '请总结当前大纲的核心剧情与主要人物关系。' },
    { label: '撰写正文', prompt: '请根据已确认的大纲撰写第1—3集正文。' }
  ]) + '\n```'
  const conversation = { runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'a', role: 'assistant' as const, text: answer, calls: [] }
  ] }
  workspace.conversation.set(conversation)
  workspace.editComposer({ text: '1' })
  await workspace.send()
  expect(submitted[0].split('【本轮选项选择】\n')[1]?.split('【用户本轮消息】')[0]).toContain('请总结当前大纲的核心剧情与主要人物关系。')
  expect(submitted[0].split('【本轮选项选择】\n')[1]?.split('【用户本轮消息】')[0]).not.toContain('撰写第1—3集')
  expect(submitted[0].split('【用户本轮消息】\n')[1]).toBe('1')
  expect(workspace.conversation.get().entries.at(-1)?.text).toBe('1')
  for (const text of ['3', '1000', '1 集', '不是1', '1，先不要执行']) {
    workspace.conversation.set(conversation)
    workspace.editComposer({ text })
    await workspace.send()
    expect(submitted.at(-1)?.split('【用户本轮消息】\n')[1]).toBe(text)
  }
  workspace.conversation.set({ ...conversation, entries: [...conversation.entries, { id: 'later', role: 'assistant', text: '已收到其他修改意见。', calls: [] }] })
  workspace.editComposer({ text: '1' })
  await workspace.send()
  expect(submitted.at(-1)?.split('【用户本轮消息】\n')[1]).toBe('1')
})

it('WebSocket 恢复后清除旧的断线提示，但保留其他业务错误', () => {
  const disconnected = { sessions: [], loading: false, error: '创作连接已断开，重新连接后可恢复已有进度。' }
  expect(clearConnectionErrorOnOpen('open', disconnected).error).toBe('')
  const business = { sessions: [], loading: false, error: '历史资料暂未同步。' }
  expect(clearConnectionErrorOnOpen('open', business).error).toBe('历史资料暂未同步。')
})

it('流式正文增量在短窗口内合并，避免每个 token 重新解析整段对话', async () => {
  const workspace = new Workspace({ profile: 'stream-batch', materials: async () => ({ project: null, sources: [] }), rpc: () => { throw new Error('不应发送请求') } })
  workspace.conversation.set({ runtimeId: 'runtime', entries: [], running: false, error: '' })
  let updates = 0
  const unsubscribe = workspace.conversation.subscribe(() => { updates++ })
  const before = updates
  workspace.receive({ type: 'message.start', session_id: 'runtime', payload: {} })
  const afterStart = updates
  workspace.receive({ type: 'message.delta', session_id: 'runtime', payload: { text: '甲' } })
  workspace.receive({ type: 'message.delta', session_id: 'runtime', payload: { text: '乙' } })
  expect(updates).toBe(afterStart)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(updates).toBe(afterStart + 1)
  expect(workspace.conversation.get().entries.at(-1)?.text).toBe('甲乙')
  workspace.receive({ type: 'message.complete', session_id: 'runtime', payload: { text: '甲乙', status: 'complete' } })
  expect(workspace.conversation.get().entries.at(-1)?.pending).toBe(false)
  expect(updates).toBeGreaterThan(before)
  unsubscribe()
})

it('已有服务重放技术审批时直接拒绝，只有剧本业务确认进入创作卡片', () => {
  const decisions: unknown[] = []
  const local = new Workspace({ profile: 'approval', materials: async () => ({ project: null, sources: [] }), rpc: () => { throw new Error('不应提交新任务') } })
  const request: ServerRequest = { id: 'script', method: 'approval', params: { session_id: 's', pattern_key: 'script', description: 'script execution via -e/-c flag', command: 'PRIVATE_COMMAND' }, respond: value => { decisions.push(value) }, fail: () => { throw new Error('审批应明确拒绝') } }
  expect(local.receiveRequest(request)).toBe(true)
  expect(decisions).toEqual([{ choice: 'deny' }])
  expect(local.requests.get()).toEqual([])
  const gate = { ...request, id: 'drama', params: { session_id: 's', pattern_key: 'plugin_rule:jubao-drama:' + 'a'.repeat(32), description: '请确认核心期待' } } as ServerRequest
  expect(local.receiveRequest(gate)).toBe(true)
  expect(local.requests.get().map(row => row.id)).toEqual(['drama'])
})

it('恢复原生子代理与自动续接提示，迟到快照不会复活已完成任务或污染其他会话', async () => {
  let resolveSnapshot!: (value: unknown) => void
  const local = new Workspace({ profile: 'native', materials: async () => ({ project: null, sources: [] }),
    rpc: (async (method, params) => {
      if (method === 'session.resume') return { session_id: String((params as { session_id: string }).session_id), messages: [], message_count: 0, info: {}, running: false, auto_continue: { attempt: 1, interrupted_at: 1 } }
      if (method === 'subagent.list') return new Promise<unknown>(resolve => { resolveSnapshot = resolve })
      if (method === 'session.events.since') return { events: [], open_requests: [] }
      throw new Error('恢复不应发送创作请求')
    }) as WorkspaceApi['rpc'] })
  await local.open('A')
  expect(resolveSnapshot).toBeTypeOf('function')
  local.receive({ type: 'subagent.complete', session_id: 'A', payload: { subagent_id: 'child-a', status: 'completed', goal: '原生审核' } })
  resolveSnapshot({ subagents: [{ subagent_id: 'child-a', status: 'running', goal: '原生审核' }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(local.conversation.get().entries.find(row => row.subagent)?.subagent?.status).toBe('completed')
  expect(local.conversation.get().entries.some(row => row.noticeKind === 'auto_continue')).toBe(true)
  await local.open('B')
  const stale = resolveSnapshot
  local.newConversation()
  stale({ subagents: [{ subagent_id: 'child-b', status: 'running', goal: '不能越界' }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(local.conversation.get().entries).toEqual([])
})

it('删除回执清理当前聊天并保留项目草稿，迟到的恢复响应不能复活已删聊天', async () => {
  let finishOpen!: (value: SessionResumeResult) => void
  const workspace = new Workspace({ profile: 'delete-test', materials: async () => ({ project: null, sources: [] }),
    rpc: (() => new Promise(resolve => { finishOpen = resolve })) as WorkspaceApi['rpc'] })
  workspace.editComposer({ text: '保留的新创作草稿' })
  workspace.newConversation()
  workspace.session.set({ runtimeId: 'runtime-deleted', storedId: 'deleted', info: {} })
  workspace.composer.set({ ...workspace.composer.get(), text: '已删聊天的未发送内容' })
  workspace.navigation.set({ sessions: [{ id: 'deleted' }, { id: 'keep' }], loading: false, error: '' })
  localStorage.setItem('drama-studio:delete-test:selected', 'deleted')
  workspace.requests.set([{ id: 'old-confirm', method: 'approval', params: { session_id: 'runtime-deleted' } } as ServerRequest])
  const late = workspace.open('deleted')
  workspace.forgetConversation('deleted')
  finishOpen({ session_id: 'runtime-deleted', stored_session_id: 'deleted', info: {}, messages: [{ role: 'assistant', text: '已删内容' }], message_count: 1 })
  await late
  expect(workspace.session.get().storedId).toBe('')
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['keep'])
  expect(workspace.navigation.get().loading).toBe(false)
  expect(workspace.conversation.get().entries).toEqual([])
  expect(workspace.requests.get()).toEqual([])
  expect(workspace.composer.get().text).toBe('保留的新创作草稿')
  expect(localStorage.getItem('drama-studio:delete-test:selected')).toBeNull()
})

it('从甲项目打开乙项目聊天后删除，恢复乙项目草稿且下一段会话仍属于乙项目', async () => {
  let selected: string | null = 'A'
  const assigned: (string | null)[] = []
  const workspace = new Workspace({ profile: 'delete-project-test', materials: async () => ({ project: null, sources: [] }),
    rpc: (async method => {
      if (method === 'session.resume') return { session_id: 'runtime-B', stored_session_id: 'stored-B', info: {}, messages: [], message_count: 0 }
      if (method === 'session.create') return { session_id: 'runtime-new', stored_session_id: 'stored-new', info: {}, messages: [], message_count: 0 }
      if (method === 'session.list') return { sessions: [] }
      throw new Error('不应调用创作模型')
    }) as WorkspaceApi['rpc'] }, { load: async () => {}, selected: () => selected, select: id => { selected = id }, owner: () => 'B', attach: async (_id, projectId) => { assigned.push(projectId); return true } })
  workspace.newConversation('B')
  workspace.editComposer({ text: '乙项目草稿' })
  workspace.newConversation('A')
  workspace.editComposer({ text: '甲项目草稿' })
  await workspace.open('stored-B')
  workspace.forgetConversation('stored-B')
  expect(workspace.composer.get().text).toBe('乙项目草稿')
  expect(selected).toBe('B')
  await workspace.ensureSession()
  expect(assigned).toEqual(['B'])
  workspace.newConversation('A')
  expect(workspace.composer.get().text).toBe('甲项目草稿')
})

it('新建与账号重置使用中文默认值，其他会话的双语选择不污染新创作', () => {
  const workspace = new Workspace({ profile: 'test', materials: async () => ({ project: null, sources: [] }), rpc: () => { throw new Error('不应发送请求') } })
  expect(workspace.composer.get().language).toBe(DEFAULT_DIALOGUE_LANGUAGE)
  workspace.session.set({ runtimeId: 'old-runtime', storedId: 'old', info: {} })
  workspace.editComposer({ language: '中英双语' })
  workspace.newConversation()
  expect(workspace.composer.get().language).toBe(DEFAULT_DIALOGUE_LANGUAGE)
  workspace.editComposer({ language: '中英双语', text: '尚未发送的双语草稿' })
  workspace.newConversation()
  expect(workspace.composer.get().language).toBe('中英双语')
  workspace.reset()
  expect(workspace.composer.get().language).toBe(DEFAULT_DIALOGUE_LANGUAGE)
})

it('续聊每次发送当前语言偏好，回显和历史恢复均保留用户消息', async () => {
  const submitted: string[] = []
  const api: WorkspaceApi = {
    profile: 'test', materials: async () => ({ project: null, sources: [] }),
    rpc: (async (method, params) => {
      if (method !== 'prompt.submit') throw new Error('本测试只应提交当前消息')
      submitted.push((params as { text: string }).text)
      return { status: 'streaming' }
    }) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api)
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', entries: [{ id: 'first', role: 'user', text: '已有创作', calls: [] }], running: false, error: '' })
  for (const language of ['仅中文', '中英双语']) {
    workspace.editComposer({ language, text: '继续下一集，保留角色名 Alice。' })
    await workspace.send()
    // 未出现在侧栏中的旧会话沿用默认项目，作为要求清单和设定库的创作范围随消息发送。
    expect(submitted.at(-1)).toBe(buildLanguageAwarePrompt('继续下一集，保留角色名 Alice。', language, '中国', { skills: [] }, [], 'default'))
    expect(workspace.conversation.get().entries.at(-1)?.text).toBe('继续下一集，保留角色名 Alice。')
    workspace.conversation.set({ ...workspace.conversation.get(), running: false })
  }
  expect(submitted[0]).not.toBe(submitted[1])
  expect(historyEntries(submitted.map(text => ({ role: 'user', text }))).map(entry => entry.text))
    .toEqual(['继续下一集，保留角色名 Alice。', '继续下一集，保留角色名 Alice。'])
})

it('快速切换时，先前请求的迟到结果不能覆盖当前会话及草稿', async () => {
  const pending = new Map<string, (value: SessionResumeResult) => void>()
  const api: WorkspaceApi = {
    profile: 'test',
    materials: async () => ({ project: null, sources: [] }),
    rpc: (<K extends keyof RpcMethods>(method: K, params: RpcMethods[K]['params']) => {
      if (method === 'subagent.list') return Promise.resolve({ subagents: [] })
      if (method === 'session.events.since') return Promise.resolve({ events: [] })
      if (method !== 'session.resume') throw new Error('只允许恢复会话')
      return new Promise(resolve => pending.set((params as { session_id: string }).session_id, resolve))
    }) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api)
  workspace.editComposer({ text: '新项目的未发送草稿' })
  const openingA = workspace.open('A')
  const openingB = workspace.open('B')
  const restored = (id: string): SessionResumeResult => ({ session_id: `runtime-${id}`, stored_session_id: id, info: { model: 'test-model' }, messages: [{ role: 'assistant', text: `${id} 项目的正文` }], message_count: 1 })
  pending.get('B')!(restored('B'))
  await openingB
  pending.get('A')!(restored('A'))
  await openingA
  expect(workspace.session.get().storedId).toBe('B')
  expect(workspace.conversation.get().entries[0].text).toBe('B 项目的正文')
  workspace.newConversation()
  expect(workspace.composer.get().text).toBe('新项目的未发送草稿')
})

it('切到其他会话后，服务端撤销的确认卡片仍立即失效', () => {
  const workspace = new Workspace({ profile: 'test', materials: async () => ({ project: null, sources: [] }), rpc: () => { throw new Error('不应发送任何请求') } })
  workspace.session.set({ runtimeId: 's2', storedId: 'stored', info: {} })
  workspace.requests.set([{ id: 'srq-1', method: 'approval', params: { session_id: 's1' } } as ServerRequest])
  workspace.receive({ type: 'request.cancel', session_id: 's1', payload: { id: 'srq-1', method: 'approval', reason: 'interrupted' } })
  expect(workspace.requests.get()).toEqual([])
})

it('创建结果不明时重试复用同一个幂等标识，新创作才产生新标识', async () => {
  const keys: unknown[] = []
  const api: WorkspaceApi = {
    profile: 'test', materials: async () => ({ project: null, sources: [] }),
    rpc: (async (method, params) => {
      if (method === 'session.list') return { sessions: [] }
      if (method !== 'session.create') throw new Error('意外请求')
      keys.push((params as { idempotency_key: string }).idempotency_key)
      if (keys.length === 1) throw new Error('响应中断')
      return { session_id: `runtime-${keys.length}`, stored_session_id: `stored-${keys.length}`, messages: [], info: {}, message_count: 0 }
    }) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api)
  await expect(workspace.ensureSession()).rejects.toThrow('响应中断')
  await workspace.ensureSession()
  expect(keys[0]).toBe(keys[1])
  workspace.newConversation()
  await workspace.ensureSession()
  expect(keys[2]).not.toBe(keys[1])
})

it('退出账号清空草稿和审批，旧账号迟到的列表不能进入新账号', async () => {
  let resolveList!: (value: { sessions: { id: string; title: string }[] }) => void
  const api: WorkspaceApi = {
    profile: 'account-a', materials: async () => ({ project: null, sources: [] }),
    rpc: (() => new Promise(resolve => { resolveList = resolve })) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api)
  workspace.editComposer({ text: '甲账号的未发送原稿' })
  workspace.requests.set([{ id: 'old', method: 'approval', params: { session_id: 'old-session' } } as ServerRequest])
  const refreshing = workspace.refresh()
  workspace.reset()
  api.profile = 'account-b'
  workspace.navigation.set({ sessions: [{ id: 'B', title: '乙的项目' }], loading: false, error: '' })
  resolveList({ sessions: [{ id: 'A', title: '甲的私有项目' }] })
  await refreshing
  expect(workspace.navigation.get().sessions.map(row => row.id)).toEqual(['B'])
  expect(workspace.composer.get().text).toBe('')
  expect(workspace.requests.get()).toEqual([])
  workspace.newConversation()
  expect(workspace.composer.get().text).toBe('')
})

it('退出后迟到的新建会话响应不能恢复旧账号的正文或创建状态', async () => {
  let finishCreate!: (value: SessionCreateResult) => void
  const api: WorkspaceApi = {
    profile: 'account-a', materials: async () => ({ project: null, sources: [] }),
    rpc: ((method) => method === 'session.create' ? new Promise<SessionCreateResult>(resolve => { finishCreate = resolve }) : Promise.resolve(method === 'session.list' ? { sessions: [] } : { status: 'streaming' })) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api)
  workspace.editComposer({ text: '甲的创作请求' })
  const sending = workspace.send()
  workspace.reset()
  api.profile = 'account-b'
  finishCreate({ session_id: 'old-runtime', stored_session_id: 'old-stored', info: {}, message_count: 1, messages: [{ role: 'assistant', text: '甲的资料' }] })
  await sending
  expect(workspace.session.get().storedId).toBe('')
  expect(workspace.conversation.get().entries).toEqual([])
  expect(workspace.conversation.get().error).toBe('')
})

it('实际发送链路附加中文优先约束，用户气泡保留输入且显式语言请求原样交给模型', async () => {
  let submitted = ''
  const api: WorkspaceApi = {
    profile: 'chinese-default', materials: async () => ({ project: null, sources: [] }),
    rpc: (async (method, params) => {
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored', message_count: 0, messages: [], info: {} }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'prompt.submit') { submitted = String((params as { text: string }).text); return { status: 'streaming' } }
      throw new Error('意外调用')
    }) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api)
  const text = '原稿文件叫 English.txt。本轮请用英文写一句台词，其余解释用中文。'
  workspace.editComposer({ text })
  await workspace.send()
  expect(submitted).toContain('【本轮语言偏好】')
  expect(submitted).toContain('用户在本轮明确要求英文或双语')
  expect(submitted.endsWith(text)).toBe(true)
  expect(workspace.conversation.get().entries[0].text).toContain(text)
  expect(workspace.conversation.get().entries[0].text).not.toContain('【本轮语言偏好】')
})

it('每个项目保留独立草稿，首次发送前可靠保存会话所属项目', async () => {
  let selected: string | null = 'project-a'
  const rows = new Map<string, string>()
  const attached = new Map<string, string | null>()
  const projects: WorkspaceProjects = {
    load: async () => {}, selected: () => selected, select: id => { selected = id },
    owner: id => attached.get(id) || 'default',
    attach: async (id, projectId) => {
      attached.set(id, projectId); return true
    }
  }
  let count = 0
  const api: WorkspaceApi = {
    profile: 'projects', materials: async () => ({ project: null, sources: [] }),
    rpc: (async (method, params) => {
      if (method === 'session.create') { const id = `session-${++count}`; return { session_id: id, stored_session_id: id, message_count: 0, messages: [], info: {} } }
      if (method === 'session.list') return { sessions: [...rows].map(([id, title]) => ({ id, title })) }
      if (method === 'prompt.submit') {
        const { session_id, text } = params as { session_id: string; text: string }
        if (!attached.has(session_id)) throw new Error('没有可靠归属时不能提交生成')
        rows.set(session_id, text); return { status: 'streaming' }
      }
      if (method === 'session.resume') { const id = (params as { session_id: string }).session_id; return { session_id: id, stored_session_id: id, info: {}, messages: [{ role: 'user', text: rows.get(id) }], message_count: 1 } }
      throw new Error('意外请求')
    }) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api, projects)
  workspace.editComposer({ text: '甲项目草稿' })
  workspace.newConversation('project-b')
  expect(selected).toBe('project-b')
  expect(workspace.composer.get().text).toBe('')
  workspace.editComposer({ text: '乙项目草稿' })
  workspace.newConversation('project-a')
  expect(workspace.composer.get().text).toBe('甲项目草稿')
  await workspace.ensureSession()
  expect(attached.get('session-1')).toBe('project-a')
  await workspace.send()
  expect(attached.get('session-1')).toBe('project-a')
  workspace.newConversation('project-b')
  expect(workspace.composer.get().text).toBe('乙项目草稿')
  await workspace.send()
  expect(attached.get('session-2')).toBe('project-b')
  await workspace.open('session-1')
  expect(selected).toBe('project-a')
  expect(workspace.conversation.get().entries[0].text).toContain('甲项目草稿')
})

it('归属保存失败只重试绑定而不生成重复会话，项目隐藏后的旧草稿仍属于原项目', async () => {
  let selected: string | null = 'A'
  let created = 0, submitted = 0, saveAttempts = 0
  const projects: WorkspaceProjects = {
    load: async () => {}, selected: () => selected, select: id => { selected = id }, owner: () => 'A',
    attach: async () => ++saveAttempts > 1
  }
  const api: WorkspaceApi = {
    profile: 'test', materials: async () => ({ project: null, sources: [] }),
    rpc: (async method => {
      if (method === 'session.create') { created++; return { session_id: 'runtime', stored_session_id: 'stored', messages: [], message_count: 0, info: {} } }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'prompt.submit') { submitted++; return { status: 'streaming' } }
      throw new Error('意外请求')
    }) as WorkspaceApi['rpc']
  }
  const workspace = new Workspace(api, projects)
  workspace.editComposer({ text: '甲项目草稿' })
  selected = 'B'
  workspace.newConversation('B')
  expect(workspace.composer.get().text).toBe('')
  workspace.newConversation('A')
  expect(workspace.composer.get().text).toBe('甲项目草稿')
  await workspace.send()
  expect(submitted).toBe(0)
  expect(workspace.composer.get().text).toBe('甲项目草稿')
  await workspace.send()
  expect(submitted).toBe(1)
  expect(created).toBe(1)
})
