import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { historyEntries, reduceEvent, type Conversation, type Entry } from '../lib/transcript'
import { resultSummary } from '../lib/activity-summary'
import { projectFromResult } from '../lib/creative'
import { gateway } from '../lib/gateway'
import * as downloads from '../lib/download'
import { Transcript } from './Transcript'
import { Composer } from './Composer'

beforeEach(() => workspace.reset())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('仅发送文档时立即显示独立附件，原始引用和历史恢复保持一致', async () => {
  workspace.connection.set('open')
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  const files = ['人物关系.xlsx', '故事原稿.docx'].map(name => ({ attached: true, uploaded: true, name,
    path: `/assets-data/fixture/${name}`, ref_path: `/assets-data/fixture/${name}`, ref_text: `@file:\`/assets-data/fixture/${name}\`` }))
  workspace.editComposer({ attachments: files })
  let submitted = ''
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    if (method !== 'prompt.submit') throw new Error('附件展示验收不调用模型')
    submitted = (params as { text: string }).text
    return { status: 'streaming' }
  }) as WorkspaceApi['rpc'])
  render(<><Transcript onInspect={() => {}} /><Composer /></>)
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
  expect(submitted).toContain('【用户本轮消息】\n\n\n@file:`/assets-data/fixture/人物关系.xlsx`\n@file:`/assets-data/fixture/故事原稿.docx`')
  expect(workspace.conversation.get().entries[0].text).toBe('')
  for (const file of files) expect(screen.getByRole('button', { name: file.name })).toBeTruthy()
  act(() => workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([{ role: 'user', text: submitted }]) }))
  for (const file of files) expect(screen.getAllByRole('button', { name: file.name })).toHaveLength(1)
  expect(document.body.textContent).not.toContain('附件：')
  expect(document.body.textContent).not.toContain('/assets-data/')
})

test('历史附件与正文分开，同名文件按各自引用下载且保留普通附件说明', async () => {
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([{ role: 'user', text:
    '请比较这两份原稿。\n附件：这是我手写的说明\n@file:`/assets-data/first/原稿.docx`\n@file:`/assets-data/second/原稿.docx`' }]) })
  const bytes = new Blob(['第二份原稿'])
  const read = vi.spyOn(gateway, 'file').mockResolvedValue({ blob: async () => bytes } as Response)
  const save = vi.spyOn(downloads, 'saveBlob').mockResolvedValue()
  render(<Transcript onInspect={() => {}} />)
  expect(screen.getByText(/请比较这两份原稿。/)).toBeTruthy()
  expect(screen.getByText(/附件：这是我手写的说明/)).toBeTruthy()
  const files = screen.getAllByRole('button', { name: '原稿.docx' })
  expect(files).toHaveLength(2)
  fireEvent.click(files[1])
  await waitFor(() => expect(save).toHaveBeenCalledWith(bytes, '原稿.docx'))
  expect(read).toHaveBeenCalledWith('/assets-data/second/原稿.docx', 'stored')
})

test('上翻记录后主动发送会回到底部并跟随回复，再次上翻时保留阅读位置', async () => {
  workspace.connection.set('open')
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'history', role: 'assistant', text: '已经保存的长篇聊天记录。', calls: [] }
  ] })
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async method => {
    if (method === 'prompt.submit') return { status: 'streaming' }
    throw new Error('滚动测试不创建会话或调用模型')
  }) as WorkspaceApi['rpc'])
  const view = render(<><Transcript onInspect={() => {}} /><Composer /></>)
  const scroll = view.container.querySelector<HTMLDivElement>('.transcript-scroll')!
  let height = 2400, top = 0
  Object.defineProperties(scroll, {
    clientHeight: { get: () => 600 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 600)) } }
  })
  scroll.scrollTop = 240; fireEvent.scroll(scroll)
  const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' })
  fireEvent.change(input, { target: { value: '继续写下一幕。' } })
  expect(scroll.scrollTop).toBe(240)
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText('继续写下一幕。')).toBeTruthy())
  expect(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight).toBe(0)

  height = 3000
  act(() => workspace.conversation.set(reduceEvent(workspace.conversation.get(), {
    type: 'message.delta', session_id: 'runtime', payload: { text: '新的一幕正在展开。' }
  })))
  expect(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight).toBe(0)
  scroll.scrollTop = 180; fireEvent.scroll(scroll)
  height = 3600
  act(() => workspace.conversation.set(reduceEvent(workspace.conversation.get(), {
    type: 'message.complete', session_id: 'runtime', payload: { text: '新的一幕已完成。', status: 'complete' }
  })))
  expect(scroll.scrollTop).toBe(180)
  await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
  fireEvent.change(input, { target: { value: '再修改一下结尾。' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(screen.getByText('再修改一下结尾。')).toBeTruthy())
  expect(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight).toBe(0)
})

test('回复中的文字建议渲染为带边框的下一步卡片并可填入对话框，没有建议时不补通用卡片', () => {
  workspace.connection.set('open')
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'user', role: 'user', text: '帮我修改作文，沿用当前对话已经确认的要求。', calls: [] },
    { id: 'assistant', role: 'assistant', text: '作文已经完成。\n\n接下来，你可以：\n- **改写成议论文**：请结合当前对话，用同一主题改写成议论文。', calls: [] }
  ] })

  render(<><Transcript onInspect={() => {}} /><Composer /></>)
  const section = screen.getByRole('region', { name: '接下来，你可以' })
  expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0)
  const firstCard = within(section).getAllByRole('listitem')[0]
  expect(firstCard.className).toContain('next-step-card')
  const edit = within(firstCard).getByRole('button', { name: /填入编辑/ })
  fireEvent.click(edit)
  expect((screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }) as HTMLTextAreaElement).value).toContain('请结合当前对话')
  cleanup()
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'user2', role: 'user', text: '帮我修改作文。', calls: [] },
    { id: 'assistant2', role: 'assistant', text: '作文已经完成。', calls: [] }
  ] })
  render(<Transcript onInspect={() => {}} />)
  expect(screen.queryByRole('region', { name: '接下来，你可以' })).toBeNull()
})

test('展开创作步骤保留业务摘要，工具耗时、技术参数和原始结果不进入界面', () => {
  let conversation: Conversation = { runtimeId: 'runtime', running: false, error: '', entries: [] }
  for (const event of [
    { type: 'tool.start', payload: { tool_id: 'read', name: 'read_file', args: { path: '/private/runtime/原稿.md', command: 'PRIVATE_COMMAND' } } },
    { type: 'tool.complete', payload: { tool_id: 'read', name: 'read_file', result: { ok: true, debug: 'PRIVATE_RESULT' }, summary: '已读取 120 行', duration_s: 0.5 } },
    { type: 'tool.complete', payload: { tool_id: 'save', name: 'write_file', result: { ok: true }, summary: '大纲已保存' } }
  ]) conversation = reduceEvent(conversation, { ...event, session_id: 'runtime' })
  workspace.conversation.set(conversation)
  render(<Transcript onInspect={() => {}} />)
  fireEvent.click(screen.getByText('已阅读资料、保存文件'))
  expect(screen.getByText('2 步')).toBeTruthy()
  expect(screen.queryByText(/工具累计|用时.*秒|耗时未记录/)).toBeNull()
  expect(screen.getByText('已阅读资料')).toBeTruthy()
  expect(screen.getByText('原稿.md')).toBeTruthy()
  expect(screen.getByText('已读取 120 行')).toBeTruthy()
  expect(screen.getByText('大纲已保存')).toBeTruthy()
  expect(screen.queryByText('操作内容')).toBeNull()
  expect(screen.queryByText('执行结果')).toBeNull()
  expect(screen.queryByText('操作参数')).toBeNull()
  expect(screen.queryByText('原始结果')).toBeNull()
  expect(document.body.textContent).not.toContain('/private/runtime')
  expect(document.body.textContent).not.toContain('PRIVATE_COMMAND')
  expect(document.body.textContent).not.toContain('PRIVATE_RESULT')
})

test('正文没有文件链接时，实时与历史正式回执仍提供稿件阅读和 Word 下载', async () => {
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  const bytes = new Blob(['docx-bytes'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const read = vi.spyOn(gateway, 'file').mockResolvedValue({ blob: async () => bytes } as Response)
  const save = vi.spyOn(downloads, 'saveBlob').mockResolvedValue()
  const path = '/assets-data/' + 'd'.repeat(32) + '/第1批正文-c81d92f3.docx'
  const receipt = { ok: true, receipt: { path, name: '第1批正文.docx', format: 'docx', status: 'draft' } }
  let state = reduceEvent({ runtimeId: 'runtime', running: false, error: '', entries: [] }, { session_id: 'runtime', type: 'tool.complete', payload: { tool_id: 'export-1', name: 'drama_export', result: receipt } })
  state = { ...state, entries: [...state.entries, { id: 'assistant', role: 'assistant', text: '第 1 批正文已生成。', calls: [] }] }
  workspace.conversation.set(state)
  const onReadFile = vi.fn()
  render(<Transcript onReadFile={onReadFile} />)
  fireEvent.click(await screen.findByRole('button', { name: '在稿件面板阅读：第1批正文.docx' }))
  expect(onReadFile).toHaveBeenCalledWith({ path, name: '第1批正文.docx' })
  fireEvent.click(screen.getByRole('button', { name: '下载 Word：第1批正文.docx' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(bytes, '第1批正文.docx'))
  expect(read).toHaveBeenCalledWith(path, 'stored')
  act(() => workspace.conversation.set({ ...state, entries: historyEntries([
    { role: 'tool', tool_call_id: 'export-1', name: 'drama_export', content: JSON.stringify(receipt) },
    { role: 'assistant', content: '第 1 批正文已生成。' }
  ]) }))
  expect(screen.getAllByRole('button', { name: '在稿件面板阅读：第1批正文.docx' })).toHaveLength(1)
  expect(screen.getAllByRole('button', { name: '下载 Word：第1批正文.docx' })).toHaveLength(1)
})

test('文件链接旁提供稿件面板阅读和下载图标，回复底部只保留复制', async () => {
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  const path = '/assets-data/' + 'c'.repeat(32) + '/script-1.docx'
  let state: Conversation = { runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'assistant', role: 'assistant', text: `[第1批正文.docx](${path})`, calls: [] }
  ] }
  workspace.conversation.set(state)
  const onReadFile = vi.fn()
  render(<Transcript onInspect={() => {}} onReadFile={onReadFile} />)
  expect(await screen.findByRole('button', { name: '在稿件面板阅读：第1批正文.docx' })).toBeTruthy()
  const actions = screen.getByRole('group', { name: '回复操作' })
  expect(within(actions).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['复制回复'])
  fireEvent.click(screen.getByRole('button', { name: '在稿件面板阅读：第1批正文.docx' }))
  expect(onReadFile).toHaveBeenCalledWith({ path, name: '第1批正文.docx' })
})

test('回执按路径与正文链接去重，各轮交付只出现在所属回复之后', async () => {
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  const first = '/assets-data/' + 'a'.repeat(32) + '/第1批正文.docx'
  const second = '/assets-data/' + 'b'.repeat(32) + '/第2批正文.docx'
  const saved = (path: string, name: string) => JSON.stringify({ ok: true, receipt: { path, name, format: 'docx', status: 'draft' } })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([
    { role: 'user', content: '写第一批。' },
    { role: 'tool', tool_call_id: 'first', name: 'drama_agent_document', content: saved(first, '第1批正文.docx') },
    { role: 'assistant', content: `[第1批正文.docx](${encodeURI(first)})` },
    { role: 'user', content: '写第二批。' },
    { role: 'tool', tool_call_id: 'second', name: 'drama_agent_document', content: saved(second, '第2批正文.docx') },
    { role: 'tool', tool_call_id: 'duplicate', name: 'drama_agent_document', content: saved(second, '第2批正文.docx') },
    { role: 'assistant', content: `第二批正文已生成。\n\n\`\`\`studio-suggestions\n${JSON.stringify([{ label: '核对正文', prompt: `请核对[第2批正文.docx](${second})的内容。` }])}\n\`\`\`` },
    { role: 'user', content: '人物动机是什么？' },
    { role: 'assistant', content: '人物希望找回家人。' }
  ]) })
  render(<Transcript onReadFile={() => {}} />)
  expect(await screen.findAllByRole('button', { name: '下载 Word：第1批正文.docx' })).toHaveLength(1)
  const download = screen.getAllByRole('button', { name: '下载 Word：第2批正文.docx' })
  expect(download).toHaveLength(1)
  const secondReply = screen.getByText('第二批正文已生成。')
  const laterReply = screen.getByText('人物希望找回家人。')
  expect(secondReply.compareDocumentPosition(download[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(download[0].compareDocumentPosition(laterReply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('资料库补齐的稿件通过原消息关联，实时回复与重新打开历史均有独立文件入口', async () => {
  const path = '/assets-data/' + 'e'.repeat(32) + '/剧情分析.docx'
  const content = '## 剧情分析\n\n女主发现账本被调换，决定先核对货运记录。'
  workspace.project.set(projectFromResult({ project: { id: 'agent-docs', agent_id: 'gm3-1', artifacts: [
    { id: 'analysis', name: '剧情分析', content, kind: 'analysis', source_message_id: 42 }
  ], exports: [{ artifact_id: 'analysis', path, name: '剧情分析.docx', format: 'docx' }] } }))
  const entries: Conversation['entries'] = [
    { id: 'user-1', role: 'user', text: '先分析剧情', calls: [] },
    { id: 'message-live', role: 'assistant', text: `${content}\n\n请确认这个方向。`, calls: [] },
    { id: 'user-2', role: 'user', text: '解释一下', calls: [] },
    { id: 'message-next', role: 'assistant', text: '货运记录可以确定时间。', calls: [] }
  ]
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries })
  render(<Transcript onReadFile={() => {}} />)
  const button = await screen.findByRole('button', { name: '下载 Word：剧情分析.docx' })
  expect(button.compareDocumentPosition(screen.getByText('货运记录可以确定时间。')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  act(() => workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([
    { role: 'user', row_id: 40, content: '先分析剧情' },
    { role: 'assistant', row_id: 42, content: `${content}\n\n请确认这个方向。` },
    { role: 'user', row_id: 43, content: '引用原话' },
    { role: 'assistant', row_id: 44, content }
  ]) }))
  expect(screen.getAllByRole('button', { name: '下载 Word：剧情分析.docx' })).toHaveLength(1)
  const userQuote = screen.getByText('引用原话')
  expect(screen.getByRole('button', { name: '下载 Word：剧情分析.docx' }).compareDocumentPosition(userQuote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('浏览器剪贴板拒绝时使用兼容复制，不显示复制失败', async () => {
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'assistant', role: 'assistant', text: '需要复制的正文。', calls: [] }
  ] })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('权限被拒绝')) } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(true) })
  const execCommand = vi.mocked(document.execCommand)
  render(<Transcript onInspect={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '复制回复' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '已复制回复' })).toBeTruthy())
  expect(execCommand).toHaveBeenCalledWith('copy')
  expect(screen.queryByText('复制失败，请手动选择文本。')).toBeNull()
})

test('已结束的思考不留标记，公开状态按消息顺序内联显示，推理原文不进入正文或复制操作', () => {
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'thinking', role: 'thinking', text: 'PRIVATE_REASONING', calls: [], pending: false },
    { id: 'review', role: 'status', text: '技能已加载，正在核对分集资料。', calls: [], noticeKind: 'status.update' },
    { id: 'answer', role: 'assistant', text: '第九集草稿已保存。', calls: [] },
    { id: 'reflection', role: 'status', text: '已修补创作回执格式。', calls: [], noticeKind: 'review.summary' }
  ] })
  render(<Transcript onInspect={() => {}} />)
  expect(screen.queryByText('已思考')).toBeNull()
  const review = screen.getByText('技能已加载，正在核对分集资料。')
  const answer = screen.getByText('第九集草稿已保存。')
  expect(review.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText(/自我改进回顾/)).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '复制回复' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '在稿件面板阅读' })).toBeNull()
  expect(document.body.textContent).not.toContain('PRIVATE_REASONING')
})

test('父轮结束后保留运行中的子代理，失败和完成后退出活动卡片且不再显示等待', () => {
  const conversation: Conversation = { runtimeId: 'runtime', running: false, error: '', asyncPending: 1, entries: [
    { id: 'agent', role: 'subagent', text: '', calls: [], subagent: {
      id: 'writer', goal: '为《小福星》起草第九至十二集完整新纲', model: 'GPT-6', status: 'running',
      toolCount: 3, lastTool: 'read_file', elapsed: 59, preview: '正在核对人物救援因果。'
    } }
  ] }
  workspace.conversation.set(conversation)
  render(<Transcript onInspect={() => {}} />)
  const agent = screen.getByRole('article', { name: '子代理：为《小福星》起草第九至十二集完整新纲' })
  expect(within(agent).getByText('巨豹创作模型')).toBeTruthy()
  expect(within(agent).getByText('进行中')).toBeTruthy()
  expect(within(agent).getByText('3 次工具调用')).toBeTruthy()
  expect(within(agent).getByText('59 秒')).toBeTruthy()
  expect(within(agent).getByText('最近工具：阅读资料')).toBeTruthy()
  expect(within(agent).queryByText('最近工具：read_file')).toBeNull()
  expect(screen.getByText('后台任务完成后将自动继续')).toBeTruthy()
  for (const status of ['failed', 'completed', 'error', 'timeout', 'interrupted'] as const) {
    act(() => workspace.conversation.set({ ...conversation, asyncPending: 0, entries: conversation.entries.map(entry => ({
      ...entry, subagent: { ...entry.subagent!, status, elapsed: 120 }
    })) }))
    expect(screen.queryByRole('article', { name: '子代理：为《小福星》起草第九至十二集完整新纲' })).toBeNull()
    expect(screen.queryByText('后台任务完成后将自动继续')).toBeNull()
  }
})

test('创作步骤一行一步：显示能力名称，不显示内部技能名、自动注入的空步骤和重复读取', () => {
  const entries = historyEntries([
    { role: 'tool', tool_call_id: 'a', name: 'skill_view', args: { name: 'jubao-drama:jubao-agent-gm3-1' }, content: JSON.stringify({ success: true }) },
    { role: 'tool', tool_call_id: 'b', name: 'skill_view' },
    { role: 'tool', tool_call_id: 'c', name: 'read_file', args: { path: '/home/x/attachments/S-十年劫（80集）.docx' }, content: JSON.stringify({ content: '1|第1集' }) },
    { role: 'tool', tool_call_id: 'd', name: 'skill_view', args: { name: 'jubao-drama:jubao-agent-gm3-1' }, content: JSON.stringify({ success: true }) },
    { role: 'tool', tool_call_id: 'e', name: 'skill_view', args: { name: 'jubao-drama:jubao-agent-gm3-1', file_path: 'references/pattern-library/north-america.md' }, content: JSON.stringify({ success: true }) }
  ])
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries })
  render(<Transcript onInspect={() => {}} />)
  expect(screen.getByText('已读取创作规则、阅读资料、读取规则参考')).toBeTruthy()
  expect(screen.getByText('3 步')).toBeTruthy()
  expect(screen.getAllByText('已读取创作规则')).toHaveLength(1)
  expect(screen.getByText('巨豹 Agent1 · 适配满血版 V1.1')).toBeTruthy()
  expect(screen.getByText('S-十年劫（80集）.docx')).toBeTruthy()
  expect(screen.getByText('north-america')).toBeTruthy()
  expect(document.body.textContent).not.toContain('jubao-drama:')
  expect(document.body.textContent).not.toContain('历史记录未保留操作回执')
})

test('进行中的步骤在摘要里写明正在做什么，失败步骤写明原因', () => {
  let conversation: Conversation = { runtimeId: 'runtime', running: true, error: '', entries: [] }
  for (const event of [
    { type: 'tool.start', payload: { tool_id: 'r', name: 'drama_material_import', args: { path: '/a/原剧大纲.xlsx' } } },
    { type: 'tool.complete', payload: { tool_id: 'r', name: 'drama_material_import', result: { ok: false, error: '资料文件不存在' } } },
    { type: 'tool.start', payload: { tool_id: 's', name: 'drama_agent_document', args: { action: 'save', name: '第01—03集 剧本正文' } } }
  ]) conversation = reduceEvent(conversation, { ...event, session_id: 'runtime' })
  workspace.conversation.set(conversation)
  render(<Transcript onInspect={() => {}} />)
  expect(screen.getByText('正在保存稿件 第01—03集 剧本正文…')).toBeTruthy()
  expect(screen.getByText('未能读取原稿')).toBeTruthy()
  expect(screen.getByText(/资料文件不存在/)).toBeTruthy()
})

const episode = (n: number, tag: string) => `第0${n}集\n\n${n}-1场  冰峰堡垒  夜  内\n\n` + `△艾拉${tag}${n}看着莫拉。\n\n`.repeat(6)
const visibleText = () => [...document.querySelectorAll('.assistant-message .markdown')].filter(node => !node.closest('.revision-draft')).map(node => node.textContent).join('')

test('整批返修在原位替换：只显示一份正文，初稿可点开对照', () => {
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 't', text: '写第1-3集剧本正文', calls: [] },
    { id: 'a1', role: 'assistant', turnId: 't', text: [1, 2, 3].map(n => episode(n, '初稿')).join('\n'), calls: [] },
    { id: 'check', role: 'activity', text: '', calls: [{ id: 'check-1', name: 'drama_agent_document', label: '核验稿件', state: 'complete', revisionEvidence: { documentId: 'doc-123', qualityStatus: 'fail', previousDocumentId: 'doc-old', sourceMessageId: 'a1' } }] },
    { id: 'a2', role: 'assistant', turnId: 't', text: [1, 2, 3].map(n => episode(n, '修订')).join('\n'), calls: [] }
  ] })
  render(<Transcript onInspect={() => {}} />)
  const note = screen.getByText('本次已修改上方正文')
  expect(visibleText()).toContain('艾拉修订2看着莫拉')
  expect(visibleText()).not.toContain('艾拉初稿')
  expect(document.querySelectorAll('.assistant-message')).toHaveLength(1)
  // 修订说明在正文之后。
  const body = [...document.querySelectorAll('.assistant-message p')].find(node => node.textContent?.includes('艾拉修订3'))!
  expect(body.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看修订前的初稿' }))
  const draft = document.querySelector('.revision-draft')!
  expect(draft.querySelector('header')?.textContent).toContain('修改前版本，仅供对照')
  expect(draft.textContent).toContain('艾拉初稿2看着莫拉')
})

test('只返修第2集：放回第2集原位，顺序不变，开场白不显示，说明在正文之后', () => {
  let conversation: Conversation = { runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 't', text: '写第1-3集剧本正文', calls: [] },
    { id: 'a1', role: 'assistant', turnId: 't', text: [1, 2, 3].map(n => episode(n, '初稿')).join('\n'), calls: [] }
  ] }
  conversation = reduceEvent(conversation, { session_id: 'runtime', type: 'tool.complete', payload: { tool_id: 'save', name: 'drama_agent_document', args: { action: 'save', name: '第01—03集' }, result: { ok: true, document: { id: 'doc-45', source_message_id: 'a1' }, quality_check: { status: 'fail', revisions_remaining: 1, issues: [{ code: 'above_maximum', episode: 2, difference: 10 }] } } } })
  conversation = { ...conversation, entries: [...conversation.entries,
    { id: 'a2', role: 'assistant', turnId: 't', text: '根据核验结果，修订第2集如下：\n\n' + episode(2, '修订') + '\n本轮返修：第2集补足篇幅。', calls: [] }] }
  workspace.conversation.set(conversation)
  render(<Transcript onInspect={() => {}} />)
  const text = visibleText()
  const order = ['艾拉初稿1', '艾拉修订2', '艾拉初稿3', '本轮返修'].map(mark => text.indexOf(mark))
  expect(order.every(position => position >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(text).not.toContain('艾拉初稿2')
  expect(text).not.toContain('根据核验结果，修订第2集如下')
  expect(document.querySelectorAll('.assistant-message')).toHaveLength(1)
})

test('同一轮接着写新的集数不是返修，照常另起显示', () => {
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 't', text: '写第1-6集剧本正文', calls: [] },
    { id: 'a1', role: 'assistant', turnId: 't', text: [1, 2, 3].map(n => episode(n, '第一批')).join('\n'), calls: [] },
    { id: 'a2', role: 'assistant', turnId: 't', text: [4, 5, 6].map(n => episode(n, '第二批')).join('\n'), calls: [] }
  ] })
  render(<Transcript onInspect={() => {}} />)
  expect(screen.queryByText('已按核验结果修订')).toBeNull()
  const text = visibleText()
  expect(text.indexOf('艾拉第一批3')).toBeLessThan(text.indexOf('艾拉第二批4'))
})

test('同集普通回复没有核验身份回执时不覆盖初稿', () => {
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 't', text: '写第2集剧本正文', calls: [] },
    { id: 'a1', role: 'assistant', turnId: 't', text: episode(2, '初稿').repeat(4), calls: [] },
    { id: 'unrelated', role: 'activity', text: '', calls: [{ id: 'check-other', name: 'drama_agent_document', label: '核验稿件', state: 'complete', revisionEvidence: { documentId: 'other', qualityStatus: 'fail', sourceMessageId: 'unrelated-message' } }] },
    { id: 'a2', role: 'assistant', turnId: 't', text: episode(2, '普通回复').repeat(4), calls: [] }
  ] })
  render(<Transcript onInspect={() => {}} />)
  const text = [...document.querySelectorAll('.assistant-message .markdown')].map(node => node.textContent).join('')
  expect(text).toContain('艾拉初稿2')
  expect(text).toContain('艾拉普通回复2')
  expect(document.querySelectorAll('.assistant-message')).toHaveLength(2)
  expect(document.querySelector('.revision-note')).toBeNull()
})

test('跨消息按稿件 lineage 归并版本，同名的独立稿件仍各有卡片', () => {
  const oldPath = '/assets-data/' + 'a'.repeat(32) + '/第2集正文-v1.docx'
  const newPath = '/assets-data/' + 'b'.repeat(32) + '/第2集正文-v2.docx'
  const oldArtifact = { id: 'doc-old', name: '第2集正文', content: episode(2, '初稿'), kind: 'result' as const,
    documentKind: 'script', contentSha256: 'a'.repeat(64), sourceMessageId: 'm1', downloadPath: oldPath, downloadName: '第2集正文-v1.docx', downloadFormat: 'docx' }
  const newArtifact = { id: 'doc-new', name: '第2集正文', content: episode(2, '修订'), kind: 'result' as const,
    documentKind: 'script', sourceMessageId: 'm2', previousDocumentId: 'doc-old', previousContentSha256: 'a'.repeat(64), downloadPath: newPath, downloadName: '第2集正文-v2.docx', downloadFormat: 'docx' }
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  const alternative = { ...oldArtifact, id: 'alternative', sourceMessageId: 'm3', content: '独立方案正文', downloadPath: '/assets-data/' + 'c'.repeat(32) + '/独立方案.docx', downloadName: '独立方案.docx' }
  workspace.project.set({ id: 'p', title: 'p', stage: 'M3', artifacts: [oldArtifact, newArtifact, alternative], agentId: 'gm3-1' })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 't', text: '写第2集并按核验结果修订', calls: [] },
    { id: 'm1', role: 'assistant', turnId: 't', text: episode(2, '初稿'), calls: [] },
    { id: 'm2', role: 'assistant', turnId: 't', text: episode(2, '修订'), calls: [] },
    { id: 'm3', role: 'assistant', turnId: 't', text: '独立方案正文', calls: [] }
  ] })
  render(<Transcript onInspect={() => {}} />)
  expect(screen.getAllByRole('region', { name: /完整剧本正文：/ })).toHaveLength(2)
  expect(screen.getByText('第2集正文-v2.docx')).toBeTruthy()
  expect(screen.getByText('独立方案.docx')).toBeTruthy()
  expect(screen.queryByText('第2集正文-v1.docx')).toBeNull()
  expect(visibleText()).not.toContain('艾拉初稿2')
  expect(visibleText()).toContain('艾拉修订2')
})

test('实时与历史原位合并修订稿，操作记录不把待修问题显示为修改结论', () => {
  const failed = { ok: true, document: { name: '第04—05集 剧本正文' }, quality_check: { status: 'fail', revisions_remaining: 1,
    issues: [{ code: 'above_maximum', episode: 5, difference: 313 }, { code: 'market_mismatch' }] } }
  const entries = [
    { id: 'u', role: 'user', turnId: 'u', text: '写第4—5集', calls: [] },
    { id: 'r1', role: 'activity', text: '', calls: [{ id: 'c1', name: 'skill_view', label: '读取创作规则', verb: '读取创作规则', object: '巨豹 Agent1 · 适配满血版 V1.1', state: 'complete' }] },
    { id: 't1', role: 'thinking', text: '', calls: [] },
    { id: 'r2', role: 'activity', text: '', calls: [{ id: 'c2', name: 'drama_material_import', label: '读取原稿', verb: '读取原稿', object: '十年劫.docx', state: 'complete' }] },
    { id: 'a1', role: 'assistant', turnId: 'x1', text: [4, 5].map(n => episode(n, '初稿')).join('\n'), calls: [] },
    { id: 'r3', role: 'activity', text: '', calls: [{ id: 'c3', name: 'drama_agent_document', label: '管理剧本稿件', verb: '保存稿件', object: '第04—05集 剧本正文', state: 'complete', resultSummary: resultSummary(failed), revisionEvidence: { documentId: 'doc-45', qualityStatus: 'fail', previousDocumentId: 'doc-old', sourceMessageId: 'a1' } }] },
    { id: 't2', role: 'thinking', text: '', calls: [] },
    { id: 'a2', role: 'assistant', turnId: 'x2', text: '发现第5集超长，修订如下：\n\n' + episode(5, '修订'), calls: [] },
    { id: 't3', role: 'thinking', text: '', calls: [], pending: true }
  ] as Entry[]
  workspace.conversation.set({ runtimeId: 'runtime', running: true, error: '', entries })
  render(<Transcript onInspect={() => {}} />)
  expect(screen.queryByText('已思考')).toBeNull()
  const groups = document.querySelectorAll('.activity-group')
  expect(groups).toHaveLength(2)
  const message = document.querySelector('.assistant-message')!
  expect(groups[0].compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(message.compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(document.querySelector('[data-document-check]')).toBeNull()
  expect(visibleText()).not.toMatch(/通过|核验|313字|正在修订/)
  expect(screen.getByText('正在整理本次稿件…')).toBeTruthy()
  const text = visibleText()
  expect(text.indexOf('艾拉初稿4')).toBeLessThan(text.indexOf('艾拉修订5'))
  expect(text).not.toContain('艾拉初稿5')
})

test('返修完成后只保留中性修改记录，不把质量状态显示为结论', () => {
  const failed = { ok: true, quality_check: { status: 'fail', revisions_remaining: 1, issues: [{ code: 'above_maximum', episode: 5, difference: 313 }] } }
  const passed = { ok: true, quality_check: { status: 'pass' } }
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 'u', text: '写第4—5集', calls: [] },
    { id: 'a1', role: 'assistant', turnId: 'x1', text: [4, 5].map(n => episode(n, '初稿')).join('\n'), calls: [] },
    { id: 'r1', role: 'activity', text: '', calls: [{ id: 'c1', name: 'drama_agent_document', label: '管理剧本稿件', verb: '保存稿件', object: '第04—05集 剧本正文', state: 'complete', resultSummary: resultSummary(failed), revisionEvidence: { documentId: 'doc-45', qualityStatus: 'fail', previousDocumentId: 'doc-old', sourceMessageId: 'a1' } }] },
    { id: 'a2', role: 'assistant', turnId: 'x2', text: episode(5, '修订'), calls: [] },
    { id: 'r2', role: 'activity', text: '', calls: [{ id: 'c2', name: 'drama_agent_document', label: '管理剧本稿件', verb: '保存稿件', object: '第04—05集 剧本正文', state: 'complete', resultSummary: resultSummary(passed), revisionEvidence: { documentId: 'doc-45', qualityStatus: 'pass' } }] }
  ] as Entry[] })
  render(<Transcript onInspect={() => {}} />)
  const groups = document.querySelectorAll('.activity-group')
  expect(groups).toHaveLength(1)
  expect(document.querySelector('[data-document-check]')).toBeNull()
  expect(visibleText()).not.toMatch(/通过|核验|313字/)
  expect(screen.getByText('本次已修改上方正文')).toBeTruthy()
  expect(document.querySelector('.assistant-message')!.compareDocumentPosition(groups[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('旧历史里的多次核验只作为保存记录，不重复显示自查状态', () => {
  const failed = (difference: number) => ({ ok: true, quality_check: { status: 'fail', revisions_remaining: 1, issues: [{ code: 'above_maximum', episode: 5, difference }] } })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'u', role: 'user', turnId: 'u', text: '写第4—5集', calls: [] },
    { id: 'a1', role: 'assistant', turnId: 'x1', text: [4, 5].map(n => episode(n, '初稿')).join('\n'), calls: [] },
    { id: 'r1', role: 'activity', text: '', calls: [{ id: 'c1', name: 'drama_agent_document', label: '管理剧本稿件', verb: '保存稿件', object: '第04—05集 剧本正文', state: 'complete', resultSummary: resultSummary(failed(313)), revisionEvidence: { documentId: 'doc-45', qualityStatus: 'fail', previousDocumentId: 'doc-old', sourceMessageId: 'a1' } }] },
    { id: 'n1', role: 'assistant', turnId: 'x2', text: '第5集超出上限，下面删减。', calls: [] },
    { id: 'r2', role: 'activity', text: '', calls: [{ id: 'c2', name: 'drama_agent_document', label: '管理剧本稿件', verb: '保存稿件', object: '第04—05集 剧本正文', state: 'complete', resultSummary: resultSummary(failed(80)), revisionEvidence: { documentId: 'doc-45', qualityStatus: 'fail', previousDocumentId: 'doc-old', sourceMessageId: 'a1' } }] }
  ] as Entry[] })
  render(<Transcript onInspect={() => {}} />)
  const titles = [...document.querySelectorAll('.activity-group .activity-title')].map(node => node.textContent)
  expect(titles.every(text => !/通过|核验|修订|达到/.test(text || ''))).toBe(true)
  expect(visibleText()).toContain('第5集超出上限，下面删减。')
})


test('历史宿主核验尾注隐藏但角色台词和真实修改说明保留，质量回执不提前声称已改', () => {
  const body = '第1集\n\n1-1场 接待室 日 内\n\n人物：艾拉\n\n艾拉：申请未通过。\n\n本次修改：保留证据链，补充了开门动作。'
  const notice = '\n\n> 【系统核验】这份稿件还有以下地方没达到要求，可按以下问题继续调整：\n>\n> - 第1集正文超过要求。'
  const result = { ok: true, quality_check: { status: 'fail', revisions_remaining: 1, issues: [{ code: 'above_maximum', episode: 1, difference: 313 }] } }
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([
    { role: 'user', content: '请保留“未通过”这句台词。' },
    { role: 'assistant', content: body + notice },
    { role: 'tool', name: 'drama_agent_document', args: { action: 'save', name: '第1集' }, content: JSON.stringify(result) }
  ]) })
  render(<Transcript />)
  const text = visibleText()
  expect(text).toContain('艾拉：申请未通过。')
  expect(text).toContain('本次修改：保留证据链，补充了开门动作。')
  expect(text).not.toContain('【系统核验】')
  expect(text).not.toContain('313')
  expect(text).not.toContain('正在修订')
  expect(text).not.toContain('已修改上方正文')
})
