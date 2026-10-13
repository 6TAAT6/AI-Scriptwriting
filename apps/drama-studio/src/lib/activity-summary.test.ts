import { expect, test } from 'vitest'
import { activityLabel, resultSummary } from './activity-summary'

test('工具成功回执的混合中文摘要不泄露服务和模型标识', () => {
  expect(resultSummary({ ok: true, summary: '已使用 provider grok-4.7 完成' })).toBe('操作已返回')
})

test('稿件工具显示明确业务名称，不再退回通用处理创作任务', () => {
  expect(activityLabel('drama_agent_document')).toBe('管理剧本稿件')
})

test('稿件工具有明确名称，结构化业务拒绝显示下一步动作，纯文本工具错误也标记失败', () => {
  expect(resultSummary({ ok: false, error: '前置阶段未完成', required_user_action: '先完成独立审核和正式验收。' })).toBe('先完成独立审核和正式验收。')
  expect(resultSummary('[TOOL_ERROR] Tool execution failed: ValueError: invalid workflow')).toMatch(/未完成|失败/)
})
