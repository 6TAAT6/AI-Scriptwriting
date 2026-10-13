import { expect, test } from 'vitest'
import { availableSuggestions, splitSuggestions } from './suggestions'
import type { Conversation } from './transcript'

const choices = [
  { label: '继续下一批新纲', prompt: '请继续第 21—24 集新纲，沿用已确认的改编方向。' },
  { label: '调整这一批', prompt: '我想调整第 17—20 集。请先列出可以调整的重点，等我补充意见后再修改。' },
  { label: '回顾整体进度', prompt: '请梳理目前已验收的新纲和尚未完成的故事线。' }
]
const block = '\n\n```studio-suggestions\n' + JSON.stringify(choices) + '\n```'

test('流式正文保留阶段说明，建议协议不进入正文，完成后接受有边界的实际选项', () => {
  const text = '第 17—20 集新纲已验收。'
  for (let index = 1; index <= block.length; index++) {
    const parsed = splitSuggestions(text + block.slice(0, index), true)
    expect(parsed.text).not.toMatch(/studio-suggestions|"label"|"prompt"/)
    expect(parsed.suggestions).toEqual([])
  }
  expect(splitSuggestions(text + block)).toEqual({ text, suggestions: choices })
  expect(splitSuggestions(text + block.replace('studio-suggestions\n', 'studio-suggestions \t\n'))).toEqual({ text, suggestions: choices })
  expect(splitSuggestions(text + '\n\n```studio-suggest')).toEqual({ text, suggestions: [] })
  expect(splitSuggestions(text + '\n\n```studio-suggestions\nNOT_JSON\n```')).toEqual({ text, suggestions: [] })
  expect(splitSuggestions(text + '\n\n```studio-suggestions\n' + JSON.stringify([...choices, choices[0]]) + '\n```').suggestions).toEqual(choices)
  expect(splitSuggestions(text + '\n\n```studio-suggestions\n' + JSON.stringify(choices.slice(0, 2)) + '\n```').suggestions).toEqual(choices.slice(0, 2))
  expect(splitSuggestions('正文中的普通代码：\n```json\n{"label":"原文"}\n```').text).toContain('"label":"原文"')
})

test('只为最新已完成回复提供建议，执行中、后台任务、失败和新用户消息都不会沿用旧选项', () => {
  const state: Conversation = { runtimeId: 's', running: false, error: '', entries: [
    { id: 'u', role: 'user', text: '继续新纲', calls: [] },
    { id: 'a', role: 'assistant', text: '第 17—20 集新纲已验收。' + block, calls: [] }
  ] }
  expect(availableSuggestions(state)).toMatchObject({ entryId: 'a', suggestions: choices })
  expect(availableSuggestions({ ...state, running: true })).toBeNull()
  expect(availableSuggestions({ ...state, asyncPending: 1 })).toBeNull()
  expect(availableSuggestions({ ...state, error: '中断' })).toBeNull()
  expect(availableSuggestions({ ...state, entries: [...state.entries, { id: 'next', role: 'user', text: '修改人物', calls: [] }] })).toBeNull()
  const previous = { ...state, entries: [{ id: 'old', role: 'assistant' as const, text: '下一步可以继续后续新纲，也可以修改这一批。', calls: [] }] }
  expect(availableSuggestions(previous)?.entryId).toBe('old')
})

test('待选方案时直接提供实际 A B C 选项，普通回复提供不虚构进度的安全建议', () => {
  const state = (text: string): Conversation => ({ runtimeId: 's', running: false, error: '', entries: [{ id: 'answer', role: 'assistant', text, calls: [] }] })
  const screenshot = '本步已完成正式状态核对，并明确当前停在方案选择，而不是新纲续写。你可以回复“继续《山有木兮木有枝》，选A”，或选择B、C；若想调整，可以说“保留A的古装边城背景，但减少军械术语”。'
  const options = availableSuggestions(state(screenshot))!.suggestions
  expect(options.map(row => row.label)).toEqual(['选择 A', '选择 B', '选择 C'])
  expect(options[1].prompt).toContain('方案 B')
  expect(options.map(row => row.prompt).join('')).not.toContain('核对当前项目')
  const named = availableSuggestions(state('## A．古装边城\n说明。\n## B．现代家族\n说明。\n请选择 A 或 B。'))!.suggestions
  expect(named.map(row => row.label)).toEqual(['选择 A · 古装边城', '选择 B · 现代家族'])
  const marked = availableSuggestions(state('## A．古装边城【推荐】\n说明。\n## B．现代家族\n说明。\n请选择 A 或 B。'))!.suggestions
  expect(marked.find(row => row.recommended)?.label).toBe('选择 A · 古装边城')
  const structured = splitSuggestions('正文。\n\n```studio-suggestions\n' + JSON.stringify([
    { label: '采用推荐方向', prompt: '按推荐方向继续。', recommended: true },
    { label: '改成另一个方向', prompt: '改用另一方向。' }
  ]) + '\n```')
  expect(structured.suggestions[0].recommended).toBe(true)
  expect(splitSuggestions('正文。\n\n```studio-suggestions\n' + JSON.stringify([
    { label: '方案一', prompt: '一。', recommended: true },
    { label: '方案二', prompt: '二。', recommended: true }
  ]) + '\n```').suggestions.filter(row => row.recommended)).toHaveLength(1)
  expect(availableSuggestions(state('已按你选择的方案 A 保存草稿，方案 B 和 C 不再采用。'))?.suggestions.map(row => row.label)).not.toContain('选择 B')
  expect(availableSuggestions(state('原稿已收到。'))?.suggestions.length).toBeGreaterThan(0)
})


test('协议格式轻微偏差与无效单项不会丢掉其他建议，流式协议仍不会泄露到正文', () => {
  const valid = choices.slice(0, 2)
  const source = '\n\n~~~ Studio-Suggestions \n' + JSON.stringify({ suggestions: [valid[0], { label: '无效项' }, valid[0], valid[1]] }) + '\n  ~~~'
  expect(splitSuggestions('正文。' + source)).toEqual({ text: '正文。', suggestions: valid })
  expect(splitSuggestions('正文。' + source, true)).toEqual({ text: '正文。', suggestions: [] })
  expect(splitSuggestions('正文。\n\n```studio-suggestions\nNOT_JSON\n```' + source)).toEqual({ text: '正文。', suggestions: valid })
  const onlyProtocol = { runtimeId: 's', running: false, error: '', entries: [{ id: 'answer', role: 'assistant' as const, text: source, calls: [] }] }
  expect(availableSuggestions(onlyProtocol)?.suggestions).toEqual(valid)
  const precise = [{ label: '保留我指定的人名', prompt: '我选择方案 B，但保留本轮已明确要求的人名，不采用默认更名。' }]
  expect(availableSuggestions({ ...onlyProtocol, entries: [{ ...onlyProtocol.entries[0], text: '请选择 A 或 B。\n\n```studio-suggestions\n' + JSON.stringify(precise) + '\n```' }] })?.suggestions).toEqual(precise)
  const tolerant = '正文。\n\n```studio-suggestions\njson\n{"options":' + JSON.stringify(valid).replace('}]', '},]') + '}\n```'
  expect(splitSuggestions(tolerant).suggestions).toEqual(valid)
  const punctuation = [{ label: '保留原始标点', prompt: '请保留文中的 ,} 和 ,] 标点，不要改动。' }]
  expect(splitSuggestions('正文。\n```studio-suggestions\n' + JSON.stringify(punctuation) + '\n```').suggestions).toEqual(punctuation)
})

test('纯文字行动建议和无协议的普通完成回复都有可操作卡片，兜底不替用户选择或虚构事实', () => {
  const state = (text: string): Conversation => ({ runtimeId: 's', running: false, error: '', entries: [
    { id: 'u', role: 'user', text: '帮我修改作文，沿用当前对话已经确认的要求。', calls: [] },
    { id: 'a', role: 'assistant', text, calls: [] }
  ] })
  const quoted = availableSuggestions(state('作文已经调整好了。你可以回复“把这篇作文改得更像学生写的”，也可以说“再补一个真实事例”。'))!.suggestions
  expect(quoted.map(row => row.prompt)).toEqual(['把这篇作文改得更像学生写的', '再补一个真实事例'])
  const listed = availableSuggestions(state('作文已经调整好了。\n\n接下来，你可以：\n- **改写成议论文**：请用同一主题改写成议论文。\n- **增加真实事例**：请根据上文补充真实事例，不编造来源。'))!.suggestions
  expect(listed.map(row => row.label)).toEqual(['改写成议论文', '增加真实事例'])
  expect(listed[1].prompt).toBe('请根据上文补充真实事例，不编造来源。')
  for (const text of ['作文已调整完成。', '请补充你想修改的重点。', '正文。\n```studio-suggestions\nNOT_JSON\n```']) {
    const result = availableSuggestions(state(text))!
    expect(result.entryId).toBe('a')
    expect(result.suggestions.length).toBeGreaterThan(0)
    expect(result.suggestions.every(row => row.label && row.prompt.includes('当前对话'))).toBe(true)
    expect(result.suggestions.map(row => row.prompt).join('')).not.toMatch(/(?:^|[。；])我(?:选择|确认)|第 \d+|已验收|自动发送/)
  }
})
