import { randomId } from './id'
import type { FailedDelegation, SubagentSnapshot, SubagentStatus, TranscriptMessage } from '../../../shared/src/gateway-contract.generated'
import type { Conversation, Entry, StudioEvent } from './transcript'
import { progressText } from './progress'

export interface NativeSubagent {
  id: string
  goal: string
  status: SubagentStatus
  model?: string
  toolCount?: number
  lastTool?: string
  preview?: string
  elapsed?: number
  startedAt?: number
  delegationId?: string
  taskIndex?: number
  sequence?: number
  epoch?: string
  retired?: boolean
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const terminal = (status: SubagentStatus) => !['queued', 'running'].includes(status)
const statuses = new Set(['queued', 'running', 'completed', 'failed', 'error', 'timeout', 'interrupted'])

export function nativeNotice(id: string, kind: string, content: string): Entry {
  return { id, role: 'status', text: content, calls: [], noticeKind: kind }
}

export function historyNotice(message: TranscriptMessage, id: string, raw: string): Entry | undefined {
  if (message.display_kind === 'auto_continue') return nativeNotice(id, 'auto_continue', '正在自动恢复上次中断的任务')
  if (message.display_kind === 'async_delegation_complete') return nativeNotice(id, 'background.complete', '后台任务已返回，继续处理本轮请求')
  if (message.display_kind === 'process_complete') return nativeNotice(id, 'background.complete', '后台任务已结束')
  if (message.display_kind === 'model_switch') return nativeNotice(id, 'model_switch', '模型已切换')
  if (message.display_kind === 'personality_switch') return nativeNotice(id, 'personality_switch', '助手风格已切换')
  if (message.display_kind === 'failed_turn') return nativeNotice(id, 'failed_turn', '上次执行未完成')
  if (raw.startsWith('[ASYNC DELEGATION BATCH COMPLETE')) return nativeNotice(id, 'background.complete', '后台任务已返回，继续处理本轮请求')
  if (message.display_kind === 'review.summary') return nativeNotice(id, 'review.summary', raw)
  return undefined
}

export function settleThinking(state: Conversation): Conversation {
  if (!state.entries.some(row => row.role === 'thinking' && row.pending)) return state
  return { ...state, entries: state.entries.map(row => row.role === 'thinking' && row.pending ? { ...row, pending: false } : row) }
}

function subagentIdentity(p: Record<string, unknown>): string {
  return text(p.subagent_id) || (text(p.delegation_id) && p.task_index != null ? `${p.delegation_id}:${p.task_index}` : '')
}

function upsertSubagent(state: Conversation, p: Record<string, unknown>, eventType: string, now?: number, seq?: number, epoch?: string): Conversation {
  const related = state.entries.find(row => row.subagent?.delegationId && row.subagent.delegationId === p.delegation_id && row.subagent.taskIndex === p.task_index)
  const id = text(p.subagent_id) || related?.subagent?.id || subagentIdentity(p)
  if (!id) return state
  const previous = state.entries.find(row => row.subagent?.id === id)
  const old = previous?.subagent
  if (old?.retired) return state
  const candidate = (statuses.has(String(p.status)) ? p.status : eventType === 'subagent.complete' ? 'failed' : eventType === 'subagent.spawn_requested' ? 'queued' : 'running') as SubagentStatus
  const status = eventType === 'subagent.complete' && !terminal(candidate) ? 'failed' : candidate
  if (seq !== undefined && old?.sequence !== undefined && old.epoch === epoch && seq < old.sequence) return state
  // 完成事件比慢快照和迟到的进度更可靠，不能把已经结束的子任务重新点亮。
  if (old && terminal(old.status) && !terminal(status)) return state
  const number = (value: unknown, fallback?: number) => count(value) ?? fallback
  const started = count(p.started_at)
  const subagent: NativeSubagent = {
    id, status, goal: text(p.goal) || old?.goal || '独立任务',
    model: text(p.model) || old?.model,
    toolCount: p.tool_count == null ? old?.toolCount : Math.max(number(p.tool_count, old?.toolCount) ?? 0, old?.toolCount ?? 0),
    lastTool: text(p.tool_name ?? p.last_tool) || old?.lastTool,
    elapsed: number(p.duration_seconds, old?.elapsed),
    startedAt: old?.startedAt ?? (started === undefined ? now : started * 1000),
    delegationId: text(p.delegation_id) || old?.delegationId,
    taskIndex: number(p.task_index, old?.taskIndex),
    sequence: seq ?? old?.sequence, epoch: epoch ?? old?.epoch
  }
  if (eventType === 'subagent.snapshot' && old) {
    if (terminal(old.status)) return state
    Object.assign(subagent, Object.fromEntries(Object.entries(old).filter(([, value]) => value !== undefined)))
    subagent.status = status
    if (terminal(status)) subagent.elapsed = count(p.duration_seconds) ?? old.elapsed
  }
  const entry: Entry = { id: previous?.id || `subagent-${id}`, role: 'subagent', text: '', calls: [], subagent }
  const entries = previous ? state.entries.map(row => row === previous ? entry : row) : [...state.entries, entry]
  return { ...state, entries, asyncPending: entries.filter(row => row.subagent && !row.subagent.retired && !terminal(row.subagent.status)).length }
}

export function restoreSubagents(state: Conversation, snapshots: SubagentSnapshot[], delegations: FailedDelegation[] = []): Conversation {
  const ids = new Set(snapshots.map(row => row.subagent_id))
  // 与原生活动列表一致：权威名单里已消失的任务退出显示，保留身份防止迟到事件复活。
  const entries = state.entries.map(row => row.subagent && !terminal(row.subagent.status) && !ids.has(row.subagent.id)
    ? { ...row, subagent: { ...row.subagent, retired: true } } : row)
  const reconciled: Conversation = { ...state, entries, asyncPending: entries.filter(row => row.subagent && !row.subagent.retired && !terminal(row.subagent.status)).length }
  const live = snapshots.reduce((current, row) => upsertSubagent(current, { ...row }, 'subagent.snapshot'), reconciled)
  return delegations.reduce((current, row) => upsertSubagent(current, { ...row, task_index: row.task_index ?? 0 }, 'subagent.complete'), live)
}

export function nativeEvent(state: Conversation, event: StudioEvent, now: number): Conversation {
  const p = event.payload
  if (event.type.startsWith('subagent.')) return upsertSubagent(state, p, event.type, event.replayed ? undefined : now, event.seq, event.replayEpoch ?? event.epoch)
  if (['reasoning.delta', 'reasoning.available', 'thinking.delta'].includes(event.type) || event.type === 'status.update' && p.kind === 'thinking') {
    if (!state.running || state.entries.some(row => row.role === 'thinking' && row.pending)) return state
    return { ...state, entries: [...state.entries, { id: `thinking-${randomId()}`, role: 'thinking', text: '', calls: [], pending: true }] }
  }
  if (event.type === 'notification.clear') {
    return { ...state, entries: state.entries.filter(row => row.id !== `notification-${text(p.key)}`) }
  }
  const noticeKinds = ['review.summary', 'background.complete', 'status.update', 'notification.show']
  if (!noticeKinds.includes(event.type)) return state
  let content = text(p.text)
  if (event.type === 'status.update' && (!content || !/[\u3400-\u9fff]/.test(content))) content = progressText(String(p.kind), content)
  if (event.type === 'review.summary') content = content.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^Self-improvement review:\s*/i, '自我改进回顾：')
  if (!content) return state
  const kind = event.type === 'status.update' ? text(p.kind) || event.type : event.type
  const id = event.type === 'notification.show' && text(p.key) ? `notification-${p.key}` : `notice-${event.replayEpoch || event.epoch || ''}-${event.seq ?? randomId()}`
  const previous = state.entries.find(row => row.id === id)
  if (!previous && state.entries.at(-1)?.noticeKind === kind && state.entries.at(-1)?.text === content) return state
  const entry = nativeNotice(id, kind, content)
  return { ...state, entries: previous ? state.entries.map(row => row === previous ? entry : row) : [...state.entries, entry] }
}
