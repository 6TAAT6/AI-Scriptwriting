import { expect, test } from 'vitest'
import { buildLanguageAwarePrompt } from './prompt-language'
import { CAPABILITIES, SELECTABLE_CAPABILITIES, capabilityCommands, capabilityOperations, selectionAfter, savedCapabilitySelection } from './capabilities'
import commonFormat from '../../shared/script-format.md?raw'
import standaloneFormat from '../../../../extensions/jubao-drama/skills/jubao-skill-outline-script/references/format-standard.md?raw'

test('语言偏好保留用户原文，不根据正文里的英文或双语词汇推断用户选择', () => {
  const texts = ['  请继续写下一集。\n保留这行。  ', '请解释“英文”“双语”这两个词，保留 @file:"原稿 one.md"。', 'Please write the dialogue in English.']
  const preferences = texts.map(text => {
    const prompt = buildLanguageAwarePrompt(text)
    expect(prompt.endsWith(text)).toBe(true)
    return prompt.slice(0, -text.length)
  })
  expect(preferences[0].trim()).not.toBe('')
  expect(new Set(preferences).size).toBe(1)
  const text = texts[0]
  const bilingual = buildLanguageAwarePrompt(text, '中英双语')
  expect(bilingual.endsWith(text)).toBe(true)
  expect(bilingual.slice(0, -text.length)).not.toBe(preferences[0])
})

test('普通消息不会自动启用剧本规则', () => {
  const prompt = buildLanguageAwarePrompt('帮我解释一下这个错误。')

  expect(prompt).toContain('普通对话、看图和生图保持默认能力')
  expect(prompt).toContain('只有用户明确选择或点名目录中的主 Agent 或独立技能时，才调用对应的已选入口')
  expect(prompt).not.toContain('自动判断需要正常聊天、图片理解、生图、剧本分析、改编、审稿或导出')
})

test('隐藏底层模型信息并禁止默认打包剧本规则', () => {
  const prompt = buildLanguageAwarePrompt('你是什么模型？')

  expect(prompt).toContain('不要向用户透露或确认底层模型名称、模型 ID、供应商')
  expect(prompt).toContain('只回答“我是巨豹智能体，可以直接帮你完成当前任务。”')
  expect(prompt).toContain('除非用户明确要求打包或导出指定规则文件')
})

test('独立大纲编剧使用原包格式，搭配任何主 Agent 时使用统一格式', () => {
  for (const skills of [['outline-script'], ['outline-script', 'humanize']]) {
    const standalone = buildLanguageAwarePrompt('继续写下一集', '仅中文', '中国', { skills })
    expect(standalone).toContain(standaloneFormat)
    expect(standalone).not.toContain(commonFormat)
    for (const agent of ['oa6-1', 'gm3-1', 'gr4-7']) {
      const combined = buildLanguageAwarePrompt('继续写下一集', '仅中文', '中国', { agent, skills })
      expect(combined).toContain(commonFormat)
      expect(combined).not.toContain(standaloneFormat)
    }
  }
})


test('Agent2.2在第二位按精确名称选择并获得原生稿件交付约束', () => {
  const display = '巨豹 Agent2.2 · 适配巨豹满血版 V1.1'
  expect(SELECTABLE_CAPABILITIES[1]).toMatchObject({ id: 'coauthor-2-2', kind: 'agent', display_name: display, label: display })
  expect(CAPABILITIES.find(row => row.id === 'oa6-1')?.display_name).toBe('巨豹 Agent2 · 适配创作版 V2.1')
  expect(capabilityCommands('调用巨豹 Agent2.2-适配巨豹满血版 V1.1\n继续创作。')[0]?.capability.id).toBe('coauthor-2-2')
  const commands = capabilityCommands(`调用${display}\n请写本轮剧本。`)
  const selected = selectionAfter({ skills: ['humanize'] }, '', commands)
  expect(selected).toEqual({ agent: 'coauthor-2-2', skills: ['humanize'] })
  const operations = capabilityOperations(commands)
  expect(operations).toEqual([{ id: 'coauthor-2-2', action: 'enable' }])
  const prompt = buildLanguageAwarePrompt('请写本轮剧本。', '仅中文', '北美', selected, operations)
  expect(savedCapabilitySelection(prompt)).toEqual({ agent: 'coauthor-2-2', skills: ['humanize'] })
  expect(prompt).toContain('jubao-drama:jubao-agent-coauthor-2-2')
  expect(prompt).toContain('当前主 Agent 的稿件交付规则对所有文字模型一致')
  expect(prompt).toContain('drama_agent_document(action="save", kind=…, name=…, from_reply=true)')
  expect(prompt.endsWith('请写本轮剧本。')).toBe(true)
})

test('Vee 在第三位按名称选择，只按自身协议执行，不叠加宿主排版、收尾与建议卡规则', () => {
  const display = 'Peter Agent· Vee海外竖屏短剧V2.1'
  expect(SELECTABLE_CAPABILITIES.filter(row => row.kind === 'agent')[2]).toMatchObject({ id: 'vee-2-1', display_name: display, own_protocol: true })
  const commands = capabilityCommands(`调用${display}\n原剧大纲如下。`)
  const selected = selectionAfter({ skills: [] }, '', commands)
  expect(selected).toEqual({ agent: 'vee-2-1', skills: [] })
  const vee = buildLanguageAwarePrompt('原剧大纲如下。', '仅中文', '中国', selected, capabilityOperations(commands))
  const agent1 = buildLanguageAwarePrompt('原剧大纲如下。', '仅中文', '中国', { agent: 'gm3-1', skills: [] }, [{ id: 'gm3-1', action: 'enable' }])
  expect(savedCapabilitySelection(vee)).toEqual(selected)
  expect(vee).toContain('jubao-drama:jubao-agent-vee-2-1')
  expect(vee.endsWith('原剧大纲如下。')).toBe(true)
  // 宿主通用规则仍只对其他 Agent 生效：Agent1 照常拿到排版、续跑与建议卡规则，Vee 不再叠加。
  for (const hostRule of [commonFormat, '每个已完成回合都在自然语言回复后另起一行输出', '本轮已授权且可以继续的工作应继续执行']) {
    expect(agent1).toContain(hostRule)
    expect(vee).not.toContain(hostRule)
  }
  expect(vee).toContain('不输出 studio-suggestions 代码块')
})

test('小说 Agent 排在 Vee 之后，按自身协议执行：保留建议卡与提问卡，不叠加剧本排版与收尾规则', () => {
  const display = '小说 Agent V1.0'
  expect(SELECTABLE_CAPABILITIES.filter(row => row.kind === 'agent').slice(0, 4).map(row => row.id))
    .toEqual(['gm3-1', 'coauthor-2-2', 'vee-2-1', 'novel-1-0'])
  const commands = capabilityCommands(`调用${display}\n帮我写一本都市悬疑长篇。`)
  const selected = selectionAfter({ skills: [] }, '', commands)
  expect(selected).toEqual({ agent: 'novel-1-0', skills: [] })
  const novel = buildLanguageAwarePrompt('帮我写一本都市悬疑长篇。', '仅中文', '中国', selected, capabilityOperations(commands))
  expect(savedCapabilitySelection(novel)).toEqual(selected)
  expect(novel).toContain('jubao-drama:jubao-agent-novel-1-0')
  expect(novel).toContain('当前主 Agent 为小说 Agent V1.0')
  expect(novel).toContain('只输出一个 studio-suggestions 代码块')
  expect(novel).not.toContain('不输出 studio-suggestions 代码块')
  expect(novel).not.toContain(commonFormat)
  expect(novel.endsWith('帮我写一本都市悬疑长篇。')).toBe(true)
  const vee = buildLanguageAwarePrompt('原剧大纲如下。', '仅中文', '中国', { agent: 'vee-2-1', skills: [] }, [{ id: 'vee-2-1', action: 'enable' }])
  expect(vee).toContain('不输出 studio-suggestions 代码块')
  expect(vee).not.toContain('小说 Agent V1.0')
})

test('主 Agent 在能力目录另设的默认篇幅与字数报告进入每轮规则，其余 Agent 沿用产品默认', () => {
  const product = commonFormat.match(/默认每集 (\d+)—(\d+) 个汉字/)
  expect(product).not.toBeNull()
  const agents = CAPABILITIES.filter(row => row.kind === 'agent' && !row.own_protocol)
  expect(agents.some(row => row.default_script_length)).toBe(true)
  for (const agent of agents) {
    const prompt = buildLanguageAwarePrompt('写第1—3集正文。', '仅中文', '中国', { agent: agent.id, skills: [] }, [{ id: agent.id, action: 'enable' }])
    const length = agent.default_script_length
    if (length) {
      expect(prompt).toContain(`默认每集 ${length.minimum}—${length.maximum} 个汉字`)
      expect(prompt).not.toContain(product![0])
    } else {
      expect(prompt).toContain(product![0])
    }
    expect(prompt.includes('一行报告各集回执统计的汉字数与净字数')).toBe(agent.length_report === 'han_and_net')
    expect(prompt.includes('字数、文件路径、哈希、字段和工具状态不主动罗列')).toBe(agent.length_report !== 'han_and_net')
  }
})
