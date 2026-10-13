import { activityLabel, argumentSummary, blockedResult, failedResult, resultSummary } from './activity-summary'

export interface ProgressStep { id: string; text: string; at: number; state?: 'running' | 'complete' | 'error' | 'blocked' | 'interrupted' | 'unknown' }
export interface TurnProgress {
  startedAt?: number
  endedAt?: number
  timingSource: 'server' | 'local' | 'unknown'
  state: 'running' | 'complete' | 'error' | 'interrupted' | 'unknown'
  phase?: 'preparing' | 'model' | 'tools' | 'writing'
  status?: string
  lastEventAt?: number
  steps?: ProgressStep[]
  stopRequested?: boolean
  transportInterrupted?: boolean
}
export interface ProgressEvent { type: string; payload: Record<string, unknown>; replayed?: boolean }
export interface TurnSnapshot { running?: boolean | null; turn_started_at?: number | null; info?: { running?: boolean; turn_started_at?: number | null } }

export function beginTurn(now = Date.now()): TurnProgress {
  return { startedAt: now, timingSource: 'local', state: 'running', phase: 'preparing', status: '正在准备创作', lastEventAt: now, steps: [] }
}
const epochMilliseconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined

export function restoreTurn(snapshot: TurnSnapshot): TurnProgress | undefined {
  if (!(snapshot.running ?? snapshot.info?.running)) return undefined
  const startedAt = epochMilliseconds(snapshot.turn_started_at ?? snapshot.info?.turn_started_at)
  return { startedAt, timingSource: startedAt === undefined ? 'unknown' : 'server', state: 'running', phase: 'model', status: '正在恢复本轮创作进度', steps: [] }
}

const PHASE_COPY: Record<string, string> = {
  preparing: '正在准备创作', thinking: '正在分析与规划', generating: '正在生成内容',
  compacting: '正在整理上下文', compressing: '正在整理上下文', compacted: '上下文整理完成',
  ready: '创作服务已就绪', retrying: '正在重试模型请求', waiting: '正在等待模型返回',
  process: '后台任务进度已更新', goal: '创作目标进度已更新', loop: '正在继续创作流程'
}
const ENGLISH_PROGRESS: [RegExp, string][] = [
  [/prepar.*(?:resend|retry)/i, '正在准备重新提交资料'],
  [/condens|summariz|compress|compact/i, '正在整理并精简上下文'],
  [/prepar.*(?:episode|draft)/i, '正在准备分集草稿'],
  [/check.*(?:tool|data).*support/i, '正在核对工具和数据支持'],
  [/check.*(?:source|integrity|unicode)/i, '正在核对原稿与内容完整性'],
  [/read.*(?:file|source|project|data)/i, '正在阅读创作资料'],
  [/delegat|subagent/i, '正在安排独立创作任务'],
  [/review|audit/i, '正在审核创作结果'],
  [/retry|backoff/i, '正在等待并重试模型请求'],
  [/wait|connect/i, '正在等待模型返回']
]

const cleanStatus = (value: unknown) => typeof value === 'string' ? value.replace(/\u001b\[[0-9;]*m/g, '').replace(/^[^\p{L}\p{N}\u3400-\u9fff]*[)）]\s*/u, '').replace(/\p{Extended_Pictographic}[\uFE0F\u200D]*/gu, '').trim() : ''
// thinking.delta 同时承载旧等待动画和重试提示，只识别有实际含义的状态。
function thinkingNotice(value: unknown): string | undefined {
  const text = cleanStatus(value)
  if (/重试|retry|backoff/i.test(text)) return '正在重试模型请求'
  if (/压缩|精简上下文|整理上下文|compress|compact|summariz/i.test(text)) return '正在整理上下文'
  if (/等待|连接|wait|connect/i.test(text)) return '正在等待模型返回'
  return ENGLISH_PROGRESS.find(([pattern]) => pattern.test(text))?.[1]
}

/** 公开进度提示按实际语义转为中文；未识别的英文不伪装成具体创作步骤。 */
export function progressText(kind: string, value: unknown): string {
  const text = cleanStatus(value)
  if (/[\u3400-\u9fff]/.test(text)) return text.slice(0, 300)
  return ENGLISH_PROGRESS.find(([pattern]) => pattern.test(text))?.[1] ?? PHASE_COPY[kind] ?? '正在等待新的创作进度'
}

function note(turn: TurnProgress, text: string, now: number, phase = turn.phase): TurnProgress {
  const previous = turn.steps ?? []
  const changed = previous.at(-1)?.text !== text
  if (!changed && turn.phase === phase && now - (turn.lastEventAt ?? 0) < 1000) return turn
  return { ...turn, phase, status: text, lastEventAt: now,
    steps: changed ? [...previous, { id: `${now}-${previous.length}`, text, at: now }] : previous }
}
function signal(turn: TurnProgress, text: string, now: number, phase = turn.phase): TurnProgress {
  if (turn.status === text && turn.phase === phase && now - (turn.lastEventAt ?? 0) < 1000) return turn
  return { ...turn, phase, status: text, lastEventAt: now }
}

function toolStep(turn: TurnProgress | undefined, event: ProgressEvent, now: number): TurnProgress | undefined {
  if (!turn || turn.state !== 'running') return turn
  const p = event.payload, id = `tool:${String(p.tool_id)}`
  const previous = turn.steps ?? [], existing = previous.find(step => step.id === id)
  const name = String(p.name ?? ''), label = activityLabel(name)
  const done = event.type === 'tool.complete', failed = done && failedResult(p.result ?? p.result_text)
  if (existing && !done) return turn
  const args = argumentSummary(name, p.args, p.context)
  const detail = done ? resultSummary(p.result ?? p.result_text, p.summary) : args
  const text = `${label}${detail && detail !== label ? ` · ${detail}` : ''}`
  const blocked = done && blockedResult(p.result ?? p.result_text)
  const step: ProgressStep = { id, text, at: existing?.at ?? now, state: done ? blocked ? 'blocked' : failed ? 'error' : 'complete' : 'running' }
  const steps = existing ? previous.map(row => row.id === id ? step : row) : [...previous, step]
  const current = steps.findLast(row => row.state === 'running')
  return { ...turn, steps, lastEventAt: now, phase: current ? 'tools' : 'model', status: current ? `正在${current.text}` : `${label}${blocked ? '需要前置操作' : failed ? '未完成' : '已返回'}，正在分析结果` }
}
const settleSteps = (turn: TurnProgress, interrupted: boolean): ProgressStep[] | undefined => turn.steps?.map(step =>
  step.state === 'running' ? { ...step, state: interrupted ? 'interrupted' : 'unknown' } : step)
const active = (turn: TurnProgress | undefined, event: ProgressEvent, now: number): TurnProgress =>
  turn?.state === 'running' ? turn : event.replayed ? { timingSource: 'unknown', state: 'running', steps: [] } : beginTurn(now)

type Handler = (turn: TurnProgress | undefined, event: ProgressEvent, now: number) => TurnProgress | undefined
const modelSignal: Handler = (turn, _event, now) => {
  if (!turn || turn.state !== 'running' || turn.phase === 'tools') return turn
  // 仅记录模型正在响应这一事实，内部推理文本不进入页面状态或日志。
  return signal(turn, '正在分析与规划', now, 'model')
}
const handlers: Record<string, Handler> = {
  'message.start': (turn, event, now) => note(active(turn, event, now), '正在等待模型返回', now, 'model'),
  'message.delta': (turn, event, now) => signal(active(turn, event, now), '正在输出内容', now, 'writing'),
  'message.interim': (turn, event, now) => note(active(turn, event, now), progressText('thinking', event.payload.text), now, 'model'),
  'tool.start': toolStep,
  'tool.complete': toolStep,
  'tool.generating': (turn, event, now) => turn?.state === 'running' ? signal(turn, `正在准备${activityLabel(String(event.payload.name))}`, now, 'model') : turn,
  'reasoning.delta': modelSignal,
  'reasoning.available': modelSignal,
  'thinking.delta': (turn, event, now) => {
    if (turn?.state !== 'running' || turn.phase === 'tools') return turn
    const text = thinkingNotice(event.payload.text)
    return text ? note(turn, text, now, 'model') : signal(turn, turn.phase === 'writing' ? '正在输出内容' : '模型正在处理请求', now, turn.phase)
  },
  'status.update': (turn, event, now) => {
    if (turn?.state !== 'running') return turn
    const kind = String(event.payload.kind)
    return kind === 'thinking' ? modelSignal(turn, event, now) : note(turn, progressText(kind, event.payload.text), now)
  },
  'todo.updated': (turn, event, now) => {
    if (!turn || !Array.isArray(event.payload.todos)) return turn
    return note(turn, `创作计划已更新，共 ${event.payload.todos.length} 项`, now)
  },
  'subagent.start': (turn, event, now) => turn?.state === 'running' ? note(turn, `独立任务已启动：${progressText('thinking', event.payload.goal)}`, now) : turn,
  'subagent.progress': (turn, _event, now) => turn?.state === 'running' ? note(turn, '独立任务正在执行', now) : turn,
  'subagent.complete': (turn, _event, now) => {
    if (!turn || turn.state !== 'running') return turn
    return note(turn, '正在继续处理本轮请求', now)
  },
  'session.info': (turn, event, now) => {
    if (event.payload.running === true) {
      const startedAt = epochMilliseconds(event.payload.turn_started_at)
      const current = active(turn, event, now)
      return { ...current, ...(startedAt === undefined ? {} : { startedAt, timingSource: 'server' as const }), transportInterrupted: false }
    }
    if (event.payload.running === false && turn?.state === 'running' && turn.phase !== 'preparing') {
      return { ...turn, state: 'unknown', endedAt: undefined, steps: settleSteps(turn, false), status: '本轮已结束，完成状态待核对' }
    }
    return turn
  },
  'message.complete': (turn, event, now) => {
    if (!turn) return undefined
    const state = event.payload.status === 'error' ? 'error' : event.payload.status === 'interrupted' ? 'interrupted' : 'complete'
    return { ...turn, state, steps: settleSteps(turn, state !== 'complete'), endedAt: event.replayed || turn.transportInterrupted ? undefined : now,
      status: state === 'complete' ? '本轮创作已完成' : state === 'interrupted' ? '本轮创作已中断' : '本轮创作未完成', lastEventAt: now }
  },
  error: (turn, event, now) => turn ? { ...turn, state: 'error', steps: settleSteps(turn, true), endedAt: event.replayed || turn.transportInterrupted ? undefined : now, status: '创作服务返回错误', lastEventAt: now } : undefined
}

export function progressEvent(turn: TurnProgress | undefined, event: ProgressEvent, now = Date.now()): TurnProgress | undefined {
  return handlers[event.type]?.(turn, event, now) ?? turn
}
