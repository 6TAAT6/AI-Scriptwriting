import { useStore } from '@nanostores/react'
import { workspace } from '../store/workspace'
import { Check, ChevronRight, CircleAlert, Clock3, GitBranch, LoaderCircle, Pause, RefreshCw, Sparkles, Square, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Conversation, Entry } from '../lib/transcript'
import { modelDisplayName } from '../lib/model-options'
import { activityLabel } from '../lib/activity-summary'
import './NativeActivity.css'

interface EntryProps { entry: Entry; entering: boolean }

function elapsedText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return `${whole} 秒`
  const minutes = Math.floor(whole / 60)
  return minutes < 60 ? `${minutes} 分 ${whole % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function useElapsed(active: boolean, startedAt?: number, elapsed?: number): number | undefined {
  const [now, setNow] = useState(Date.now)
  const timed = startedAt !== undefined && Number.isFinite(startedAt)
  useEffect(() => {
    if (!active || !timed) return
    const update = () => setNow(Date.now())
    update()
    const timer = window.setInterval(update, 1000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [active, timed, startedAt])
  if (active && timed) return Math.max(elapsed ?? 0, (now - startedAt) / 1000)
  return elapsed
}

// 只在模型正在思考时显示一行“思考中”和三个轻点；思考结束的标记不留在对话里（与刷新后的历史视图一致）。
export function ThinkingMarker({ entry, entering }: EntryProps) {
  if (!entry.pending) return null
  return <div className={`native-thinking ${entering ? 'is-entering' : ''}`} role="status">
    <span className="thinking-dots" aria-hidden="true"><span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" /></span>
    <span>思考中</span>
  </div>
}

export function StatusNotice({ entry, entering }: EntryProps) {
  const reflection = entry.noticeKind === 'review.summary'
  const text = reflection ? entry.text.replace(/^自我改进回顾[：:]\s*/, '') : entry.text
  return <div className={`native-notice ${reflection ? 'is-reflection' : ''} ${entering ? 'is-entering' : ''}`} role="status">
    {reflection ? <Sparkles size={12} aria-hidden="true" /> : null}
    <span>{reflection ? <span className="native-notice-label">自我改进回顾：</span> : null}{text}</span>
  </div>
}

export function SubagentActivity({ entry, entering }: EntryProps) {
  const catalog = useStore(workspace.models)
  const agent = entry.subagent
  const active = !agent?.retired && agent?.status === 'running'
  const elapsed = useElapsed(active, agent?.startedAt, agent?.elapsed)
  if (!agent || agent.retired || !['queued', 'running'].includes(agent.status)) return null
  return <article className={`native-subagent ${entering ? 'is-entering' : ''}`} aria-label={`子代理：${agent.goal}`} data-state={agent.status}>
    <div className="native-subagent-heading"><GitBranch size={13} aria-hidden="true" /><span>子代理</span>
      <span className="native-subagent-state">{active ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : null}{active ? '进行中' : '等待开始'}</span>
    </div>
    <p className="native-subagent-goal">{agent.goal || '独立创作任务'}</p>
    <div className="native-subagent-meta">
      {agent.model ? <span>{modelDisplayName(agent.model, 'text', catalog)}</span> : null}
      {agent.toolCount !== undefined ? <span>{agent.toolCount} 次工具调用</span> : null}
      {elapsed !== undefined ? <span className="native-subagent-clock"><Clock3 size={10} aria-hidden="true" /><span role="timer" aria-live="off">{elapsedText(elapsed)}</span></span> : null}
    </div>
    {agent.lastTool ? <p className="native-subagent-tool">最近工具：{activityLabel(agent.lastTool)}</p> : null}
    {agent.preview ? <details className="native-subagent-preview"><summary><ChevronRight size={12} className="disclosure-chevron" aria-hidden="true" />{active ? '查看当前进展' : '查看任务结果'}</summary><p>{agent.preview}</p></details> : null}
  </article>
}

interface TurnStatusProps { conversation: Conversation; waiting: boolean; disconnected: boolean }
const TURN_STATES = {
  running: '正在处理请求', waiting: '等待你的创作确认', complete: '本轮已完成', stopped: '本轮已停止',
  error: '本轮执行中断', interrupted: '本轮已中断', unknown: '本轮状态待同步', disconnected: '连接中断，进度待同步'
}
const TURN_ICONS = { running: LoaderCircle, waiting: Pause, complete: Check, stopped: Square, error: CircleAlert, interrupted: CircleAlert, unknown: CircleAlert, disconnected: WifiOff }

export function NativeTurnStatus({ conversation, waiting, disconnected }: TurnStatusProps) {
  const { turn, running } = conversation
  const settled = turn?.state === 'interrupted' && turn.stopRequested ? 'stopped' : turn?.state
  const status = running && disconnected ? 'disconnected' : waiting && running ? 'waiting' : settled ?? 'running'
  const duration = turn?.startedAt !== undefined && turn.endedAt !== undefined ? (turn.endedAt - turn.startedAt) / 1000 : undefined
  const elapsed = useElapsed(running, turn?.startedAt, duration)
  const background = !running && (conversation.asyncPending ?? 0) > 0
  const Icon = TURN_ICONS[status]
  return <>
    {(running || turn) && <div className="native-turn-status" data-state={status}>
      <span role="status"><Icon size={12} className={status === 'running' ? 'spin' : undefined} aria-hidden="true" />{status === 'running' ? turn?.status || TURN_STATES.running : TURN_STATES[status]}</span>
      {elapsed !== undefined ? <span className="native-turn-clock" role="timer" aria-live="off">{running ? '本轮已用' : '用时'} {elapsedText(elapsed)}</span> : null}
    </div>}
    {background && <div className="native-background" role="status"><RefreshCw size={12} aria-hidden="true" /><span>后台任务完成后将自动继续</span></div>}
  </>
}
