import { useStore } from '@nanostores/react'
import { Check, ChevronRight, CircleAlert, Copy, LoaderCircle, Terminal } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { workspace } from '../store/workspace'
import type { Activity, Entry } from '../lib/transcript'
import { Markdown } from './Markdown'
import { NativeTurnStatus, StatusNotice, SubagentActivity, ThinkingMarker } from './NativeActivity'
import { NextStepSuggestions } from './NextStepSuggestions'
import { GeneratedImage } from './GeneratedImage'
import { UserMessageContent } from './UserMessageContent'
import { FileDownloadLink } from './FileDownloadLink'
import { ManuscriptDelivery } from './ManuscriptDelivery'
import { downloadsByEntry } from '../lib/chat-downloads'
import { availableSuggestions, splitSuggestions } from '../lib/suggestions'
import './Transcript.css'

const ACTIVITY_STATES: Record<Activity['state'], string> = {
  running: '进行中', complete: '已完成', error: '工具失败', blocked: '需前置操作', interrupted: '已中断', unknown: '已记录'
}

interface TranscriptEntryProps { entry: Entry; entering: boolean; onReadFile?: (file: { path: string; name: string }) => void }

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Clipboard API can be unavailable or denied in HTTP and embedded contexts.
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  const copied = document.execCommand?.('copy') === true
  textarea.remove()
  if (!copied) throw new Error('无法复制')
}

function ActivityStep({ call, index }: { call: Activity; index: number }) {
  return <section className="activity-item" data-state={call.state} aria-label={`第 ${index + 1} 步：${call.label}`}>
    <div className="activity-step-heading"><span className="activity-step-number">{index + 1}</span><Terminal size={13} aria-hidden="true" /><span>{call.label}</span><span className="activity-state">{ACTIVITY_STATES[call.state]}</span></div>
    {call.argumentSummary && <p className="activity-step-summary"><span>操作内容</span>{call.argumentSummary}</p>}
    {call.resultSummary && <p className="activity-step-summary"><span>执行结果</span>{call.resultSummary}</p>}
    {!call.resultSummary && call.state === 'running' && <p className="activity-step-summary">正在执行，结果返回后会显示在这里。</p>}
  </section>
}

function ActivityGroup({ entry, entering }: { entry: Entry; entering: boolean }) {
  const running = entry.calls.some(call => call.state === 'running')
  const failed = entry.calls.some(call => call.state === 'error')
  const blocked = entry.calls.some(call => call.state === 'blocked')
  const incomplete = entry.calls.some(call => call.state === 'unknown' || call.state === 'interrupted')
  const labels = [...new Set(entry.calls.map(call => ['skill_view', 'skills_list'].includes(call.name) && call.resultSummary?.startsWith('技能') ? call.resultSummary : call.label))]
  const title = running ? entry.calls.find(call => call.state === 'running')?.label : `${labels.slice(0, 2).join('、')}${labels.length > 2 ? '等' : ''}`
  return <><details className={`activity-group ${running ? 'is-running' : ''} ${entering ? 'is-entering' : ''}`}>
    <summary>{running ? <LoaderCircle size={14} className="spin" /> : failed || blocked ? <CircleAlert size={14} /> : incomplete ? <Terminal size={14} /> : <Check size={14} />}
      <span className="activity-title">{title}</span><span className="activity-count">{entry.calls.length} 个工具</span>
      {failed ? <span className="activity-failure">有工具失败</span> : blocked ? <span className="activity-blocked">需要前置操作</span> : null}
      <ChevronRight size={13} className="disclosure-chevron" />
    </summary>
    <div className="activity-list">{entry.calls.map((call, index) => <ActivityStep key={call.id} call={call} index={index} />)}</div>
  </details>{entry.calls.filter(call => call.image).map(call => <GeneratedImage key={call.id} path={call.image!} />)}</>
}

function AssistantMessage({ entry, onReadFile, entering }: TranscriptEntryProps) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const visibleText = useMemo(() => splitSuggestions(entry.text, Boolean(entry.pending)).text, [entry.text, entry.pending])
  const copy = async () => {
    try { await copyText(visibleText); setCopied(true); setCopyError(false) }
    catch { setCopyError(true) }
  }
  return <article className={`assistant-message ${entry.pending ? 'is-pending' : ''} ${entering ? 'is-entering' : ''}`}>
    <Markdown text={visibleText} streaming={Boolean(entry.pending)} onReadFile={onReadFile} />
    {entry.pending && <span className="stream-cursor" aria-hidden="true" />}
    {!entry.pending && <div className="message-actions" role="group" aria-label="回复操作">
      <span className="message-action-tooltip" data-tooltip={copied ? '已复制' : '复制回复'}><button className={`icon-button ${copied ? 'is-copied' : ''}`} aria-label={copied ? '已复制回复' : '复制回复'} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></span>
      {copyError && <span role="status">复制失败，请手动选择文本。</span>}
    </div>}
  </article>
}

function UserMessage({ entry, entering }: TranscriptEntryProps) {
  return <article className={`user-message ${entering ? 'is-entering' : ''}`}><div><UserMessageContent entry={entry} /></div></article>
}

const ENTRY_COMPONENTS: Record<Entry['role'], ComponentType<TranscriptEntryProps>> = {
  user: UserMessage, assistant: AssistantMessage, activity: ActivityGroup,
  thinking: ThinkingMarker, status: StatusNotice, subagent: SubagentActivity
}

export function Transcript({ onReadFile }: { onInspect?: (entry: Entry) => void; onReadFile?: (file: { path: string; name: string }) => void }) {
  const conversation = useStore(workspace.conversation)
  const project = useStore(workspace.project)
  const lastSubmissionId = useStore(workspace.lastSubmissionId)
  const requests = useStore(workspace.requests)
  const connection = useStore(workspace.connection)
  const draft = useStore(workspace.composer)
  const navigation = useStore(workspace.navigation)
  const reasoning = useStore(workspace.reasoning)
  const waiting = requests.some(request => request.params.session_id === conversation.runtimeId)
  const suggestions = useMemo(() => waiting ? null : availableSuggestions(conversation), [conversation, waiting])
  const documentDownloads = useMemo(() => downloadsByEntry(conversation.entries, project?.artifacts), [conversation.entries, project])
  const manuscripts = useMemo(() => {
    const byPath = new Map((project?.artifacts ?? []).filter(artifact => artifact.content && artifact.downloadPath && artifact.documentKind !== 'internal')
      .map(artifact => [artifact.downloadPath!, artifact]))
    return new Map([...downloadsByEntry(conversation.entries, project?.artifacts, true)].map(([entryId, files]) =>
      [entryId, files.flatMap(file => byPath.has(file.path) ? [byPath.get(file.path)!] : [])]))
  }, [conversation.entries, project])
  const turn = conversation.turn
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => { follow.current = true }, [conversation.runtimeId, lastSubmissionId])
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [conversation.runtimeId, lastSubmissionId, conversation.entries, conversation.running, conversation.asyncPending, turn?.status])
  return <div className="transcript-scroll" ref={scroll} onScroll={() => {
    const element = scroll.current
    if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140
  }}>
    <div className="transcript-content" key={conversation.runtimeId}>
      <div className="conversation-origin"><span className="small-brand">巨</span>创作对话<span className="origin-line" /></div>
      {conversation.entries.map((entry, index) => {
        const entering = conversation.running && index === conversation.entries.length - 1
        const Component = ENTRY_COMPONENTS[entry.role]
        const remainingDownloads = documentDownloads.get(entry.id)?.filter(file => !manuscripts.get(entry.id)?.some(artifact => artifact.downloadPath === file.path)) ?? []
        // 将本轮导出回执放在最终助手正文之后，用户无需展开创作步骤即可下载。
        return <Fragment key={entry.id}><Component entry={entry} entering={entering} onReadFile={entry.role === 'assistant' ? onReadFile : undefined} />
          {remainingDownloads.length > 0 && <div className="message-documents" role="group" aria-label="本轮交付稿件">
            {remainingDownloads.map(file => <FileDownloadLink key={file.path} path={file.path} downloadName={file.name} onRead={onReadFile}>{file.name}</FileDownloadLink>)}
          </div>}
          {manuscripts.get(entry.id)?.map(artifact => <ManuscriptDelivery key={artifact.id} artifact={artifact}
            showDownload={Boolean(documentDownloads.get(entry.id)?.some(file => file.path === artifact.downloadPath))} onReadFile={onReadFile} />)}
          {suggestions?.entryId === entry.id && <NextStepSuggestions suggestions={suggestions.suggestions}
            disabled={connection !== 'open' || draft.busy || navigation.loading || reasoning.saving}
            hasDraft={Boolean(draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length)}
            onSend={suggestion => { void workspace.sendSuggestedReply(entry.id, suggestion.prompt) }}
            onEdit={suggestion => {
              if (!workspace.editSuggestedReply(entry.id, suggestion.prompt)) return
              const runtimeId = conversation.runtimeId
              requestAnimationFrame(() => {
                if (workspace.conversation.get().runtimeId !== runtimeId) return
                const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="给巨豹智能体发送消息"]')
                input?.focus(); input?.setSelectionRange(input.value.length, input.value.length)
              })
            }} />}
        </Fragment>
      })}
      <NativeTurnStatus conversation={conversation} waiting={waiting} disconnected={connection !== 'open'} />
    </div>
  </div>
}
