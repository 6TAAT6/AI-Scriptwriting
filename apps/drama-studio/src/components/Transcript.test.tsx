import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { workspace, type WorkspaceApi } from '../store/workspace'
import { historyEntries, reduceEvent, type Conversation } from '../lib/transcript'
import { mergeProjectArtifacts, projectFromResult } from '../lib/creative'
import { gateway } from '../lib/gateway'
import * as downloads from '../lib/download'
import { Transcript } from './Transcript'
import { Composer } from './Composer'

beforeEach(() => workspace.reset())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('助手只回复摘要时仍可直接展开已保存全文，晚到资料绑定原回合且不触发生成', async () => {
  const path = '/assets-data/' + 'f'.repeat(32) + '/第1至10集正文.docx'
  const content = '第01集\n\n1-1场 餐馆 日 内\n\nEmma：先核对发票。\n\n第10集\n\n10-3场 餐馆 夜 内\n\nLucas：原始收据在蓝色封套里。'
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([
    { role: 'user', row_id: 1, content: '写前十集正文' },
    { role: 'tool', row_id: 2, tool_call_id: 'save', name: 'drama_agent_document', content: JSON.stringify({ ok: true, receipt: { path, name: '第1至10集正文.docx', format: 'docx' } }) },
    { role: 'assistant', row_id: 3, content: '十集已保存，剧情摘要：主角发现了账本问题。' },
    { role: 'user', row_id: 4, content: '解释人物动机' },
    { role: 'assistant', row_id: 5, content: '她希望核对当事人的说法。' }
  ]) })
  const rpc = vi.spyOn(workspace.api, 'rpc').mockRejectedValue(new Error('阅读已存正文不允许发生成请求'))
  render(<Transcript onReadFile={() => {}} />)
  act(() => workspace.project.set(projectFromResult({ project: { id: 'agent-docs', agent_id: 'gm3-1',
    artifacts: [{ id: 'script-ten', name: '第1至10集正文', kind: 'script', content }],
    exports: [{ artifact_id: 'script-ten', path, name: '第1至10集正文.docx', format: 'docx', content_verified: true, layout_verified: false,
      text_statistics: { method: 'unicode_han_and_non_whitespace_v1', han_characters: 34, non_whitespace_characters: 85 } }]
  } })))
  const card = await screen.findByRole('region', { name: '完整剧本正文：第1至10集正文' })
  expect(card.compareDocumentPosition(screen.getByText('解释人物动机')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(card).getByText(/34 汉字/)).toBeTruthy()
  expect(within(card).getByText(/WPS 未检查/)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: '展开完整正文' }))
  expect(await within(card).findByText('Lucas：原始收据在蓝色封套里。')).toBeTruthy()
  expect(rpc).not.toHaveBeenCalled()
})

test('已有下载链接仍提供完整正文入口，单页回执不能替换该入口中的全文', async () => {
  const path = '/assets-data/' + 'a'.repeat(32) + '/正文.docx'
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: historyEntries([
    { role: 'user', content: '重新发正文' },
    { role: 'tool', tool_call_id: 'export', name: 'drama_agent_document', content: JSON.stringify({ ok: true, receipt: { path, name: '正文.docx', format: 'docx' } }) },
    { role: 'assistant', content: `[正文.docx](${path})` }
  ]) })
  workspace.project.set(projectFromResult({ project: { id: 'docs', agent_id: 'gm3-1', artifacts: [
    { id: 'full', name: '正文', content: '第01集\n\n△Emma坐下。\n\n第10集\n\n△Lucas合上账本。', kind: 'script' }
  ], exports: [{ artifact_id: 'full', path, name: '正文.docx', format: 'docx' }] } }))
  render(<Transcript onReadFile={() => {}} />)
  const card = await screen.findByRole('region', { name: '完整剧本正文：正文' })
  fireEvent.click(within(card).getByRole('button', { name: '展开完整正文' }))
  expect(await within(card).findByText('△Lucas合上账本。')).toBeTruthy()
  act(() => workspace.project.set(mergeProjectArtifacts(projectFromResult({
    document: { id: 'full', content: '第01集', has_more: true },
    project: { id: 'docs', agent_id: 'gm3-1', artifacts: [{ id: 'full', name: '正文', characters: 80 }], exports: [] }
  }), workspace.project.get())))
  expect(within(card).getByText('△Lucas合上账本。')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '下载 Word：正文.docx' })).toHaveLength(1)
  expect(within(card).queryByText(/汉字/)).toBeNull()
})

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

test('普通完成回复没有协议时也渲染带边框的下一步卡片，并可填入当前对话框', () => {
  workspace.connection.set('open')
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'user', role: 'user', text: '帮我修改作文，沿用当前对话已经确认的要求。', calls: [] },
    { id: 'assistant', role: 'assistant', text: '作文已经完成。接下来请补充你想修改的重点。', calls: [] }
  ] })

  render(<><Transcript onInspect={() => {}} /><Composer /></>)
  const section = screen.getByRole('region', { name: '接下来，你可以' })
  expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0)
  const firstCard = within(section).getAllByRole('listitem')[0]
  expect(firstCard.className).toContain('next-step-card')
  const edit = within(firstCard).getByRole('button', { name: /填入编辑/ })
  fireEvent.click(edit)
  expect((screen.getByRole('textbox', { name: '给巨豹智能体发送消息' }) as HTMLTextAreaElement).value).toContain('请结合当前对话')
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
  fireEvent.click(screen.getByText('阅读资料、保存文件'))
  expect(screen.getByText('2 个工具')).toBeTruthy()
  expect(screen.queryByText(/工具累计|用时.*秒|耗时未记录/)).toBeNull()
  expect(screen.getByText('资料：原稿.md')).toBeTruthy()
  expect(screen.getByText('已读取 120 行')).toBeTruthy()
  expect(screen.getByText('大纲已保存')).toBeTruthy()
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

test('思考和公开状态按消息顺序内联显示，推理原文不进入正文或复制操作', () => {
  workspace.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'thinking', role: 'thinking', text: 'PRIVATE_REASONING', calls: [], pending: false },
    { id: 'review', role: 'status', text: '技能已加载，正在核对分集资料。', calls: [], noticeKind: 'status.update' },
    { id: 'answer', role: 'assistant', text: '第九集草稿已保存。', calls: [] },
    { id: 'reflection', role: 'status', text: '已修补创作回执格式。', calls: [], noticeKind: 'review.summary' }
  ] })
  render(<Transcript onInspect={() => {}} />)
  const thinking = screen.getByText('已思考')
  const review = screen.getByText('技能已加载，正在核对分集资料。')
  const answer = screen.getByText('第九集草稿已保存。')
  expect(thinking.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
