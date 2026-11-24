import { useStore } from '@nanostores/react'
import { ArrowLeft, LoaderCircle, UserRound } from 'lucide-react'
import { useEffect } from 'react'
import { $employeeViewer, closeEmployeeConversation, loadEmployeeConversations, refreshEmployeeConversation } from '../employee-access/api'
import { Markdown } from './Markdown'
import { GeneratedImage } from './GeneratedImage'
import { UserMessageContent } from './UserMessageContent'
import { splitSuggestions } from '../lib/suggestions'
import { transcriptBlocks } from '../lib/transcript-blocks'
import { activityLine, publicActivitySummary, visibleActivities } from '../lib/activity-summary'
import { publicText } from '../lib/transcript'
import './EmployeeConversationViewer.css'

export function EmployeeConversationViewer() {
  const viewer = useStore($employeeViewer)
  const groupId = viewer.group?.id
  const sessionId = viewer.session?.id
  useEffect(() => {
    if (!groupId || !sessionId) return
    const sync = () => { void refreshEmployeeConversation(); void loadEmployeeConversations() }
    const messages = setInterval(() => { void refreshEmployeeConversation() }, 3000)
    const groups = setInterval(() => { void loadEmployeeConversations() }, 5000)
    window.addEventListener('focus', sync)
    return () => { clearInterval(messages); clearInterval(groups); window.removeEventListener('focus', sync) }
  }, [groupId, sessionId])
  if (!viewer.group || !viewer.session) return null
  const employee = viewer.group.employee
  return <section className="employee-viewer" aria-label={`${employee.display_name}的员工对话`}>
    <header className="employee-viewer-header">
      <button className="text-button" onClick={closeEmployeeConversation}><ArrowLeft size={15} />返回员工对话</button>
      <div className="employee-viewer-title"><span className="employee-viewer-avatar"><UserRound size={14} /></span><span><strong>{employee.display_name}</strong><small>{employee.username} · {viewer.session.title || '未命名对话'}</small></span></div>
      <span className="employee-readonly">只读 · 自动同步</span>
    </header>
    {viewer.loading && <div className="employee-viewer-loading" role="status"><LoaderCircle size={19} className="account-spin" />正在同步员工对话…</div>}
    {viewer.error && <p className="employee-viewer-error" role="alert">{publicText(viewer.error, '员工对话暂时无法读取。')}</p>}
    {!viewer.loading && !viewer.error && <div className="employee-viewer-transcript">
      {!viewer.entries.length && <p className="employee-viewer-empty">这段对话暂无可显示内容。</p>}
      {/* 与员工界面同一分组：同一轮的返修稿已按集号并回初稿位置，只读视图同样只显示一份正文。 */}
      {transcriptBlocks(viewer.entries).map(({ entry }) => entry).filter(entry => entry.role !== 'thinking').map(entry => entry.role === 'assistant' ? <article key={entry.id} className="employee-viewer-assistant"><Markdown text={splitSuggestions(entry.text).text} /></article>
        : entry.role === 'user' ? <article key={entry.id} className="employee-viewer-user"><UserMessageContent entry={entry} /></article>
        : entry.role === 'activity' ? <div key={entry.id}><details className="employee-viewer-activity"><summary>创作步骤（{visibleActivities(entry.calls).length} 步）</summary>{visibleActivities(entry.calls).map(call => { const line = activityLine({ ...call, resultSummary: call.resultSummary && publicActivitySummary(call.resultSummary, call.state === 'error' ? '操作未完成，请稍后重试。' : '操作已返回') }); return <p key={call.id}>{line.lead}{line.object ? ` ${line.object}` : ''}{line.detail ? ` · ${line.detail}` : ''}</p> })}</details>{entry.calls.filter(call => call.image).map(call => <GeneratedImage key={call.id} path={call.image!} />)}</div>
        : entry.text ? <p key={entry.id} className="employee-viewer-notice">{entry.text}</p> : null)}
    </div>}
  </section>
}
