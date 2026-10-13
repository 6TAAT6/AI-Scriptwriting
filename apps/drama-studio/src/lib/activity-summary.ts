import { stageLabel } from './creative'
import { publicError } from '../../shared/public-errors.mjs'

const TOOL_LABELS: Record<string, string> = {
  image_generate: '生成图片',
  read_file: '阅读资料', terminal: '执行创作任务', execute_code: '处理项目资料',
  code_execution: '处理项目资料', write_file: '保存文件', patch: '更新稿件',
  drama_rules_read: '读取创作规则', skill_view: '读取创作规则', skills_list: '查看创作能力', web_search: '检索参考资料',
  web_extract: '阅读参考资料', delegate_task: '分派独立任务', todo: '更新创作计划',
  drama_project_create: '建立剧本项目', drama_project_status: '检查项目进度',
  drama_material_import: '读取原稿', drama_agent_document: '管理剧本稿件', drama_submit: '保存阶段成果',
  drama_confirm: '等待创作确认', drama_review: '独立审核稿件', drama_export: '导出剧本文件'
}

export function activityLabel(name: string): string { return TOOL_LABELS[name] ?? '处理创作任务' }

const INTERNAL_ACTIVITY_TEXT = /\b(?:read_file|write_file|execute_code|code_execution|drama_[a-z_]+|skill_view|skills_list|delegate_task|provider|grok(?:-[\w.]+)?|gemini(?:-[\w.]+)?|claude(?:-[\w.]+)?|gpt(?:-[\w.]+)?|https?:\/\/|(?:\/Users\/|\/home\/))/i

/** 将历史回执压成创作者可见的业务摘要，不把工具、服务或模型标识泄露到员工只读视图。 */
export function publicActivitySummary(value: unknown, internalFallback = '操作未完成，请稍后重试。'): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return '已记录'
  if (INTERNAL_ACTIVITY_TEXT.test(text)) return publicError('', internalFallback)
  const safe = publicError(text, '')
  return safe || '操作已返回'
}

function objectResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { return objectResult(JSON.parse(value)) } catch { return null } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function failedResult(value: unknown): boolean {
  const result = objectResult(value)
  if (!result && typeof value === 'string') {
    return /\[TOOL_ERROR\]|(?:APIConnectionError|PermissionError|ValueError|Traceback)|\b(?:Error|Failed):/i.test(value)
  }
  return Boolean(result && (result.ok === false || result.success === false || result.error || (typeof result.exit_code === 'number' && result.exit_code !== 0)))
}

/** Deterministic business gate refusal; it needs a user/workflow action, not a retry. */
export function blockedResult(value: unknown): boolean {
  const result = objectResult(value)
  return Boolean(result && result.retryable === false && typeof result.blocked_reason === 'string')
}

export function argumentSummary(name: string, args: unknown, context?: unknown): string {
  const object = objectResult(args)
  if (name === 'skill_view' && typeof object?.name === 'string') return `技能：${object.name}`
  const file = object?.path ?? object?.file_path ?? object?.filename
  if (typeof file === 'string') return `资料：${file.split(/[\\/]/).pop()}`
  if (name === 'drama_submit') return ({ source: '保存原稿', core: '保存核心期待', candidates: '保存改编候选方案', outline_batch: '保存分集新纲', script_batch: '保存剧本正文', accept_batch: '记录批次验收', restart: '重新整理当前阶段' } as Record<string, string>)[String(object?.kind)] || '保存阶段成果'
  if (name === 'drama_confirm') return object?.gate === 'plan' ? '确认改编方案' : '确认核心期待'
  if (name === 'delegate_task') return '安排独立任务执行'
  if (typeof context === 'string' && /[\u3400-\u9fff]/.test(context)) return context.slice(0, 150)
  return activityLabel(name)
}

export function resultSummary(value: unknown, provided?: unknown): string {
  const object = objectResult(value)
  if (failedResult(value)) {
    const summary = provided ?? object?.summary
    if (typeof summary === 'string' && /^技能(?:加载|资源读取|列表读取)失败/.test(summary)) return publicActivitySummary(summary).slice(0, 300)
    const requiredAction = object?.required_user_action
    if (typeof requiredAction === 'string' && requiredAction.trim()) return publicError(requiredAction, '请按当前项目状态继续处理。').slice(0, 240)
    const message = String(object?.error ?? '')
    return publicError(message, '操作未完成，请稍后重试。').slice(0, 200)
  }
  const project = objectResult(object?.project)
  if (project) return `项目阶段：${stageLabel(String(project.stage ?? ''))}`
  const summary = provided ?? object?.summary
  if (typeof summary === 'string' && /[\u3400-\u9fff]/.test(summary)) {
    const safe = publicActivitySummary(summary)
    return (safe === '操作未完成，请稍后重试。' ? '操作已返回' : safe).slice(0, 200)
  }
  if (value === undefined) return '历史记录未保留操作回执'
  if (object?.ok === true || object?.success === true || object?.exit_code === 0) return '操作已返回成功回执'
  return '操作已返回'
}
