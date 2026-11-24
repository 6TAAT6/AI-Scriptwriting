import type { RevisionEvidence } from './revision-merge'
import { stageLabel } from './creative'
import { CAPABILITIES } from './capabilities'
import { publicError } from '../../shared/public-errors.mjs'

const TOOL_LABELS: Record<string, string> = {
  image_generate: '生成图片',
  read_file: '阅读资料', terminal: '执行创作任务', execute_code: '处理项目资料',
  code_execution: '处理项目资料', write_file: '保存文件', patch: '更新稿件',
  drama_rules_read: '读取创作规则', skill_view: '读取创作规则', skills_list: '查看创作能力', web_search: '检索参考资料',
  web_extract: '阅读参考资料', delegate_task: '分派独立任务', todo: '更新创作计划',
  drama_project_create: '建立剧本项目', drama_project_status: '检查项目进度',
  drama_material_import: '读取原稿', drama_agent_document: '管理剧本稿件', drama_submit: '保存阶段成果',
  drama_confirm: '等待创作确认', drama_review: '独立审核稿件', drama_export: '导出剧本文件',
  drama_story_bible: '整理设定库', drama_requirements: '查看要求清单'
}

export function activityLabel(name: string): string { return TOOL_LABELS[name] ?? '处理创作任务' }

const QUALITY_STATUS_TEXT = /^(?:核验未通过[:：]|已通过要求核验$|已保存，要求核验进行中$)/

const INTERNAL_ACTIVITY_TEXT = /\b(?:read_file|write_file|execute_code|code_execution|drama_[a-z_]+|skill_view|skills_list|delegate_task|provider|grok(?:-[\w.]+)?|gemini(?:-[\w.]+)?|claude(?:-[\w.]+)?|gpt(?:-[\w.]+)?|https?:\/\/|(?:\/Users\/|\/home\/))/i

/** 将历史回执压成创作者可见的业务摘要，不把工具、服务或模型标识泄露到员工只读视图。 */
export function publicActivitySummary(value: unknown, internalFallback = '操作未完成，请稍后重试。'): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return '已记录'
  if (QUALITY_STATUS_TEXT.test(text)) return ''
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
  if (name === 'drama_story_bible') return ({ propose: '提交设定变更，等待你确认', record: '记录设定', list: '查看设定库', read: '读取设定', search: '查找设定', history: '查看设定历史' } as Record<string, string>)[String(object?.action)] || '整理设定库'
  if (typeof context === 'string' && /[\u3400-\u9fff]/.test(context)) return context.slice(0, 150)
  return activityLabel(name)
}

/** 质量结论用于内部版本关联，界面只展示实际操作与正文中的修改说明。 */
function hasQualityCheck(object: Record<string, unknown> | null): boolean {
  const check = objectResult(object?.quality_check) ?? objectResult(objectResult(object?.document)?.quality_check)
  return Boolean(check && typeof check.status === 'string')
}

/** 仅从结构化质量回执读取稿件身份，不根据状态文案猜测返修。 */
export function revisionEvidence(value: unknown): RevisionEvidence | undefined {
  const root = objectResult(value)
  if (!root) return undefined
  const quality = objectResult(root.quality_check) ?? objectResult(objectResult(root.document)?.quality_check)
  if (!quality || (quality.status !== 'fail' && quality.status !== 'pass')) return undefined
  const document = objectResult(root.document)
  const receipt = objectResult(root.receipt)
  const id = [root.document_id, quality.document_id, document?.id, receipt?.artifact_id, receipt?.document_id]
    .find(value => typeof value === 'string' && value.length > 0)
  if (typeof id !== 'string') return undefined
  const project = objectResult(root.project)
  const artifact = (Array.isArray(project?.artifacts) ? project.artifacts : []).map(objectResult).find(row => row?.id === id) ?? document
  const previous = quality.previous_document_id ?? artifact?.previous_document_id
  const previousHash = quality.previous_content_sha256 ?? artifact?.previous_content_sha256
  const sourceId = artifact?.source_message_id
  return { documentId: id, qualityStatus: quality.status,
    ...(typeof previous === 'string' && previous ? { previousDocumentId: previous } : {}),
    ...(typeof previousHash === 'string' && previousHash ? { previousContentSha256: previousHash } : {}),
    ...(typeof sourceId === 'string' || typeof sourceId === 'number' ? { sourceMessageId: String(sourceId) } : {}),
    ...(typeof artifact?.content === 'string' ? { content: artifact.content } : {}) }
}

export function resultSummary(value: unknown, provided?: unknown): string {
  const object = objectResult(value)
  if (object?.export_status === 'failed') return publicError(object.export_error, 'Word 文件生成失败，正文已保存，可稍后重试导出。')
  if (hasQualityCheck(object) && !failedResult(value)) return ''
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

/** 一步操作的动词与对象（参照 Codex 的“已读取 xxx.py”）：动词按状态加“已/正在/未能”，对象是文件名、稿件名或能力的显示名。 */
export interface ActivityDescriptor { verb: string; object?: string }

const GENERIC_RESULTS = new Set(['操作已返回', '操作已返回成功回执', '历史记录未保留操作回执', '已记录'])

/** 只有工具给出的具体中文结果（如“已读取 120 行”）值得显示；“操作已返回”之类的通用回执不显示。 */
export function meaningfulResult(text?: string): string | undefined {
  return text && !GENERIC_RESULTS.has(text) && !/^(?:核验未通过[:：]|已通过要求核验$|已保存，要求核验进行中$)/.test(text) ? text : undefined
}

function baseName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.split(/[\\/]/).pop()!.trim() : undefined
}

function capabilityName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bare = value.replace(/^[\w-]+:/, '')
  return CAPABILITIES.find(row => row.skill === bare || row.id === bare)?.display_name
}

const DOCUMENT_VERBS: Record<string, string> = { save: '保存稿件', read: '阅读稿件', check: '整理稿件', list: '查看稿件列表', export: '导出稿件' }
const BIBLE_VERBS: Record<string, string> = { record: '记录设定', propose: '提交设定变更', list: '查看设定库', read: '查看设定库', search: '查看设定库', history: '查看设定历史' }
const SIMPLE_VERBS: Record<string, string> = {
  skills_list: '查看创作能力', drama_confirm: '发起创作确认', drama_review: '独立审核稿件', drama_export: '导出剧本文件',
  drama_project_create: '建立剧本项目', drama_project_status: '查看项目进度', drama_rules_read: '读取创作规则', todo: '更新创作计划',
  terminal: '处理项目资料', execute_code: '处理项目资料', code_execution: '处理项目资料', image_generate: '生成图片',
  web_extract: '阅读网页资料', delegate_task: '分派独立任务', memory: '更新记忆', session_search: '查找历史对话', clarify: '向你确认',
  write_file: '保存文件', patch: '更新稿件'
}

export function activityDescriptor(name: string, args: unknown, context?: unknown): ActivityDescriptor {
  const object = objectResult(args) ?? {}
  const file = baseName(object.path ?? object.file_path ?? object.filename)
  if (name === 'skill_view') {
    const reference = baseName(object.file_path)
    return reference ? { verb: '读取规则参考', object: reference.replace(/\.md$/i, '') } : { verb: '读取创作规则', object: capabilityName(object.name) }
  }
  if (name === 'read_file') return { verb: '阅读资料', object: file }
  if (name === 'drama_material_import') return { verb: '读取原稿', object: file }
  if (name === 'drama_agent_document') return { verb: DOCUMENT_VERBS[String(object.action)] ?? '处理稿件', object: baseName(object.name) }
  if (name === 'drama_requirements') return { verb: object.action === 'detail' ? '记录格式细则' : '查看要求清单' }
  if (name === 'drama_story_bible') return { verb: BIBLE_VERBS[String(object.action)] ?? '整理设定库', object: typeof object.name === 'string' ? object.name : undefined }
  if (name === 'drama_submit') return { verb: argumentSummary(name, args) }
  if (name === 'web_search') return { verb: '检索参考资料', object: typeof object.query === 'string' ? object.query.slice(0, 60) : undefined }
  if (name === 'search_files') return { verb: '检索资料', object: typeof object.pattern === 'string' ? object.pattern.slice(0, 40) : undefined }
  if (SIMPLE_VERBS[name]) return { verb: SIMPLE_VERBS[name] }
  if (typeof context === 'string' && /[㐀-鿿]/.test(context)) return { verb: activityLabel(name), object: context.slice(0, 80) }
  return { verb: activityLabel(name), object: file }
}

/** 按状态组织一行文字：已读取…／正在读取…／未能读取…；失败与需前置操作时附上原因。 */
type LineSource = { name?: string; verb?: string; object?: string; label: string; state: string; resultSummary?: string }

// 历史记录里的旧步骤没有动词字段；按工具名取业务标签，不把 label 中可能残留的工具标识显示出来。
function verbOf(call: LineSource): string {
  return call.verb ?? (call.name ? activityLabel(call.name) : call.label)
}

export function activityLine(call: LineSource): { lead: string; object?: string; detail?: string } {
  const verb = verbOf(call)
  const lead = call.state === 'running' ? `正在${verb}` : call.state === 'error' ? `未能${verb}`
    : call.state === 'blocked' ? `${verb}需要前置操作` : call.state === 'interrupted' ? `${verb}已中断` : `已${verb}`
  const detail = call.state === 'error' || call.state === 'blocked' ? call.resultSummary : meaningfulResult(call.resultSummary)
  return { lead, object: call.object, detail }
}

/** 列表里要显示的步骤：去掉宿主自动注入、既无参数也无回执的空步骤（如自动加载的关联技能），同一动作与对象只显示一次。 */
export function visibleActivities<T extends LineSource>(calls: T[]): T[] {
  // 实时事件里同一步有时先出现一条没有对象的记录；同类步骤已有带对象的记录时不再单列。
  const named = new Set(calls.filter(call => call.object).map(verbOf))
  const meaningful = calls.filter(call => !(call.state === 'unknown' && !call.object && !meaningfulResult(call.resultSummary))
    && !(!call.object && call.state === 'complete' && named.has(verbOf(call)) && !meaningfulResult(call.resultSummary)))
  const seen = new Set<string>()
  return (meaningful.length ? meaningful : calls).filter(call => {
    if (call.state === 'running' || call.state === 'error' || call.state === 'blocked') return true
    const key = `${verbOf(call)}|${call.object ?? ''}|${meaningfulResult(call.resultSummary) ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
