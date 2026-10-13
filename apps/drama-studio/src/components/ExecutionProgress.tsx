import { Check, ChevronRight, CircleAlert, Clock3, Pause, Square, WifiOff } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProgressStep } from '../lib/progress'
import './ExecutionProgress.css'

export interface ExecutionProgressProps {
  status: 'running' | 'waiting' | 'complete' | 'stopped' | 'error' | 'interrupted' | 'unknown' | 'disconnected'
  startedAt?: number
  finishedAt?: number
  currentStep?: string
  timingSource?: 'server' | 'local' | 'unknown'
  lastEventAt?: number
  steps?: ProgressStep[]
}

const STATUS_LABELS: Record<ExecutionProgressProps['status'], string> = {
  running: '正在创作', waiting: '等待你的创作确认', complete: '本轮已完成',
  stopped: '本轮已停止', error: '本轮执行中断', interrupted: '本轮已中断',
  unknown: '本轮状态待同步', disconnected: '连接中断，进度待同步'
}

const STATUS_ICONS = { waiting: Pause, complete: Check, stopped: Square, error: CircleAlert, interrupted: CircleAlert, unknown: CircleAlert, disconnected: WifiOff }

const timeText = (timestamp: number) => new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`
}

export function ExecutionProgress({ status, startedAt, finishedAt, currentStep, timingSource, steps, lastEventAt }: ExecutionProgressProps) {
  const [now, setNow] = useState(Date.now)
  const active = status === 'running' || status === 'waiting' || status === 'disconnected'
  const [expanded, setExpanded] = useState(active)
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => { setExpanded(active); follow.current = true }, [active, startedAt])
  useLayoutEffect(() => {
    if (expanded && follow.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [steps, expanded])
  useEffect(() => {
    if (!active || startedAt === undefined) return
    const update = () => setNow(Date.now())
    update()
    const timer = window.setInterval(update, 1000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [active, startedAt])
  const end = active ? now : finishedAt
  const hasTiming = startedAt !== undefined && Number.isFinite(startedAt) && end !== undefined && Number.isFinite(end)
  const Icon = status === 'running' ? null : STATUS_ICONS[status]
  return <div className="execution-progress" data-state={status}>
    <div className="execution-heading">
      <span className="execution-status" role="status">
        {Icon ? <Icon size={13} aria-hidden="true" /> : <span className="thinking-dots" aria-hidden="true"><span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" /></span>}
        {STATUS_LABELS[status]}
      </span>
      {hasTiming ? <span className="execution-clock"><Clock3 size={12} aria-hidden="true" /><span role="timer" aria-live="off">{active ? '本轮已用' : '本轮用时'} {elapsedText(end - startedAt)}</span></span> : <span className="execution-clock">{startedAt === undefined ? '本轮起始时间未记录' : '结束时间未记录'}</span>}
    </div>
    {currentStep && status === 'running' && <p className="execution-current-step">当前：{currentStep}</p>}
    <p className="execution-timing-note">{status === 'disconnected' ? '经过时间仍会继续，后台执行状态以恢复后的回执为准。' : timingSource === 'local' ? '从本页发起或收到执行事件时计时，包含生成和等待。' : '整轮用时包含生成、工具执行和等待确认。'}</p>
    {steps && steps.length > 0 && <details className="execution-steps" open={expanded}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => !value) }}><ChevronRight size={12} className="disclosure-chevron" /><span>思考与执行进度 · {steps.length} 条</span>{lastEventAt !== undefined && <span className="execution-last-event">最近 {timeText(lastEventAt)}</span>}</summary>
      <div ref={log} className="execution-log" role="log" aria-label="思考与执行进度" aria-live={active ? 'polite' : 'off'} aria-relevant="additions text" tabIndex={0} onScroll={() => {
        const element = log.current
        if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
      }}><ol>{steps.map(step => <li key={step.id} data-state={step.state}><time dateTime={new Date(step.at).toISOString()}>{timeText(step.at)}</time><span>{step.text}</span>{step.state && <small>{({ running: '执行中', complete: '已完成', error: '未完成', blocked: '需前置操作', interrupted: '已中断', unknown: '结果未记录' })[step.state]}</small>}</li>)}</ol></div>
    </details>}
  </div>
}
