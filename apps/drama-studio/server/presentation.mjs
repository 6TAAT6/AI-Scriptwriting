import { publicError, publicRuntimeFailure, errorEventPayload } from '../shared/public-errors.mjs'
import { createHash } from 'node:crypto'
import { isEmployee } from './file-handles.mjs'
import { enrichReasoning, safeCapabilities } from './reasoning.mjs'
import { publicStatus, publicSkillArguments, publicSkillSummary, subagentFields, subagentStatuses, displayKinds, noticeTexts } from './presentation-activity.mjs'

const object = value => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)) } catch { return null } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined && ['string', 'boolean', 'number'].includes(typeof value[key])).map(key => [key, value[key]]))
const array = value => Array.isArray(value) ? value : []
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const textCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_500_000
function documentEvidence(row) {
  const result = {}, stats = row?.text_statistics
  const sourceHash = typeof row?.content === 'string'
    ? createHash('sha256').update(row.content.replace(/\r\n?/g, '\n')).digest('hex') : row?.source_sha256
  if (sha256(row?.source_sha256)) result.source_sha256 = row.source_sha256
  if (stats && typeof stats === 'object' && !Array.isArray(stats)
    && stats.method === 'unicode_han_and_non_whitespace_v1' && stats.scope === 'source_text_lf_normalized'
    && sha256(stats.source_sha256) && (!sourceHash || stats.source_sha256 === sourceHash)
    && textCount(stats.han_characters) && textCount(stats.non_whitespace_characters)
    && stats.han_characters <= stats.non_whitespace_characters && textCount(stats.episode_count)) {
    const projected = pick(stats, ['method', 'scope', 'source_sha256', 'han_characters', 'non_whitespace_characters', 'episode_count'])
    if (stats.total_scope === 'whole_source_including_headings') projected.total_scope = stats.total_scope
    const totals = stats.episode_body_totals
    if (totals?.scope === 'recognized_episode_bodies_excluding_headings' && totals.episode_count === stats.episode_count
      && textCount(totals.han_characters) && textCount(totals.non_whitespace_characters)
      && totals.han_characters <= totals.non_whitespace_characters
      && totals.han_characters <= stats.han_characters && totals.non_whitespace_characters <= stats.non_whitespace_characters
      && typeof totals.coverage_complete === 'boolean' && (!totals.coverage_complete || totals.episode_count > 0)) {
      projected.episode_body_totals = pick(totals, ['scope', 'han_characters', 'non_whitespace_characters', 'episode_count', 'coverage_complete'])
    }
    if (stats.episode_scope === 'body_excluding_episode_heading') projected.episode_scope = stats.episode_scope
    if (Array.isArray(stats.episodes)) {
      projected.episodes = stats.episodes.slice(0, 20).filter(item =>
        typeof item?.episode === 'string' && /^第(?:[0-9]{1,4}|[〇零一二三四五六七八九十百千两]{1,8})集$/.test(item.episode)
        && textCount(item.han_characters) && textCount(item.non_whitespace_characters)
        && item.han_characters <= item.non_whitespace_characters)
        .map(item => pick(item, ['episode', 'han_characters', 'non_whitespace_characters']))
      projected.episodes_truncated = stats.episodes_truncated === true || projected.episodes.length < stats.episode_count
    }
    result.text_statistics = projected
    if (sha256(sourceHash)) result.source_sha256 = sourceHash
  }
  const verification = row?.verification, checks = {}
  if (verification?.content_roundtrip === 'passed' && row.content_verified === true) checks.content_roundtrip = 'passed'
  if (verification?.layout === 'not_checked' && row.layout_verified === false) checks.layout = 'not_checked'
  if (verification?.wps === 'not_checked') checks.wps = 'not_checked'
  if (verification?.business_acceptance === 'not_assessed') checks.business_acceptance = 'not_assessed'
  if (Object.keys(checks).length) result.verification = checks
  if (row?.format === 'docx') {
    const scopes = row.hash_scopes, allowed = {
      source_sha256: 'source_text_lf_normalized',
      content_sha256: 'exported_text_lf_joined_without_layout_spacers', sha256: 'file_bytes'
    }
    const hashes = Object.fromEntries(Object.entries(allowed).filter(([key, value]) => sha256(row[key]) && scopes?.[key] === value))
    if (Object.keys(hashes).length) result.hash_scopes = hashes
    if (textCount(row.paragraphs) && row.paragraphs_scope === 'nonempty_top_level_content_paragraphs_excluding_table_cells') {
      result.paragraphs = row.paragraphs
      result.paragraphs_scope = row.paragraphs_scope
    }
  }
  return result
}
function logicalMessages(value) {
  const rows = [], positions = new Map()
  const active = row => Number(row.active === 1 || row.active === true)
  const physicalId = row => row.row_id ?? row.id ?? row._row_id
  for (const row of array(value)) {
    if (typeof row?.message_uid !== 'string' || !row.message_uid.trim() || typeof row.role !== 'string') { rows.push(row); continue }
    const key = JSON.stringify([row.role, row.message_uid]), position = positions.get(key)
    if (position === undefined) { positions.set(key, rows.length); rows.push(row); continue }
    const previous = rows[position], nextId = physicalId(row), previousId = physicalId(previous)
    // 原生 UID 跨压缩复制保持不变；更新代表行，不改变该逻辑消息首次出现的位置。
    if (active(row) > active(previous) || active(row) === active(previous)
      && (!Number.isSafeInteger(nextId) || !Number.isSafeInteger(previousId) || nextId >= previousId)) rows[position] = row
  }
  return rows
}
// 这里只统一平台自身展示身份；凭证保护由能力隔离和响应字段白名单承担。
const brands = ['Hermes Agent', 'Hermes-Agent', 'Hermes_Agent', 'Hermes'].map(token => [token, '创作引擎']).concat([['Nous Research', '创作团队']])
const privateModelNames = [
  'gpt-6-astra', 'gpt-6.1-sol', 'gemini-3.1-pro-low', 'gemini-3.8-flash-high', 'grok-4.7',
  'gpt-image-2.5-sunburst', 'gemini-3.1-flash-image', 'jubao-sub2', 'studio-gemini', 'studio-grok'
]
function hideAssistantDetails(value, privateOrigins) {
  let text = typeof value === 'string' ? value : ''
  text = text.replace(/https?:\/\/[^\s<>()"'`;,，。；：！？、]+/gi, raw => {
    const trailing = raw.match(/[。，、；：！？,.!?]+$/)?.[0] || ''
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw
    let url
    try { url = new URL(candidate) } catch { return '当前模型服务地址' + trailing }
    const internal = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname)
    return !privateOrigins || privateOrigins.has(url.origin) || internal || url.username || url.password
      ? '当前模型服务地址' + trailing : candidate + trailing
  })
  for (const name of privateModelNames) text = text.replace(new RegExp(name.replace(/[.-]/g, '\\$&'), 'gi'), '当前模型')
  text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[已隐藏]')
  return text
}
function projectText(value, tokens, final = true, previous = '') {
  const input = typeof value === 'string' ? value : '', lower = input.toLowerCase()
  let text = '', offset = 0
  while (offset < input.length) {
    const remaining = lower.slice(offset)
    const boundary = index => !/[a-z0-9_-]/i.test(input[index] || (index < 0 ? previous : ''))
    // 仅保留可能尚未到齐的前缀；普通正文不需要等待固定字数。
    if (!final && tokens.some(([token, , bounded]) => (!bounded || boundary(offset - 1)) && token.length > remaining.length && token.startsWith(remaining))) return { text, tail: input.slice(offset) }
    const match = tokens.find(([token, , bounded]) => lower.startsWith(token, offset) && (!bounded || boundary(offset - 1) && boundary(offset + token.length)))
    if (!final && match?.[2] && match[0].length === remaining.length) return { text, tail: input.slice(offset) }
    if (match) { text += match[1]; offset += match[0].length }
    else { text += input[offset]; offset++ }
  }
  return { text, tail: '' }
}
const publicTools = new Set(['read_file', 'terminal', 'execute_code', 'code_execution', 'write_file', 'patch', 'skill_view', 'skills_list', 'web_search', 'web_extract', 'delegate_task', 'todo', 'drama_rules_read', 'drama_agent_document', 'drama_project_create', 'drama_project_status', 'drama_material_import', 'drama_submit', 'drama_confirm', 'drama_review', 'drama_export'])
publicTools.add('image_generate')
const safeName = value => publicTools.has(value) ? value : 'creative_task'
const publicArguments = (name, args) => {
  const data = object(args) || {}, result = {}
  if (name === 'skill_view') return publicSkillArguments(data)
  const enums = {
    drama_submit: { kind: ['source', 'core', 'candidates', 'outline_batch', 'script_batch', 'accept_batch', 'restart'] },
    drama_confirm: { gate: ['core', 'plan'] },
    drama_rules_read: { stage: ['all', 'M0', 'M1', 'M2A', 'M2B', 'M3', 'M4', 'M5', 'batch'] }
  }
  for (const [key, values] of Object.entries(enums[name] || {})) if (values.includes(data[key])) result[key] = data[key]
  return result
}
const info = value => pick(value, ['model', 'provider', 'running', 'turn_started_at', 'lazy', 'reasoning_effort', 'reasoning_effort_wire'])
async function readReceipt(response) {
  const limit = 16 * 1024 * 1024
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); return null }
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks).toString('utf8')
      size += value.length
      if (size > limit) return null
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
}

export class StudioPresentation {
  constructor(backend) { this.backend = backend; this.files = backend.files; this.streams = new Map() }
  async hideDetails(value) {
    const pool = this.backend.workerPool
    if (pool && !pool.modelServiceOrigins) {
      // 配置暂不可读时维持旧版隐藏策略；恢复后重试，不阻断历史和正文交付。
      this.originsLoading ??= Promise.resolve().then(() => pool.readSettings()).then(() => true, () => false).finally(() => { this.originsLoading = null })
      if (!await this.originsLoading || !pool.modelServiceOrigins) return hideAssistantDetails(value, null)
    }
    const origins = new Set(pool?.modelServiceOrigins || [])
    if (this.backend.endpoint?.origin) origins.add(this.backend.endpoint.origin)
    return hideAssistantDetails(value, origins)
  }
  tokens(user) {
    const roots = [this.backend.homeFor?.(user), this.backend.repoRoot].filter(value => typeof value === 'string' && value.startsWith('/') && value.length > 1)
    const paths = roots.flatMap(value => [value, ...(value.startsWith('/var/') ? ['/private' + value] : value.startsWith('/private/var/') ? [value.slice(8)] : [])])
    const models = isEmployee(user) ? [...new Set([...privateModelNames, ...(this.backend.modelNames?.privateNames() || [])])].map(value => [value, '当前模型', true]) : []
    return [...brands, ...paths.map(value => [value, '工作区']), ...models].map(([token, replacement, bounded]) => [token.toLowerCase(), replacement, bounded]).sort((a, b) => b[0].length - a[0].length)
  }
  display(user, value) {
    const input = typeof value === 'string' ? value : '', tokens = this.tokens(user)
    // 下载句柄是精确匹配的能力地址，文件名中的品牌文字也不能被展示替换改写。
    return input.split(/(\/assets-data\/[A-Za-z0-9_-]{32}\/[^\s<>()]+)/g)
      .map((part, index) => index % 2 ? part : projectText(part, tokens).text).join('')
  }
  stream(user, sessionId, value, streams) {
    const key = user.id + ':' + sessionId
    let state = streams.get(key)
    if (!state) { state = { tail: '', visible: '', raw: '' }; streams.set(key, state) }
    state.raw += typeof value === 'string' ? value : ''
    const source = state.tail + (typeof value === 'string' ? value : '')
    const projected = projectText(source, isEmployee(user) ? this.tokens(user) : [], false, state.beforeTail || '')
    const consumed = source.length - projected.tail.length
    if (consumed) state.beforeTail = source[consumed - 1]
    state.tail = projected.tail; state.visible += projected.text
    while (streams.size > 1024) streams.delete(streams.keys().next().value)
    return projected.text
  }
  async finish(user, sessionId, value, streams) {
    const key = user.id + ':' + sessionId, state = streams.get(key)
    streams.delete(key)
    const raw = typeof value === 'string' && value ? value : state?.raw || ''
    return isEmployee(user) ? this.text(user, raw) : this.hideDetails(await this.files.localLinks(user, raw))
  }
  async project(user, value) {
    return this.projectAs(user, user, value)
  }
  async projectAs(viewer, sourceUser, value) {
    const data = object(value)
    if (!data || typeof data.id !== 'string') return undefined
    const result = pick(data, ['id', 'title', 'stage'])
    if (['oa6-1', 'gm3-1', 'gr4-7', 'independent-skills'].includes(data.agent_id)) result.agent_id = data.agent_id
    if (Array.isArray(data.artifacts)) result.artifacts = data.artifacts.map(row => ({
      ...pick(row, ['id', 'name', 'content', 'kind', 'status', 'export_status', 'source_message_id', 'source_response_sha256']),
      ...documentEvidence(row),
      ...(row?.export_error ? { export_error: 'Word 文件生成失败，正文已保存，可稍后重试导出。' } : {})
    }))
    for (const key of ['source', 'core', 'plan']) if (object(data[key])) result[key] = pick(data[key], ['content'])
    for (const key of ['outline_batches', 'script_batches']) result[key] = array(data[key]).map(row => pick(row, ['id', 'content', 'status', 'start', 'end', 'final']))
    result.exports = []
    for (const row of array(data.exports)) {
      let handle
      try { handle = await this.files.registerAs(viewer, sourceUser, row?.path ?? row?.destination, 'export') } catch (error) { if (!error.status) throw error }
      if (handle) result.exports.push({ ...pick(row, ['name', 'artifact_name', 'artifact_id', 'format', 'kind', 'source_kind', 'status', 'content_verified', 'layout_verified', 'content_sha256', 'sha256', 'source_message_id', 'source_response_sha256']), ...documentEvidence(row), path: handle })
    }
    return result
  }
  async businessResult(user, value) {
    return this.businessResultAs(user, user, value)
  }
  async businessResultAs(viewer, sourceUser, value) {
    let raw = value
    if (typeof raw === 'string' && raw.startsWith('<persisted-output>')) {
      const source = raw.match(/^Full output saved to: (.+)$/m)?.[1]
      if (source && /\/cache\/spillover\/call_[\w-]+\.txt$/.test(source)) {
        try {
          const target = await this.backend.file(sourceUser, source)
          // 内容读取发生在账号隔离进程内，路径校验与打开之间的替换不能借宿主进程越界。
          raw = await readReceipt(await this.backend.fetch('/api/fs/download', sourceUser, { path: target }))
        } catch { raw = null }
      }
    }
    const data = object(raw)
    const rawText = typeof raw === 'string' ? raw.trim() : ''
    const nonJsonFailure = !data && /\[TOOL_ERROR\]|(?:APIConnectionError|PermissionError|ValueError|Traceback)|\b(?:Error|Failed):/i.test(rawText)
    const failed = nonJsonFailure || data?.ok === false || data?.success === false || Boolean(data?.error) || typeof data?.exit_code === 'number' && data.exit_code !== 0
    const result = { ok: !failed, summary: failed ? '创作操作未完成，请根据当前阶段继续处理。' : '创作操作已返回。' }
    if (failed) {
      result.error = '创作操作未完成。'
      if (nonJsonFailure) result.error_kind = 'tool_execution_error'
      if (typeof data?.blocked_reason === 'string') result.blocked_reason = data.blocked_reason
      if (typeof data?.required_user_action === 'string') {
        result.required_user_action = this.display(viewer, data.required_user_action)
        result.summary = result.required_user_action
      }
      if (typeof data?.retryable === 'boolean') result.retryable = data.retryable
    }
    if (data?.saved === true) result.saved = true
    if (['ready', 'pending', 'internal', 'failed'].includes(data?.export_status)) result.export_status = data.export_status
    if (data?.export_status === 'failed') result.export_error = 'Word 文件生成失败，正文已保存，可稍后重试导出。'
    const receipt = object(data?.receipt)
    if (receipt) {
      let handle
      try { handle = await this.files.registerAs(viewer, sourceUser, receipt.path ?? receipt.destination, 'export') } catch (error) { if (!error.status) throw error }
      if (handle) result.receipt = { ...pick(receipt, ['name', 'format', 'artifact_id', 'artifact_name', 'kind', 'source_kind', 'status', 'content_verified', 'layout_verified', 'content_sha256', 'sha256', 'source_message_id', 'source_response_sha256']), ...documentEvidence(receipt), path: handle }
    }
    const project = await this.projectAs(viewer, sourceUser, data?.project)
    if (project) { result.project = project; if (!failed) result.summary = result.receipt ? '稿件已保存，Word 文件可下载。' : '项目阶段已更新。' }
    if (data?.saved === true && data?.export_status === 'failed') result.summary = result.export_error
    return result
  }
  async text(user, value, role = 'assistant') {
    return this.textAs(user, user, value, role)
  }
  async textAs(viewer, sourceUser, value, role = 'assistant') {
    let text = typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n') : ''
    if (role === 'user') text = text.split(/\n\n--- (?:Attached Context|Context Warnings) ---/)[0]
    else text = publicRuntimeFailure(text)
    text = await this.files.outgoingAs(viewer, sourceUser, text)
    if (role === 'assistant') text = await this.files.localLinksAs(viewer, sourceUser, text)
    return role === 'user' ? text : this.hideDetails(this.display(sourceUser, text))
  }
  async nativeMessages(user, rows) {
    return Promise.all(logicalMessages(rows).map(async row => {
      if (row?.role !== 'assistant') return row
      const result = { ...row }
      for (const key of ['content', 'text', 'display_content']) if (typeof result[key] === 'string') result[key] = await this.hideDetails(await this.files.localLinks(user, publicRuntimeFailure(result[key])))
      return result
    }))
  }
  async displayMetadata(user, value, kind) {
    const data = object(value) || {}, result = pick(data, ['delegation_id', 'task_count', 'completed_count', 'failed_count', 'duration_seconds', 'interrupted'])
    // 后台进程的 display_text 包含命令；仅子代理完成摘要由公开目标组成。
    if (kind === 'async_delegation_complete' && typeof data.display_text === 'string') result.display_text = await this.text(user, data.display_text)
    if (data.notification_category === 'diagnostic') result.notification_category = 'diagnostic'
    return result
  }
  async subagent(user, value) {
    const result = pick(value, subagentFields)
    if (typeof value?.goal === 'string') result.goal = await this.text(user, value.goal)
    if (subagentStatuses.has(value?.status)) result.status = value.status
    for (const key of ['tool_name', 'last_tool']) if (typeof value?.[key] === 'string') result[key] = safeName(value[key])
    return this.backend.modelNames?.info(user, result, this.backend.catalogs.get(user.id)) || result
  }
  async inflight(user, value) {
    const data = object(value)
    if (!data) return undefined
    const result = { ...pick(data, ['streaming', 'status', 'recoverable']), assistant: await this.text(user, data.assistant) }
    if (displayKinds.has(data.display_kind)) {
      result.display_kind = data.display_kind
      result.display_metadata = await this.displayMetadata(user, data.display_metadata, data.display_kind)
      result.user = result.display_metadata.display_text || noticeTexts[data.display_kind]
    } else result.user = await this.text(user, data.user, 'user')
    if (Array.isArray(data.corrections)) result.corrections = await Promise.all(data.corrections.filter(value => typeof value === 'string').map(value => this.text(user, value, 'user')))
    if (Array.isArray(data.correction_offsets) && data.correction_offsets.length === result.corrections?.length && data.correction_offsets.every(value => Number.isInteger(value) && value >= 0)) result.correction_offsets = data.correction_offsets
    if (data.error) result.error = '本轮创作未完成，请重试。'
    return result
  }
  async toolResult(user, name, value, args) {
    return this.toolResultAs(user, user, name, value, args)
  }
  async toolResultAs(viewer, sourceUser, name, value, args) {
    const result = await this.businessResultAs(viewer, sourceUser, value)
    if (name === 'image_generate') {
      const data = object(value)
      if (data?.success === true && typeof data.image === 'string') {
        const handle = await this.files.registerAs(viewer, sourceUser, data.image, 'image')
        if (handle) Object.assign(result, { image: handle, summary: '图片已生成，可查看和下载。', success: true })
      }
      if (!result.image) Object.assign(result, { ok: false, success: false, error: '图片未生成，请检查生图模型配置或稍后重试。' })
    }
    if (['skill_view', 'skills_list'].includes(name)) result.summary = publicSkillSummary(name, publicSkillArguments(object(args)), result)
    return result
  }
  async messages(user, value) {
    return this.messagesAs(user, user, value)
  }
  async messagesAs(viewer, sourceUser, value) {
    const rows = []
    for (const row of logicalMessages(value)) {
      if (row?.display_kind === 'hidden' || !['user', 'assistant', 'tool'].includes(row?.role)) continue
      const base = pick(row, ['row_id', 'id', 'role', 'tool_call_id', 'timestamp'])
      if (displayKinds.has(row.display_kind)) { base.display_kind = row.display_kind; base.display_metadata = await this.displayMetadata(sourceUser, row.display_metadata, row.display_kind) }
      if (row.role === 'tool') {
        const name = row.name || row.tool_name
        const receipt = row.content ?? row.text
        // 紧凑历史省略正文时保留未知态，等待正式回执补全，不能凭工具结束推断成功。
        const missing = receipt == null || typeof receipt === 'string' && !receipt.trim()
        rows.push({ ...base, name: safeName(name), args: publicArguments(name, row.args), content: missing ? null : await this.toolResultAs(viewer, sourceUser, name, receipt, row.args) })
      }
      else {
        const content = base.display_kind ? base.display_metadata.display_text || noticeTexts[base.display_kind] : await this.textAs(viewer, sourceUser, row.display_content ?? row.text ?? row.content, row.role)
        if (row.role === 'user' && /^\[(?:STILL IN PROGRESS|ASYNC DELEGATION)/.test(content)) continue
        rows.push({ ...base, content, text: content })
      }
    }
    return rows
  }
  modelInfo(user, value, sessionId) {
    const result = info(value)
    const slot = sessionId && this.backend.runtimeStates.get(sessionId)?.modelDisplaySlot
    const catalog = this.backend.catalogs.get(user.id)
    if (!this.backend.modelNames) return result
    const state = sessionId && this.backend.runtimeStates.get(sessionId)
    const model = value?.model || state?.model
    const provider = value?.provider || state?.provider
    const source = array(catalog?.providers).find(row => row.slug === provider || array(row.aliases).includes(provider))
    const projected = this.backend.modelNames.info(user, result, catalog, slot)
    if (model && projected.model) projected.model_capabilities = { model: projected.model, capabilities: safeCapabilities(source?.capabilities, [model])[model] }
    return projected
  }
  async catalog(user, value) {
    const providers = array(value?.providers).filter(row => row?.authenticated !== false).map(row => {
      const models = array(row.models).filter(model => typeof model === 'string')
      return { slug: String(row.slug || ''), aliases: array(row.aliases).filter(alias => typeof alias === 'string'), name: this.display(user, row.name || '创作模型'), models, capabilities: safeCapabilities(row.capabilities, models), image_models: array(row.image_models).filter(model => typeof model === 'string'), image_model: typeof row.image_model === 'string' ? row.image_model : '' }
    })
    const result = { ...pick(value, ['model', 'provider']), providers }
    this.backend.catalogs.set(user.id, result)
    return this.backend.modelNames ? this.backend.modelNames.catalog(user, result) : result
  }
  request(user, frame) {
    // 创作页面只承接剧本确认；技术权限仍由 Hermes 拒绝路径处理，超级管理员也不例外。
    const params = frame.params
    if (!params?.session_id || this.backend.runtimeOwners.get(params.session_id) !== user.id) return null
    if (frame.method === 'clarify') return { jsonrpc: '2.0', id: frame.id, method: 'clarify', params: { session_id: params.session_id,
      questions: array(params.questions).map(row => ({ qid: String(row.qid || ''), question: this.display(user, row.question), choices: array(row.choices).filter(value => typeof value === 'string').map(value => this.display(user, value)) })) } }
    const key = params.pattern_key
    if (frame.method !== 'approval' || typeof key !== 'string' || !/^plugin_rule:jubao-drama:[a-f0-9]{32}$/.test(key) || array(params.pattern_keys).some(value => value !== key)) return null
    return { jsonrpc: '2.0', id: frame.id, method: 'approval', params: { ...pick(params, ['session_id', 'request_id']), description: this.display(user, params.description), choices: ['once', 'deny'], allow_permanent: false, allow_session: false } }
  }
  answer(user, question, frame) {
    if (frame.error) return { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: '当前页面无法处理此请求。' } }
    if (question.method === 'approval') return { jsonrpc: '2.0', id: frame.id, result: { choice: frame.result?.choice === 'once' ? 'once' : 'deny' } }
    const answers = object(frame.result?.answers) || {}, accepted = {}
    for (const row of question.params.questions) if (typeof answers[row.qid] === 'string') accepted[row.qid] = answers[row.qid].slice(0, 20000)
    return { jsonrpc: '2.0', id: frame.id, result: { answers: accepted } }
  }
  async event(user, frame, streams = this.streams) {
    if (frame.method === 'event') frame = { ...frame, params: { ...frame.params, payload: errorEventPayload(frame.params?.type, frame.params?.payload || {}) } }
    if (!isEmployee(user)) {
      const event = frame.method === 'event' && frame.params, payload = event?.payload || {}
      if (event?.type === 'session.info') return { ...frame, params: { ...event, payload: this.modelInfo(user, payload, event.session_id) } }
      if (event?.type?.startsWith('subagent.')) return { ...frame, params: { ...event, payload: await this.subagent(user, payload) } }
      if (event?.type === 'message.start') streams.delete(user.id + ':' + event.session_id)
      if (event?.type === 'message.delta') this.stream(user, event.session_id, payload.text ?? payload.delta, streams)
      if (['message.complete', 'message.interim'].includes(event?.type)) return { ...frame, params: { ...event, payload: { ...payload, text: await this.finish(user, event.session_id, payload.text, streams) } } }
      return frame
    }
    if (frame.method !== 'event') return null
    const event = frame.params || {}, p = event.payload || {}, type = event.type
    if (type === 'gateway.ready') return { jsonrpc: '2.0', method: 'event', params: { type, payload: pick(p, ['replay_epoch', 'heartbeat']) } }
    if (!event.session_id || this.backend.runtimeOwners.get(event.session_id) !== user.id) return null
    const handlers = {
      'message.start': () => { streams.delete(user.id + ':' + event.session_id); return pick(p, ['message_id']) },
      'message.delta': () => ({ text: this.stream(user, event.session_id, p.text ?? p.delta, streams) }),
      'message.interim': async () => ({ ...pick(p, ['already_streamed']), text: await this.finish(user, event.session_id, p.text, streams) }),
      'message.complete': async () => ({ ...pick(p, ['status', 'response_previewed', 'response_transformed', 'recoverable', 'partial']), text: await this.finish(user, event.session_id, p.text, streams), ...(p.error || p.failure_reason ? { error: this.display(user, publicError(p.error || p.failure_reason, '本轮创作未完成，请重试。')) } : {}) }),
      'tool.start': () => ({ ...pick(p, ['tool_id']), name: safeName(p.name), args: publicArguments(p.name, p.args) }),
      'tool.complete': async () => ({ ...pick(p, ['tool_id', 'duration_s']), name: safeName(p.name), args: publicArguments(p.name, p.args), result: await this.toolResult(user, p.name, p.result ?? p.result_text, p.args) }),
      'tool.generating': () => ({ name: safeName(p.name) }),
      'session.info': () => this.modelInfo(user, p, event.session_id),
      'session.title': () => ({ title: this.display(user, p.title) }),
      'request.cancel': () => pick(p, ['id']),
      'error': () => ({ message: this.display(user, publicError(p.message)) }),
      'status.update': () => publicStatus(p),
      'review.summary': async () => ({ text: await this.text(user, p.text) }),
      'background.complete': async () => ({ ...pick(p, ['task_id']), text: await this.text(user, p.text) }),
      'notification.show': async () => ({ ...pick(p, ['key', 'id', 'ttl_ms']), level: ['info', 'warn', 'error', 'success'].includes(p.level) ? p.level : 'info', kind: ['sticky', 'ttl', 'agent'].includes(p.kind) ? p.kind : 'ttl', text: await this.text(user, p.text) }),
      'notification.clear': () => pick(p, ['key']),
      // 保留模型活动信号；等待动画、内部推理正文及其附带字段不进入员工页面。
      'thinking.delta': () => ({}),
      'reasoning.delta': () => ({}),
      'reasoning.available': () => ({}),
      ...Object.fromEntries(['spawn_requested', 'start', 'progress', 'thinking', 'tool', 'complete'].map(name => ['subagent.' + name, () => this.subagent(user, p)]))
    }
    if (!Object.hasOwn(handlers, type)) return null
    return { jsonrpc: '2.0', method: 'event', params: { ...pick(event, ['type', 'session_id', 'seq', 'epoch', 'replayed', 'timestamp']), payload: await handlers[type]() } }
  }
  async rpc(user, call, frame, onRequest) {
    if (frame.error) return { jsonrpc: '2.0', id: frame.id, error: { code: typeof frame.error.code === 'number' ? frame.error.code : 503, message: isEmployee(user) ? this.display(user, publicError(frame.error.message)) : publicError(frame.error.message) } }
    if (call.method === 'model.options' && !frame.error) {
      let value = frame.result
      try { value = await enrichReasoning(value, this.backend.homeFor(user), this.backend.repoRoot, this.backend.workerPool?.nativeRuntime) }
      catch { /* 能力目录不可用时保留模型列表，不猜测可调档位。 */ }
      return { ...frame, result: await this.catalog(user, value) }
    }
    const value = frame.result || {}
    const openRequests = () => array(value.open_requests).map(row => onRequest(row)).filter(Boolean)
    if (!isEmployee(user)) {
      const result = { ...value }
      if (object(value.info)) result.info = this.modelInfo(user, value.info, value.session_id || call.params?.session_id)
      if (call.method === 'config.set' && value.key === 'model' && typeof value.value === 'string') result.value = result.info?.model || ''
      if (Array.isArray(value.subagents)) result.subagents = await Promise.all(value.subagents.map(row => this.subagent(user, row)))
      if (Array.isArray(value.open_requests)) result.open_requests = openRequests()
      if (Array.isArray(value.messages)) result.messages = await this.nativeMessages(user, value.messages)
      if (object(value.inflight)) result.inflight = { ...value.inflight, assistant: await this.files.localLinks(user, value.inflight.assistant) }
      if (Array.isArray(value.events)) {
        result.events = []
        const replayStreams = new Map()
        for (const row of value.events) result.events.push((await this.event(user, { method: 'event', params: row }, replayStreams)).params)
      }
      return frame.result ? { ...frame, result } : frame
    }
    const handlers = {
      'gateway.ping': () => ({ pong: true }),
      'client.capabilities': () => ({ ok: true }),
      'model.options': () => this.catalog(user, value),
      'config.set': () => {
        const projected = this.modelInfo(user, value.info, call.params?.session_id)
        return { ...pick(value, ['key', 'value', 'scope', 'deferred', 'confirm_required']), ...(value.key === 'model' ? { value: projected.model || '' } : {}), info: projected }
      },
      'session.list': () => ({ sessions: array(value.sessions).map(row => ({ ...pick(row, ['id', 'resolved_id', 'started_at', 'message_count', 'live_message_count']), title: this.display(user, row.title), preview: this.display(user, row.preview) })) }),
      'session.create': async () => ({ ...pick(value, ['session_id', 'stored_session_id', 'running', 'turn_started_at', 'message_count']), messages: await this.messages(user, value.messages), info: this.modelInfo(user, value.info, value.session_id), open_requests: openRequests() }),
      'session.resume': async () => ({ ...pick(value, ['session_id', 'stored_session_id', 'running', 'turn_started_at', 'message_count', 'status', 'hydrating', 'messages_omitted', 'started_at']), messages: await this.messages(user, value.messages), info: this.modelInfo(user, value.info, value.session_id), open_requests: openRequests(), ...(object(value.inflight) ? { inflight: await this.inflight(user, value.inflight) } : {}), ...(object(value.auto_continue) ? { auto_continue: pick(value.auto_continue, ['attempt', 'interrupted_at']) } : {}) }),
      'subagent.list': async () => ({ subagents: await Promise.all(array(value.subagents).map(row => this.subagent(user, row))), delegations: await Promise.all(array(value.delegations).map(async row => ({ ...pick(row, ['delegation_id', 'task_index', 'dispatched_at', 'completed_at']), ...(subagentStatuses.has(row?.status) ? { status: row.status } : {}), goal: await this.text(user, row?.goal) }))) }),
      'session.events.since': async () => {
        const events = [], replayStreams = new Map()
        for (const row of array(value.events)) { const event = await this.event(user, { method: 'event', params: row }, replayStreams); if (event) events.push(event.params) }
        return { ...pick(value, ['session_id', 'count', 'epoch', 'truncated', 'latest_seq']), events, open_requests: openRequests() }
      },
      'session.interrupt': () => pick(value, ['interrupted', 'ok', 'status']),
      'prompt.submit': () => pick(value, ['accepted', 'ok', 'status', 'queued', 'session_id']),
      'file.attach': async () => {
        const handle = value.attached && await this.files.register(user, value.path)
        if (!handle) return { attached: false, name: call.params.name, path: '', ref_path: '', ref_text: '', uploaded: false }
        return { attached: true, name: call.params.name, path: handle, ref_path: handle, ref_text: '@file:`' + handle + '`', uploaded: Boolean(value.uploaded) }
      }
    }
    return { jsonrpc: '2.0', id: frame.id, result: Object.hasOwn(handlers, call.method) ? await handlers[call.method]() : {} }
  }
}
