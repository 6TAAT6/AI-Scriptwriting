import { randomId } from './id'
import type { TranscriptMessage } from '../../../shared/src/gateway-contract.generated'
export type { TranscriptMessage }
import { progressEvent, type TurnProgress } from './progress'
import type { ToolReceipt } from './creative'
import { activityDescriptor, activityLabel, argumentSummary, blockedResult, failedResult, resultSummary, revisionEvidence } from './activity-summary'
import { historyNotice, nativeEvent, settleThinking, type NativeSubagent } from './native-activity'
import { attachedFiles, attachedImages, attachmentText } from './attachments'
import { isSupportedFile } from '../../shared/attachments.mjs'
import { savedCapabilitySelection, savedCapabilityCommands, splitCapabilityDraft, capabilityCommands, selectionAfter, type CapabilitySelection, type CapabilityCommand } from './capabilities'
import { publicError, publicRuntimeFailure } from '../../shared/public-errors.mjs'

export interface Activity {
  image?: string
  id: string
  name: string
  label: string
  state: 'running' | 'complete' | 'error' | 'blocked' | 'interrupted' | 'unknown'
  seconds?: number
  argumentSummary?: string
  resultSummary?: string
  verb?: string
  object?: string
  startedAt?: number
  endedAt?: number
  startTimeSource?: 'local' | 'history'
  downloads?: ToolDownload[]
  revisionEvidence?: import('./revision-merge').RevisionEvidence
}

export interface ToolDownload {
  documentId?: string
  path: string
  name: string
  format: string
  status?: string
}

export interface Entry {
  capabilities?: CapabilitySelection
  capabilityCommands?: CapabilityCommand[]
  attachments?: { path: string; name: string }[]
  images?: { path: string; name: string }[]
  id: string
  role: 'user' | 'assistant' | 'activity' | 'status' | 'thinking' | 'subagent'
  turnId?: string
  text: string
  calls: Activity[]
  pending?: boolean
  noticeKind?: string
  subagent?: NativeSubagent
  /** 步骤组：本轮稿件写出后模型正在思考（下一步尚未开始）。 */
  thinking?: boolean
  /** 同一轮后面的返修稿已按集号合并进这段正文；draft 是修订前的初稿，供“查看初稿”展开。 */
  revision?: { draft: string }
}

function generatedImage(value: unknown): string | undefined {
  if (typeof value === 'string') { try { return generatedImage(JSON.parse(value)) } catch { return undefined } }
  if (!value || typeof value !== 'object') return undefined
  const result = value as Record<string, unknown>
  return (result.success === true || result.ok === true) && typeof result.image === 'string' && result.image.startsWith('/') && /\.(png|jpe?g|webp)$/i.test(result.image) ? result.image : undefined
}

function objectResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { return objectResult(JSON.parse(value)) } catch { return null } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 从正式工具回执中读取可下载的交付文件；不根据正文名称猜测文件路径。 */
export function toolDownloads(value: unknown): ToolDownload[] {
  const root = objectResult(value)
  if (!root) return []
  const rows: unknown[] = []
  const receipt = objectResult(root.receipt)
  if (receipt) rows.push(receipt)
  const found = new Map<string, ToolDownload>()
  for (const raw of rows) {
    const item = objectResult(raw)
    const path = item?.path ?? item?.destination
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('/../') || !/\.(docx|xlsx)$/i.test(path)) continue
    const name = typeof item?.name === 'string' ? item.name : path.split(/[\\/]/).pop() || '交付文件'
    const format = typeof item?.format === 'string' ? item.format.toLowerCase() : path.split('.').pop()?.toLowerCase() || ''
    const documentId = item?.artifact_id ?? item?.document_id
    found.set(path, { path, name, format, status: typeof item?.status === 'string' ? item.status : undefined,
      ...(typeof documentId === 'string' && documentId ? { documentId } : {}) })
  }
  return [...found.values()]
}

export interface Conversation {
  runtimeId: string
  turnId?: string
  entries: Entry[]
  running: boolean
  error: string
  turn?: TurnProgress
  asyncPending?: number
  seenEvents?: string[]
}

export interface StudioEvent {
  type: string
  session_id?: string
  payload: Record<string, unknown>
  replayed?: boolean
  seq?: number
  epoch?: string
  replayEpoch?: string
}

// 员工可见文案由服务端投影；客户端不把未知对象序列化成运行日志。
export function publicText(value: unknown, fallback = '创作服务暂时不可用，请稍后重试。'): string {
  return publicError(value, fallback)
}

export function userDisplayText(text: string): string {
  const body = text.startsWith('【本轮语言偏好】\n') && text.includes('\n\n【用户本轮消息】\n') ? text.slice(text.indexOf('\n\n【用户本轮消息】\n') + '\n\n【用户本轮消息】\n'.length) : text
  const content = splitCapabilityDraft(body.split(/\n\n--- (?:Attached Context|Context Warnings) ---/)[0]).body
  const visible = attachedImages(content).length ? content.replace(/(?:\n\[screenshot\])+\s*$/, '') : content
  return visible.replace(/@file:(?:`([^`]+)`|"([^"]+)"|([^\s]+))/g, (_match, quoted, doubleQuoted, plain) => {
    const path = String(quoted || doubleQuoted || plain)
    const name = path.split(/[\\/]/).pop()!
    // 可显示的附件由独立文件标记或图片预览承载，未知引用仍保留名称。
    if (path.startsWith('/') && isSupportedFile(path)) return ''
    return `附件：${name}`
  }).trim()
}

/** 紧凑历史省略的回执从当前会话的正式消息恢复；不覆盖正在流式返回的操作。 */
export function restoreToolReceipts(entries: Entry[], receipts: ToolReceipt[]): Entry[] {
  const byId = new Map(receipts.map(receipt => [receipt.id, receipt.content]))
  return entries.map(entry => ({ ...entry, calls: entry.calls.map(call => {
    if (!byId.has(call.id)) return call
    const content = byId.get(call.id)
    const downloads = toolDownloads(content)
    const withDownloads = downloads.length ? { downloads } : {}
    const evidence = revisionEvidence(content)
    const withEvidence = evidence ? { revisionEvidence: evidence } : {}
    // 原生桥接历史的名称可能是 tool_call；按同一调用的正式回执恢复图片。
    const image = generatedImage(content)
    if (image) return { ...call, ...withDownloads, ...withEvidence, name: 'image_generate', label: activityLabel('image_generate'), verb: '生成图片', object: undefined, image, state: 'complete' as const, resultSummary: '图片已生成，可查看和下载。' }
    if (!['unknown', 'interrupted'].includes(call.state)) return Object.keys(withDownloads).length || Object.keys(withEvidence).length ? { ...call, ...withDownloads, ...withEvidence } : call
    return { ...call, ...withDownloads, ...withEvidence, image, resultSummary: resultSummary(content), state: blockedResult(content) ? 'blocked' as const : failedResult(content) ? 'error' as const : 'complete' as const }
  }) }))
}

function appendActivity(entries: Entry[], call: Activity): Entry[] {
  const last = entries.at(-1)
  if (last?.role === 'activity') {
    return [...entries.slice(0, -1), { ...last, calls: [...last.calls, call] }]
  }
  return [...entries, { id: `activity-${call.id}`, role: 'activity', text: '', calls: [call] }]
}

export function historyEntries(messages: TranscriptMessage[]): Entry[] {
  let selection: CapabilitySelection | undefined
  let turnId = 'history-start'
  return messages.reduce<Entry[]>((entries, message, index) => {
    if (message.display_kind === 'hidden') return entries
    const id = String(message.row_id ?? `history-${index}`)
    const raw = attachmentText(message.text ?? message.content)
    const notice = historyNotice(message, id, raw)
    if (notice) return [...entries, notice]
    if (message.role === 'tool') {
      const name = message.name ?? 'tool'
      return appendActivity(entries, {
        id: message.tool_call_id ?? id, name, label: activityLabel(name),
        argumentSummary: argumentSummary(name, message.args, message.context), ...activityDescriptor(name, message.args, message.context),
        image: name === 'image_generate' ? generatedImage(message.content) : undefined,
        downloads: toolDownloads(message.content),
        revisionEvidence: revisionEvidence(message.content),
        resultSummary: resultSummary(message.content, message.summary),
        state: message.content == null ? 'unknown' : blockedResult(message.content) ? 'blocked' : failedResult(message.content) ? 'error' : 'complete'
      })
    }
    if (message.role !== 'user' && message.role !== 'assistant') return entries
    if (message.role === 'user' && raw.startsWith('[STILL IN PROGRESS — this is the active request, restated after the compaction boundary')) return entries
    if (message.role === 'user') turnId = id
    const text = message.role === 'user' ? userDisplayText(raw) : publicRuntimeFailure(raw)
    const images = message.role === 'user' ? attachedImages(raw) : []
    const attachments = message.role === 'user' ? attachedFiles(raw) : []
    const commands = message.role === 'user' ? savedCapabilityCommands(raw) ?? capabilityCommands(raw) : []
    const capabilities = message.role === 'user' ? savedCapabilitySelection(raw, selection) ?? selectionAfter(selection ?? { skills: [] }, raw, commands) : undefined
    if (capabilities) selection = capabilities
    if (!text.trim() && !images.length && !attachments.length && !commands.length) return entries
    return [...entries, { id, role: message.role, turnId, text, calls: [], ...(capabilities ? { capabilities, capabilityCommands: commands } : {}), ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) }]
  }, [])
}

function assistantText(state: Conversation, text: string, append: boolean, pending: boolean): Conversation {
  const index = state.entries.findLastIndex(row => row.role === 'assistant' && row.pending && row.turnId === state.turnId)
  const last = state.entries[index]
  if (last) {
    return { ...state, entries: state.entries.map((row, position) => position === index ? {
      ...last, text: append ? last.text + text : text || last.text, pending
    } : row) }
  }
  if (!text) return state
  return { ...state, entries: [...state.entries, {
    id: `message-${randomId()}`, role: 'assistant', turnId: state.turnId, text, calls: [], pending
  }] }
}

function finishAssistant(state: Conversation, payload: Record<string, unknown>): Conversation {
  const text = typeof payload.text === 'string' ? payload.text : ''
  const index = state.entries.findLastIndex(entry => entry.role === 'assistant')
  const userIndex = state.entries.findLastIndex(entry => entry.role === 'user')
  const preview = index > userIndex ? state.entries[index] : undefined
  if (payload.response_previewed && preview && (payload.response_transformed || preview.text === text)) {
    return { ...state, entries: state.entries.map((entry, position) => position === index ? { ...entry, text: text || entry.text, pending: false } : entry) }
  }
  return assistantText(state, text, false, false)
}

function settleEntries(entries: Entry[], state: 'unknown' | 'interrupted' = 'unknown'): Entry[] {
  return entries.map(entry => ({ ...entry, pending: false, calls: entry.calls.map(call => call.state === 'running' ? { ...call, state } : call) }))
}

const handlers: Record<string, (state: Conversation, payload: Record<string, unknown>, now: number, replayed?: boolean) => Conversation> = {
  'message.start': state => ({ ...state, turnId: randomId(), running: true, error: '' }),
  'message.delta': (state, payload) => assistantText(state, String(payload.text ?? ''), true, true),
  'message.interim': (state, payload) => {
    const text = String(payload.text ?? '')
    const last = state.entries.findLast(row => row.role === 'assistant')
    if (payload.already_streamed && last?.pending) return assistantText(state, text, false, false)
    if (payload.already_streamed && last?.role === 'assistant' && last.text === text) return state
    return assistantText({ ...state, entries: state.entries.map(entry => entry.pending ? { ...entry, pending: false } : entry) }, text, false, false)
  },
  'message.complete': (state, payload) => {
    const completed = finishAssistant(state, { ...payload, text: publicRuntimeFailure(payload.text) })
    return {
      ...completed, running: false,
      entries: settleEntries(completed.entries, payload.status === 'interrupted' || payload.status === 'error' ? 'interrupted' : 'unknown'),
      error: payload.status === 'error' ? publicError(payload.error || payload.failure_reason, '本次创作中断，请检查连接后继续。') : ''
    }
  },
  'tool.start': (state, payload, now, replayed) => {
    if (state.entries.some(entry => entry.calls.some(call => call.id === payload.tool_id))) return state
    const name = String(payload.name ?? 'tool')
    const sealed = state.entries.map(entry => entry.pending ? { ...entry, pending: false } : entry)
    return { ...state, entries: appendActivity(sealed, {
      id: String(payload.tool_id), name, label: activityLabel(name),
      state: 'running',
      argumentSummary: argumentSummary(name, payload.args, payload.context), ...activityDescriptor(name, payload.args, payload.context),
      ...(replayed ? {} : { startedAt: now, startTimeSource: 'local' as const })
    }) }
  },
  'tool.complete': (state, payload, now, replayed) => {
    const raw = payload.result
    const blocked = blockedResult(raw ?? payload.result_text)
    const failed = failedResult(raw ?? payload.result_text)
    const seconds = typeof payload.duration_s === 'number' && Number.isFinite(payload.duration_s) && payload.duration_s >= 0 ? payload.duration_s : undefined
    let found = false
    const entries = state.entries.map(entry => ({ ...entry, calls: entry.calls.map(call => {
      if (call.id !== payload.tool_id) return call
      found = true
      return { ...call, resultSummary: resultSummary(raw ?? payload.result_text, payload.summary), image: call.name === 'image_generate' ? generatedImage(raw ?? payload.result_text) : undefined,
        downloads: toolDownloads(raw ?? payload.result_text),
        revisionEvidence: revisionEvidence(raw ?? payload.result_text),
        state: blocked ? 'blocked' as const : failed ? 'error' as const : 'complete' as const, seconds,
        endedAt: replayed ? undefined : now }
    }) }))
    if (found) return { ...state, entries }
    const name = String(payload.name ?? 'tool')
    return { ...state, entries: appendActivity(entries, {
      id: String(payload.tool_id), name, label: activityLabel(name), image: name === 'image_generate' ? generatedImage(raw ?? payload.result_text) : undefined,
      state: blocked ? 'blocked' : failed ? 'error' : 'complete',
      argumentSummary: argumentSummary(name, payload.args), ...activityDescriptor(name, payload.args), resultSummary: resultSummary(raw ?? payload.result_text, payload.summary),
      downloads: toolDownloads(raw ?? payload.result_text),
      revisionEvidence: revisionEvidence(raw ?? payload.result_text),
      seconds, endedAt: replayed ? undefined : now
    }) }
  },
  'session.info': (state, payload) => {
    if (typeof payload.running !== 'boolean' || (payload.running === false && state.turn?.phase === 'preparing' && state.running)) return state
    return { ...state, running: payload.running, entries: payload.running ? state.entries : settleEntries(state.entries) }
  },
  error: (state, payload) => ({ ...state, running: false, error: publicError(payload.message), entries: settleEntries(state.entries) })
}

export function reduceEvent(state: Conversation, event: StudioEvent, now = Date.now()): Conversation {
  if (event.session_id !== state.runtimeId) return state
  const epoch = event.replayEpoch ?? event.epoch
  const key = typeof event.seq === 'number' && epoch ? `${epoch}:${event.seq}` : undefined
  if (key && state.seenEvents?.includes(key)) return state
  const base = ['message.delta', 'message.interim', 'message.complete', 'tool.start', 'error'].includes(event.type) ? settleThinking(state) : state
  const handled = handlers[event.type]?.(base, event.payload, now, event.replayed) ?? base
  const next = nativeEvent(handled, event, now)
  const turn = progressEvent(state.turn, event, now)
  return next === state && turn === state.turn && !key ? state : { ...next, turn, ...(key ? { seenEvents: [...(state.seenEvents ?? []).slice(-1023), key] } : {}) }
}
