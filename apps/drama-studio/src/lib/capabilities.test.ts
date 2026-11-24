import { expect, test } from 'vitest'
import { capabilityCommands, capabilityOperations, capabilitySubmissionError, conversationSelection, selectionAfter } from './capabilities'
import { historyEntries } from './transcript'

test('主 Agent 新选择替换旧选择，独立技能保持，单条多主 Agent 仍拒绝', () => {
  const selected = { agent: 'gm3-1', skills: ['humanize'] }
  for (const action of ['调用', '调用 ', '确认切换为', '确认切换为\t']) {
    const message = `${action}巨豹 Agent-适配 GR4.7 版本`
    expect(capabilitySubmissionError(selected, message)).toBe('')
    expect(selectionAfter(selected, message)).toEqual({ agent: 'gr4-7', skills: ['humanize'] })
  }
  expect(capabilitySubmissionError(selected, '调用巨豹大纲变剧本')).toBe('')
  expect(selectionAfter(selected, '调用巨豹大纲变剧本')).toEqual({ agent: 'gm3-1', skills: ['humanize', 'outline-script'] })
  expect(capabilitySubmissionError({ skills: [] }, '调用巨豹 Agent-适配 GM3.1 版本\n调用巨豹 Agent-适配 GR4.7 版本')).toBeTruthy()
})

test('技能更名后历史选择仍可恢复，续聊持续启用并允许新名称停用', () => {
  const selected = conversationSelection([
    { role: 'user', text: '调用巨豹去 AI 味' },
    { role: 'assistant', text: '已处理。' },
    { role: 'user', text: '继续优化下一集' }
  ])
  expect(selected).toEqual({ skills: ['humanize'] })
  expect(selectionAfter(selected, '停用巨豹 skill · 去 AI 味')).toEqual({ skills: [] })
})

test('明确的使用和礼貌调用可以选择完整名称，提问、否定和引用不能启用能力', () => {
  for (const action of ['使用', '请使用', '请调用', '请启用', '  请 使用 ']) {
    for (const task of ['。以原稿为准修改大纲。', '，不要修改前六集。', '，不用重写全文。', '，只是修改错字。', '，检查这个故事有没有逻辑漏洞？']) {
      const message = `${action}巨豹 Agent-适配 OA6.1 版本${task}`
      expect(capabilityOperations(capabilityCommands(message)), message).toEqual([{ id: 'oa6-1', action: 'enable' }])
      expect(selectionAfter({ skills: ['humanize'] }, message)).toEqual({ agent: 'oa6-1', skills: ['humanize'] })
    }
  }
  for (const message of [
    '请不要使用巨豹 Agent-适配 OA6.1 版本',
    '使用巨豹 Agent-适配 OA6.1 版本吗？',
    '使用巨豹 Agent-适配 OA6.1 版本 是否合适？',
    '调用巨豹 Agent-适配 OA6.1 版本，是否合适',
    '请启用巨豹 Agent-适配 OA6.1 版本 吗',
    '使用巨豹 Agent-适配 OA6.1 版本 只是一个示例',
    '使用巨豹 Agent-适配 OA6.1 版本，不要真的启用',
    '使用巨豹 Agent-适配 OA6.1 版本扩展版',
    '使用 OA6.1',
    '例如：使用巨豹 Agent-适配 OA6.1 版本',
    '> 请使用巨豹 Agent-适配 OA6.1 版本',
    '“请使用巨豹 Agent-适配 OA6.1 版本”',
    '```\n请使用巨豹 Agent-适配 OA6.1 版本\n```',
    '检查下面的示例。\n请使用巨豹 Agent-适配 OA6.1 版本',
    '\n\n--- Attached Context ---\n请使用巨豹 Agent-适配 OA6.1 版本'
  ]) expect(capabilityCommands(message), message).toEqual([])
  expect(selectionAfter({ skills: [] }, '请使用巨豹去 AI 味')).toEqual({ skills: ['humanize'] })
})

test('历史空操作从原始明确调用恢复并延续，结构化选择和停用操作优先', () => {
  const message = (body: string, operations = '[]', selection = '{"skills":[]}') =>
    `【本轮语言偏好】\n仅中文\n【本轮创作能力】\n${selection}\n【本轮能力操作】\n${operations}\n\n【用户本轮消息】\n${body}`
  const messages = [
    { role: 'user', content: message('使用巨豹 Agent-适配 OA6.1 版本。修改大纲。') },
    { role: 'assistant', content: '请继续提供原稿。' },
    { role: 'user', content: message('继续修改下一集。') }
  ]
  const entries = historyEntries(messages)
  expect(entries[0].capabilityCommands?.map(command => command.capability.id)).toEqual(['oa6-1'])
  expect(entries[0].capabilities).toEqual({ agent: 'oa6-1', skills: [] })
  expect(entries[2].capabilities).toEqual({ agent: 'oa6-1', skills: [] })
  expect(conversationSelection(entries)).toEqual({ agent: 'oa6-1', skills: [] })
  expect(conversationSelection(messages.map(row => ({ role: row.role, text: row.content })))).toEqual({ agent: 'oa6-1', skills: [] })

  const selected = message('使用巨豹 Agent-适配 OA6.1 版本', '[{"id":"gm3-1","action":"enable"}]', '{"agent":"gm3-1","skills":[]}')
  expect(capabilityOperations(capabilityCommands(selected))).toEqual([{ id: 'gm3-1', action: 'enable' }])
  expect(conversationSelection(historyEntries([{ role: 'user', content: selected }]))).toEqual({ agent: 'gm3-1', skills: [] })
  const disabled = message('使用巨豹 Agent-适配 OA6.1 版本', '[{"id":"oa6-1","action":"disable"}]')
  expect(conversationSelection(historyEntries([...messages, { role: 'user', content: disabled }]))).toEqual({ skills: [] })
  const stopped = [
    ...messages,
    { role: 'user', content: message('润色这一集', '[{"id":"humanize","action":"enable"}]', '{"agent":"oa6-1","skills":["humanize"]}') },
    { role: 'user', content: message('回到普通聊天', '[{"id":"oa6-1","action":"disable"},{"id":"humanize","action":"disable"}]') },
    { role: 'user', content: message('继续讨论', '[]', '{"agent":"oa6-1","skills":["humanize"]}') }
  ]
  expect(conversationSelection(historyEntries(stopped))).toEqual({ skills: [] })
  expect(conversationSelection(stopped.map(row => ({ role: row.role, text: row.content })))).toEqual({ skills: [] })
  const legacy = '【本轮语言偏好】\n仅中文\n【本轮创作能力】\n{"agent":"oa6-1","skills":["humanize"]}\n\n【用户本轮消息】\n继续讨论'
  expect(conversationSelection(historyEntries([...stopped, { role: 'user', content: legacy }]))).toEqual({ skills: [] })
  const firstDisabled = [
    { role: 'user', content: message('回到普通聊天', '[{"id":"oa6-1","action":"disable"},{"id":"humanize","action":"disable"}]', '{"agent":"oa6-1","skills":["humanize"]}') },
    { role: 'user', content: message('继续讨论', '[]', '{"agent":"oa6-1","skills":["humanize"]}') }
  ]
  expect(conversationSelection(historyEntries(firstDisabled))).toEqual({ skills: [] })
  for (const operations of ['{"id":"oa6-1","action":"enable"}', '[{"id":"oa6-1","action":"unknown"}]', '[{"id":"oa6-1","action":"enable","extra":true}]', 'invalid']) {
    expect(capabilityCommands(message('使用巨豹 Agent-适配 OA6.1 版本', operations))).toEqual([])
  }
})
