import { expect, test } from 'vitest'
import { buildLanguageAwarePrompt } from './prompt-language'
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
  expect(prompt).toContain('只有用户明确点名三个剧本 Agent 之一时才调用对应 skill')
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
