import { expect, test } from 'vitest'
import { activityLabel, publicActivitySummary, resultSummary } from './activity-summary'

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


test('质量回执不生成判定或修改结论，真实导出失败仍提示正文已保存', () => {
  for (const status of ['pass', 'fail', 'unverified']) {
    expect(resultSummary({ ok: true, quality_check: { status, revisions_remaining: 1,
      issues: [{ code: 'above_maximum', episode: 2, difference: 313 }] } })).toBe('')
  }
  expect(resultSummary({ ok: true, saved: true, export_status: 'failed', export_error: 'Word 文件生成失败，正文已保存，可稍后重试导出。',
    quality_check: { status: 'pass' } })).toContain('Word 文件生成失败')
})


test('压缩历史只剩摘要时不重新显示旧质量结论，普通操作说明保留', () => {
  for (const summary of ['已通过要求核验', '核验未通过：第2集多313字，正在修订', '已保存，要求核验进行中']) {
    expect(resultSummary(undefined, summary)).toBe('')
    expect(publicActivitySummary(summary)).toBe('')
  }
  expect(resultSummary(undefined, '已读取申请未通过的原始通知。')).toBe('已读取申请未通过的原始通知。')
})
