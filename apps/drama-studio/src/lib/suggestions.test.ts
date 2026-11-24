import { expect, test } from 'vitest'
import { availableSuggestions, splitSuggestions, selectedSuggestion } from './suggestions'
import type { Conversation } from './transcript'

const choices = [
  { label: '继续下一批新纲', prompt: '请继续第 21—24 集新纲，沿用已确认的改编方向。' },
  { label: '调整这一批', prompt: '我想调整第 17—20 集。请先列出可以调整的重点，等我补充意见后再修改。' },
  { label: '回顾整体进度', prompt: '请梳理目前已验收的新纲和尚未完成的故事线。' }
]
const block = '\n\n```studio-suggestions\n' + JSON.stringify(choices) + '\n```'

test('新站省略代码围栏的卡片标记仍可展示并解析数字选择', () => {
  const prose = '第4-6集剧本正文已按您的要求更新。'
  const options = [{ label: '写第7—9集剧本正文', prompt: '请继续写第7—9集剧本正文。' },
    { label: '回顾与优化前6集', prompt: '请回顾并优化前6集的情节节奏。' }]
  for (const prefix of ['studio-suggestions: ', 'STUDIO-SUGGESTIONS：\n']) {
    const text = prose + '\n\n' + prefix + JSON.stringify(options)
    expect(splitSuggestions(text)).toEqual({ text: prose, suggestions: options })
    const conversation: Conversation = { runtimeId: 'inline', running: false, error: '', entries: [
      { id: 'a', role: 'assistant', text, calls: [] }
    ] }
    expect(availableSuggestions(conversation)?.suggestions).toEqual(options)
    expect(selectedSuggestion(conversation, '2')).toEqual(options[1])
  }
})

test('无围栏协议流式到达时不泄露 JSON，完成后才提供选项', () => {
  const suffix = '\n\nstudio-suggestions: ' + JSON.stringify(choices)
  for (let index = suffix.indexOf('studio-') + 7; index <= suffix.length; index++) {
    expect(splitSuggestions('正文。' + suffix.slice(0, index), true)).toEqual({ text: '正文。', suggestions: [] })
  }
  expect(splitSuggestions('正文。' + suffix)).toEqual({ text: '正文。', suggestions: choices })
})

test('无围栏标记只识别回复末尾操作，代码引用、示例和不完整数据保持原样', () => {
  const source = 'studio-suggestions: ' + JSON.stringify(choices)
  for (const text of ['代码示例：\n' + source, '正文。\n```text\n' + source + '\n```',
    '> ' + source, '正文。\n' + source + '\n这些只是示例。', '正文。\n' + source.slice(0, -1),
    '正文提到 ' + source]) expect(splitSuggestions(text)).toEqual({ text, suggestions: [] })
})

test('中转返回普通 JSON 的明确末尾操作选项也可显示为卡片', () => {
  const prose = '根据当前进度，请问您接下来希望执行哪项操作？'
  const text = prose + '\n\n```json\n' + JSON.stringify(choices) + '\n```'
  expect(splitSuggestions(text)).toEqual({ text: prose, suggestions: choices })
  expect(splitSuggestions(text, true)).toEqual({ text: prose, suggestions: [] })
  const conversation: Conversation = { runtimeId: 's', running: false, error: '', entries: [
    { id: 'a', role: 'assistant', text, calls: [] }
  ] }
  expect(availableSuggestions(conversation)).toEqual({ entryId: 'a', suggestions: choices })
})

test('新站已读确认后的末尾 JSON 选项不依赖额外的选择问句', () => {
  const prose = '我已确认阅读：短篇故事主角为林溪，地点为青石镇，创作过程中将保留关键人名地名。'
  const options = [{ label: '整理剧情摘要', prompt: '请整理剧情摘要。' }, { label: '扩写故事', prompt: '请扩写故事。' }]
  const text = prose + '\n\n```json\n' + JSON.stringify(options) + '\n```'
  expect(splitSuggestions(text)).toEqual({ text: prose, suggestions: options })
  const example = '已确认你的 JSON 数据示例，请原样查看：\n\n```json\n' + JSON.stringify(options) + '\n```'
  expect(splitSuggestions(example)).toEqual({ text: example, suggestions: [] })
})

test('剧情正文后的严格选项数组按结构识别，纯 JSON 交付仍保留原文', () => {
  const prose = '剧情摘要\n\n林溪在青石镇修理一台旧式座钟，在钟摆后发现父亲留下的归家信。'
  const options = [{ label: '扩写故事', prompt: '请根据刚才的摘要扩写故事。', recommended: true }]
  const json = '```json\n' + JSON.stringify(options) + '\n```'
  expect(splitSuggestions(prose + '\n\n' + json)).toEqual({ text: prose, suggestions: options })
  expect(splitSuggestions(json)).toEqual({ text: json, suggestions: [] })
})

test('普通 JSON 示例、不完整数据和正文中的数组不能被误转换为操作', () => {
  const data = '\n\n```json\n' + JSON.stringify(choices) + '\n```'
  for (const text of [
    '下面是接口的 JSON 示例：' + data,
    '下一步请检查这个 JSON 数据结构示例：' + data,
    '## JSON 示例\n\n这些是可复用的配置内容：' + data,
    '请选择下一步操作：' + data + '\n这是原始数据，请分析它。',
    '请告知下一步需求：\n```json\n[{"label":"选项","prompt":"请求","extra":"业务字段"}]\n```',
    '请选择下一步操作：\n```json\n[{"label":"缺少请求"}]\n```',
    '请选择下一步操作：\n```json\n[{"label":"选项","prompt":"请求"}'
  ]) expect(splitSuggestions(text)).toEqual({ text, suggestions: [] })
})

test('数字选择不沿用失败、未完成、后台任务及新用户回合的旧卡片', () => {
  const state: Conversation = { runtimeId: 's', running: false, error: '', entries: [
    { id: 'a', role: 'assistant', text: '请告知您的具体需求，我将为您处理。' + block.replace('studio-suggestions', 'json'), calls: [] }
  ] }
  expect(selectedSuggestion(state, '第2项')).toEqual(choices[1])
  for (const changed of [{ running: true }, { error: '失败' }, { asyncPending: 1 }, { turn: { state: 'unknown' } },
    { entries: [...state.entries, { id: 'u', role: 'user', text: '换一个问题', calls: [] }] }]) {
    expect(selectedSuggestion({ ...state, ...changed } as Conversation, '1')).toBeNull()
  }
  expect(selectedSuggestion({ ...state, entries: [{ id: 'a', role: 'assistant', text: '请选择 A 或 B。', calls: [] }] }, '1')).toBeNull()
})

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
  const previous = { ...state, entries: [{ id: 'old', role: 'assistant' as const, text: '接下来，你可以：\n- **继续后续新纲**：请继续写后续新纲。', calls: [] }] }
  expect(availableSuggestions(previous)?.entryId).toBe('old')
  // 回复里没有任何可选建议时不再补通用卡片。
  expect(availableSuggestions({ ...state, entries: [{ id: 'plain', role: 'assistant' as const, text: '下一步可以继续后续新纲，也可以修改这一批。', calls: [] }] })).toBeNull()
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
  expect(availableSuggestions(state('已按你选择的方案 A 保存草稿，方案 B 和 C 不再采用。'))?.suggestions.map(row => row.label) ?? []).not.toContain('选择 B')
  expect(availableSuggestions(state('原稿已收到。'))).toBeNull()
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

test('纯文字行动建议生成可操作卡片；回复里没有建议时不补通用卡片', () => {
  const state = (text: string): Conversation => ({ runtimeId: 's', running: false, error: '', entries: [
    { id: 'u', role: 'user', text: '帮我修改作文，沿用当前对话已经确认的要求。', calls: [] },
    { id: 'a', role: 'assistant', text, calls: [] }
  ] })
  const quoted = availableSuggestions(state('作文已经调整好了。你可以回复“把这篇作文改得更像学生写的”，也可以说“再补一个真实事例”。'))!.suggestions
  expect(quoted.map(row => row.prompt)).toEqual(['把这篇作文改得更像学生写的', '再补一个真实事例'])
  const listed = availableSuggestions(state('作文已经调整好了。\n\n接下来，你可以：\n- **改写成议论文**：请用同一主题改写成议论文。\n- **增加真实事例**：请根据上文补充真实事例，不编造来源。'))!.suggestions
  expect(listed.map(row => row.label)).toEqual(['改写成议论文', '增加真实事例'])
  expect(listed[1].prompt).toBe('请根据上文补充真实事例，不编造来源。')
  // 通用卡片的长提示词被“填入编辑”后会和用户的真实要求拼在一起，模型常转去回答卡片的问题，因此不再补。
  for (const text of ['作文已调整完成。', '请补充你想修改的重点。', '正文。\n```studio-suggestions\nNOT_JSON\n```']) {
    expect(availableSuggestions(state(text))).toBeNull()
  }
})


// 真实回复中的方向标题和确认尾段；世界规则与后续建议不能变成选择授权。
const directionReply = "### 方向一：【现代顶级亿万富豪言情 · 隐秘婚约与萌宝寻父】（Billionaire Secret Marriage & The Hidden Heirs）\n### 方向二：【西方超自然狼人言情 · 狼王命定与白金幼崽】（Werewolf: The Alpha King’s Secret Pups）\n世界规则名称《暗夜法典》只是方向二的设定，不是待选方向标题。\n### 方向三：【暗黑豪门复仇言情 · 黑帮教父的契约娇妻】（The Mafia Don’s Vow）\n重点推荐【方向一：现代顶级亿万富豪言情】。\n## 五、待确认决策与下一步建议\n1. **核心方向确认**：请确认是否采用**【方向一：现代顶级亿万富豪言情】**作为正式大纲与正文的改编基准；若更倾向于狼人奇幻（方向二）或暗黑黑帮（方向三），可直接指示切换。\n2. **集数与篇幅规划**：若需首批扩写，建议按标准批次推进第 1—3 集剧本初稿。"

const directionState = (text: string): Conversation => ({ runtimeId: 'directions', running: false, error: '', entries: [
  { id: 'request', role: 'user', text: '给我三个改编方向。', calls: [] },
  { id: 'directions', role: 'assistant', text, calls: [] }
] })

test.each([
  { name: '真实标题与确认尾段', text: directionReply, selectors: ['方向一', '方向二', '方向三'],
    titles: ['现代顶级亿万富豪言情 · 隐秘婚约与萌宝寻父', '西方超自然狼人言情 · 狼王命定与白金幼崽', '暗黑豪门复仇言情 · 黑帮教父的契约娇妻'], recommended: '方向一' },
  { name: '仅截图确认尾段', text: '1. **核心方向确认**：请确认是否采用**【方向一：现代顶级亿万富豪言情】**作为正式大纲与正文的改编基准；若更倾向于狼人奇幻（方向二）或暗黑黑帮（方向三），可直接指示切换。',
    selectors: ['方向一', '方向二', '方向三'], titles: ['现代顶级亿万富豪言情', '狼人奇幻', '暗黑黑帮'] },
  { name: '标题前置后置混合', text: '### 方向一：现代顶级亿万富豪言情\n### 狼人奇幻（方向二）\n### 暗黑黑帮（方向三）\n请确认是否采用方向一；若更倾向方向二或方向三，可直接指示切换。',
    selectors: ['方向一', '方向二', '方向三'], titles: ['现代顶级亿万富豪言情', '狼人奇幻', '暗黑黑帮'] },
  { name: '中文方案编号', text: '**方案一：都市悬疑**\n**奇幻冒险（方案二）**\n请选择方案一或方案二。',
    selectors: ['方案一', '方案二'], titles: ['都市悬疑', '奇幻冒险'] },
  { name: '已有字母方案', text: '## A．古装边城【推荐】\n## B．现代家族\n请选择 A 或 B。',
    selectors: ['方案 A', '方案 B'], titles: ['古装边城', '现代家族'], recommended: '方案 A' }
])('明确待选的方向生成只确认选择的卡片：$name', ({ text, selectors, titles, recommended }) => {
  const available = availableSuggestions(directionState(text))
  expect(available?.entryId).toBe('directions')
  expect(available?.suggestions.map(row => row.prompt)).toEqual(selectors.map((selector, index) =>
    `我选择你刚才提供的${selector}（${titles[index]}）。`))
  expect(available?.suggestions.every(row => row.label.length <= 30)).toBe(true)
  expect(available?.suggestions.find(row => row.recommended)?.prompt).toBe(recommended
    ? `我选择你刚才提供的${recommended}（${titles[selectors.indexOf(recommended)]}）。` : undefined)
  expect(available?.suggestions.map(row => row.prompt).join('')).not.toMatch(/直接生成|第1[—-]3集|再继续|暗夜法典/)
})

const simpleDirections = '### 方向一：现代言情\n### 方向二：狼人奇幻\n### 方向三：暗黑黑帮'
const explicitChoice = { label: '保留指定人名', prompt: '我选择方向二，但保留已确认的人名。' }
test.each([
  { name: '波浪代码围栏中的引用', text: '这是旧示例：\n~~~text\n' + simpleDirections + '\n请选择方向一或方向二。\n~~~', expected: [] },
  { name: '未闭合代码围栏不变成选择', text: '代码示例：\n```text\n' + simpleDirections + '\n请选择方向一或方向二。', expected: [] },
  { name: '历史回复提示不回退成普通建议', text: '此前的提示是：可以回复“选择方向一”，这里只是历史记录。', expected: [] },
  { name: 'Markdown 引用中的选项', text: (simpleDirections + '\n请选择方向一或方向二。').split('\n').map(line => '> ' + line).join('\n'), expected: [] },
  { name: '历史方向加通用修改意见不构成选择', text: '之前的备选方向如下，本轮仅回顾：\n' + simpleDirections + '\n请回复你的修改意见。', expected: [] },
  { name: '历史章节中的旧选择不重新激活', text: '## 历史方案记录\n' + simpleDirections + '\n请选择方向一或方向二。\n## 当前状态\n这一轮只记录用户意见。', expected: [] },
  { name: '历史叙述中的选择指令', text: simpleDirections + '\n此前我说过“请选择方向一或方向二”，这只是历史记录。', expected: [] },
  { name: '已有决定不再给旧方向', text: simpleDirections + '\n你已经选择方向一，方向二和方向三不再采用。请回复你想调整的细节。', expected: [] },
  { name: '拒绝的选项不混入仍待选项', text: '### 方向一：现代言情（已拒绝）\n### 方向二：狼人奇幻\n### 方向三：暗黑黑帮\n请选择方向二或方向三。',
    expected: ['我选择你刚才提供的方向二（狼人奇幻）。', '我选择你刚才提供的方向三（暗黑黑帮）。'] },
  { name: '结构化选项优先', text: directionReply + '\n```studio-suggestions\n' + JSON.stringify([explicitChoice]) + '\n```', expected: [explicitChoice.prompt] },
  { name: '新用户消息使历史卡片过期', text: directionReply, afterUser: true, expected: [] },
  { name: '生成中不暴露选项', text: directionReply, running: true, expected: [] },
  { name: '后台任务未完成不暴露选项', text: directionReply, asyncPending: 1, expected: [] },
  { name: '待完成回复不暴露选项', text: directionReply, pending: true, expected: [] }
])('方向识别保持来源和完成状态边界：$name', ({ text, expected, afterUser, running, asyncPending, pending }) => {
  const state = directionState(text)
  if (afterUser) state.entries.push({ id: 'new-request', role: 'user', text: '我有新的修改意见。', calls: [] })
  if (running) state.running = true
  if (asyncPending) state.asyncPending = asyncPending
  if (pending) state.entries[1].pending = true
  expect(availableSuggestions(state)?.suggestions.map(row => row.prompt) ?? []).toEqual(expected)
})

const analysisState = (text: string): Conversation => ({ runtimeId: 'analysis', running: false, error: '', entries: [
  { id: 'request', role: 'user', text: '完整改编', capabilities: { agent: 'coauthor-2-2', skills: [] }, calls: [] },
  { id: 'first', role: 'assistant', text: '# 《山有木兮木有枝》原作理解与资产分析\n\n## 故事梗概\n萧戟转而将对初月的占有欲', calls: [] },
  { id: 'question', role: 'user', text: '？', calls: [] },
  { id: 'analysis', role: 'assistant', text, calls: [] }
] })

test('已选Agent的原作分析漏卡片时，提供有当前正文依据的下一步且不宣称已确认或已保存', () => {
  const text = '# 《山有木兮木有枝》（77集）原作理解与资产分析报告\n\n## 一、故事梗概与核心规则\n初月逐步摆脱旧关系。\n\n## 二、主要人物与人物关系\n### 1. 初月\n初月与摄政王建立信任。\n\n## 三、全剧结构\n从代嫁推进到权力冲突。\n\n## 四、逐集核心戏剧资产\n### 第1—10集\n各集事件和转折保持来源。\n\n## 五、可迁移剧作机制\n以选择和行动兑现人物变化。'
  const state = analysisState(text)
  const result = availableSuggestions(state)!
  expect(result.entryId).toBe('analysis')
  expect(result.suggestions.map(item => item.label)).toEqual(['生成改编方向', '调整原作分析'])
  expect(result.suggestions[0].prompt).toContain('《山有木兮木有枝》')
  expect(result.suggestions.map(item => item.prompt).join('')).not.toMatch(/已确认|已保存|已通过|写第1|第1—3集/)
  expect(availableSuggestions({ ...state, running: true })).toBeNull()
  expect(availableSuggestions({ ...state, asyncPending: 1 })).toBeNull()
  expect(availableSuggestions({ ...state, entries: state.entries.map(row => row.role === 'user' ? { ...row, capabilities: undefined, text: '普通问题' } : row) })).toBeNull()
})

test('原作分析只有开头时只提供补全，不从引用、历史或用户取消中推导推进卡片', () => {
  const fragment = '# 《山有木兮木有枝》（77集）原作理解与资产分析\n\n## 一、故事梗概\n初月被迫代嫁。\n\n## 二、世界规则\n转而将对初月的占有欲'
  const state = analysisState(fragment)
  expect(availableSuggestions(state)?.suggestions.map(item => item.label)).toEqual(['补全当前原作分析'])
  expect(availableSuggestions(state)?.suggestions[0].prompt).toContain('不要重写已有部分')
  expect(availableSuggestions(analysisState(fragment.split('\n').map(line => '> ' + line).join('\n')))).toBeNull()
  const cancelled = { ...state, entries: state.entries.map(row => row.id === 'question' ? { ...row, text: '停止改编，只解释这句话。' } : row) }
  expect(availableSuggestions(cancelled)).toBeNull()
})

const veePause = '⏸ 等你确认——回复“确认”继续，或直接告诉我要改哪里。'
const veeConversation = (text: string, agent = 'vee-2-1'): Conversation => ({ runtimeId: 'vee', running: false, error: '', entries: [
  { id: 'u', role: 'user', text: '原稿和改编思路', capabilities: { agent, skills: [] }, calls: [] },
  { id: 'a', role: 'assistant', text, calls: [] }
] })

const status = (zone: string, next: string) => `**当前位置：** 第1卡 ${zone} 待确认 · 下一区：${next} ｜ 卡点集：待定`
const chips = (text: string) => availableSuggestions(veeConversation(text))?.suggestions ?? null

test('Vee Zone P 出口选择卡：带括号提示或无括号提示、选项间空行，都按“选择 N”出按钮；缺停顿句不出', () => {
  const exit = ['改编思路整理好了，你过一眼。', '', '- 频道：女频', '',
    '① 进 Zone M 商业片融合与定名（推荐）——规格和方向齐了，该定叠什么、叫什么了',
    '② 改整理稿——你指明哪条，改完我再给你看一遍', '③ 补材料——原剧大纲或人物信息有补充的话现在给', '',
    '（回一个数字、一句话、口语都算数；只回「确认」= 选 ①）', '', status('Zone P', 'Zone M'), veePause].join('\n')
  const expected = [
    { label: '选择 1：进 Zone M 商业片融合与定名', prompt: '选择 1：进 Zone M 商业片融合与定名', recommended: true },
    { label: '选择 2：改整理稿', prompt: '选择 2：改整理稿' }, { label: '选择 3：补材料', prompt: '选择 3：补材料' }]
  expect(chips(exit)).toEqual(expected)
  expect(chips(exit.replace(veePause, ''))).toBeNull()
  const loose = ['默认假定：……', '### P出口选择卡', '① 进 Zone M 商业片融合与定名——规格和方向齐了，该定叠什么、叫什么了', '',
    '② 改整理稿——你指明哪条，改完我再给你看一遍', '', '③ 补材料——有原剧大纲、人物信息或对标影视要补，现在给',
    '回一个数字、一句话都行；只回“确认”，我就当你选①。', status('Zone P', 'Zone M'), veePause].join('\n')
  expect(chips(loose)).toEqual(expected)
})

test('Vee Zone M：方案与片名要补编号的选项按正文候选逐个展开，主推排第一；交接包出口卡照常', () => {
  const plans = ['三个方案，都是从你那个改动里长出来的。', '### 方案 1：《教父》家族继承', '……', '### 方案 2：《了不起的盖茨比》阶层幻梦', '……',
    '### 方案 3：《妈妈咪呀》三选一认亲', '……', '我推方案 2，另外两个也行但没它狠。你挑一个；都不合我重出。', '',
    '① 就按方案 N 叠（说编号）', '② 两个一起叠（说两个编号，我判断会不会打架，会打架就直说）',
    '③ 都不合，重出一批（说清哪里不合：太老套／拍不起／跟主线没关系／情绪不对／题材锁错了→我重锁）', '④ 先不定叠加，直接去定名', '',
    '（回编号、口语都算数；只回「确认」= 选 ①，按我推荐的那个走）', status('Zone M', 'Zone M（定名）'), veePause].join('\n')
  expect(chips(plans)?.map(row => [row.label, row.prompt, row.recommended ?? false])).toEqual([
    ['选择 1：就按方案 2 叠', '选择 1：就按方案 2 叠', true], ['选择 1：就按方案 1 叠', '选择 1：就按方案 1 叠', false],
    ['选择 1：就按方案 3 叠', '选择 1：就按方案 3 叠', false], ['选择 2：两个一起叠', '选择 2：两个一起叠', false],
    ['选择 3：都不合，重出一批', '选择 3：都不合，重出一批', false], ['选择 4：先不定叠加，直接去定名', '选择 4：先不定叠加，直接去定名', false]])
  const names = ['名字按剧情核心起了三个，主推第一个。', '1. The Cleaner’s Secret Quintuplets ／ 保洁的五胞胎秘密', '2. Captain, Meet Your Kids ／ 机长，见见你的孩子',
    '3. Five Kids and a Pilot ／ 五个孩子和一个机长', '挑一个，或者回『暂不定名』，我先封包。',
    '① 用 N 号名（说编号，我封包）', '② 换一批（说方向：更狠／更甜／更悬／更高级）', '③ 暂不定名（交接包标「片名待定」，后面任何一区都能补）',
    '（回编号或口语都算数；只回「确认」= 选 ①）', status('Zone M', 'Zone M（交接包）'), veePause].join('\n')
  expect(chips(names)?.map(row => row.label)).toEqual(['选择 1：用 1 号名', '选择 1：用 2 号名', '选择 1：用 3 号名', '选择 2：换一批', '选择 3：暂不定名'])
  expect(chips(names)?.[0].recommended).toBe(true)
  const handoff = ['交接包封好了。', '① 进 Zone A 路由（推荐）——规格、叠加、名字都定了', '② 改哪一条（说哪条，改完重出交接包）',
    '③ 补材料（原剧大纲／人物信息有补充现在给）', '（回编号或口语都算数；只回「确认」= 选 ①）', status('Zone M', 'Zone A'), veePause].join('\n')
  expect(chips(handoff)?.map(row => row.label)).toEqual(['选择 1：进 Zone A 路由', '选择 2：改哪一条', '选择 3：补材料'])
})

test('Vee Zone C 卡点集三选一出 EP 按钮；其余区交付完写“确认，进入下一区”；正文 ①—⑤ 块标号不当选项', () => {
  const zoneC = ['一卡集纲摆上了，主方案加两套备选。卡点集给你三套——EP07／08／09，强度一样，你挑。',
    '卡点集待定：EP07 / EP08 / EP09（请选一个）。你挑完我才动 D。', status('Zone C', 'Zone D'), veePause].join('\n')
  expect(chips(zoneC)).toEqual([{ label: '选择 EP07', prompt: '卡点集选 EP07' }, { label: '选择 EP08', prompt: '卡点集选 EP08' },
    { label: '选择 EP09', prompt: '卡点集选 EP09' }])
  const zoneB = ['## Zone B', '① 一卡逐集：……', '② 二卡逐集：……', '③ 长尾：……', '', '方向你看一眼，行就回确认，我起一卡集纲。',
    '下一区：Zone C', status('Zone B', 'Zone C'), veePause].join('\n')
  expect(chips(zoneB)).toEqual([{ label: '确认，进入 Zone C', prompt: '确认', recommended: true }])
})

test('Vee 提问轮等员工作答不给按钮；其他 Agent 不走这套识别', () => {
  const questions = ['材料我翻了一遍，有三样得你拍板。', '1. 这个剧本做男频还是女频？', '2. 总共做多少集？45集还是50集？',
    '3. 这次准备融入哪些改编元素？', status('Zone P', 'Zone P'), veePause].join('\n')
  expect(chips(questions)).toBeNull()
  expect(availableSuggestions(veeConversation(questions, 'coauthor-2-2'))?.suggestions.some(row => row.prompt === '确认') ?? false).toBe(false)
})

// 测试版 11-18 的真实 Vee 回复结尾（P 出口选择卡、P 提问轮、M1 旧英文停顿句）。
const realVee = {
  "exit": "\n### P出口选择卡\n\n① 进 Zone M 商业片融合与定名——规格和方向齐了，该定叠什么、叫什么了  \n② 改整理稿——你指明哪条，改完我再给你看一遍  \n③ 补材料——有原剧大纲、人物信息或对标影视要补，现在给\n\n回一个数字、一句话都行；只回“确认”，我就当你选①。\n\n当前位置：第1卡 Zone P 待确认 · 下一区：Zone M ｜ 卡点集：未定 ｜ 本卡范围：构思问答→改编思路整理稿\n\n⏸ 等你确认——回复“确认”继续，或直接告诉我要改哪里。",
  "ask": "2. 还需要你拍板两件事：  \n   - 频道：男频还是女频？  \n   - 融入改编的元素：这版准备重点改什么？可以从人设、世界观、感情线、复仇线、对标影视剧元素等方面说。比如：强化芙蕾雅的精灵血脉与战场成长、加重费利克斯的暗恋线、把落风谷真相前置，或者你有其他方向也行。\n\n就这两项，答完我出改编思路整理稿。\n\n当前位置：第1卡 Zone P 待确认 · 下一区：Zone P整理稿 ｜ 卡点集：未定 ｜ 本卡范围：构思问答\n\n⏸ 等你确认——回复“确认”继续，或直接告诉我要改哪里。",
  "m1": "- 不加入对标影视作品的具体元素，避免改变本剧原有的爱情与豪门家庭方向。\n\n框架和改动就这些，你看有没有拆歪。确认了我给叠加方案。\n\n当前位置：第1卡 Zone M 待确认 · 下一区：Zone M2 ｜ 卡点集：待定  \n⏸ Waiting for your confirmation — reply \"confirm\" to continue, or tell me exactly what to change."
}

test('真实 Vee 回复：出口卡出“选择 N”，圆点提问轮不出确认，旧英文停顿句的交付给“确认，进入下一区”', () => {
  expect(chips(realVee.exit)?.map(row => [row.label, row.recommended ?? false])).toEqual([
    ['选择 1：进 Zone M 商业片融合与定名', true], ['选择 2：改整理稿', false], ['选择 3：补材料', false]])
  expect(chips(realVee.ask)).toBeNull()
  expect(chips(realVee.m1)).toEqual([{ label: '确认，进入 Zone M2', prompt: '确认', recommended: true }])
})
