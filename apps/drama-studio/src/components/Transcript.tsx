import { useStore } from '@nanostores/react'
import { BookOpen, Check, ChevronRight, CircleAlert, Copy, FileDown, FilePen, FileText, Image as ImageIcon, ListChecks, LoaderCircle, Search, ShieldCheck, Wrench } from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react'
import { workspace } from '../store/workspace'
import type { Activity, Entry } from '../lib/transcript'
import { activityLine, visibleActivities } from '../lib/activity-summary'
import { Markdown } from './Markdown'
import { NativeTurnStatus, StatusNotice, SubagentActivity, ThinkingMarker } from './NativeActivity'
import { NextStepSuggestions } from './NextStepSuggestions'
import { GeneratedImage } from './GeneratedImage'
import { UserMessageContent } from './UserMessageContent'
import { TranscriptOutline } from './TranscriptOutline'
import { FileDownloadLink } from './FileDownloadLink'
import { ManuscriptDelivery } from './ManuscriptDelivery'
import { downloadsByEntry } from '../lib/chat-downloads'
import { availableSuggestions } from '../lib/suggestions'
import { transcriptBlocksIncremental } from '../lib/transcript-blocks'
import { latestDocumentVersions } from '../lib/document-versions'
import { episodeRange, revisedLater, roundVersions, scriptSections, type ScriptSections } from '../lib/script-sections'
import { copyText as copyTextValue } from '../lib/copy'
import './Transcript.css'

interface TranscriptEntryProps {
  entry: Entry
  parts?: Entry[]
  entering: boolean
  onReadFile?: (file: { path: string; name: string }) => void
  /** 较早轮次的正文默认收起；最新一轮的最终正文保持展开。 */
  collapseScripts?: boolean
  /** 本轮后面又重写过的集号。 */
  revisedEpisodes?: number[]
  showCopy?: boolean
}

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

const STEP_ICONS: Record<string, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  skill_view: BookOpen, skills_list: BookOpen, drama_rules_read: BookOpen, read_file: FileText, drama_material_import: FileText,
  drama_agent_document: FilePen, drama_submit: FilePen, write_file: FilePen, patch: FilePen, drama_export: FileDown,
  drama_requirements: ListChecks, drama_story_bible: ListChecks, todo: ListChecks, drama_review: ShieldCheck, drama_confirm: ShieldCheck,
  web_search: Search, web_extract: Search, session_search: Search, image_generate: ImageIcon
}

/** 一步一行：图标 + “已读取创作规则” + 对象；失败与需前置操作时在同一行后附原因（参照 Codex 的操作记录）。 */
function ActivityStep({ call }: { call: Activity }) {
  const Icon = STEP_ICONS[call.name] ?? Wrench
  const line = activityLine(call)
  return <div className="activity-step" data-state={call.state}>
    {call.state === 'running' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : call.state === 'error' || call.state === 'blocked' ? <CircleAlert size={13} aria-hidden="true" /> : <Icon size={13} aria-hidden={true} />}
    <span className="activity-step-lead">{line.lead}</span>
    {line.object && <span className="activity-step-object" title={line.object}>{line.object}</span>}
    {call.state === 'running' && <span className="activity-step-ellipsis" aria-hidden="true">…</span>}
    {line.detail && <span className="activity-step-detail" title={line.detail}>{line.detail}</span>}
  </div>
}

function ActivityGroup({ entry, entering }: { entry: Entry; entering: boolean }) {
  const calls = visibleActivities(entry.calls)
  const current = calls.find(call => call.state === 'running')
  const waiting = !current && entry.thinking ? '正在整理本次稿件…' : undefined
  const failed = calls.some(call => call.state === 'error')
  const blocked = calls.some(call => call.state === 'blocked')
  const verbs = [...new Set(calls.map(call => activityLine({ ...call, state: 'complete' }).lead.slice(1)))]
  // 摘要行用这组里第一类操作的图标（读规则是书、存稿是笔、检索是放大镜），参照 Codex 的操作记录。
  const SummaryIcon = STEP_ICONS[calls[0]?.name ?? ''] ?? Wrench
  const running = current && activityLine(current)
  const title = running
    ? `${running.lead}${running.object ? ` ${running.object}` : ''}…`
    : waiting ?? `已${verbs.slice(0, 3).join('、')}${verbs.length > 3 ? '等' : ''}`
  return <><details className={`activity-group ${current || waiting ? 'is-running' : ''} ${entering ? 'is-entering' : ''}`}>
    <summary>{current || waiting ? <LoaderCircle size={14} className="spin" /> : failed || blocked ? <CircleAlert size={14} /> : <SummaryIcon size={14} aria-hidden={true} />}
      <span className="activity-title">{title}</span>
      {calls.length > 1 && <span className="activity-count">{calls.length} 步</span>}
      {failed ? <span className="activity-failure">有步骤未完成</span> : blocked ? <span className="activity-blocked">需要前置操作</span> : null}
      <ChevronRight size={13} className="disclosure-chevron" />
    </summary>
    <div className="activity-list">{calls.map(call => <ActivityStep key={call.id} call={call} />)}</div>
  </details>{entry.calls.filter(call => call.image).map(call => <GeneratedImage key={call.id} path={call.image!} />)}</>
}

/** 只有正文已经原位更新时显示中性修改记录，初稿可展开对照。 */
function RevisionNote({ draft, pending, onReadFile }: { draft: string; pending: boolean; onReadFile?: (file: { path: string; name: string }) => void }) {
  const [open, setOpen] = useState(false)
  return <div className="revision-note">
    <div className="revision-note-line">{pending ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <FilePen size={13} aria-hidden="true" />}
      <span>{pending ? '正在调整上方正文…' : '本次已修改上方正文'}</span>
      <button type="button" className="revision-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <ChevronRight size={12} className="disclosure-chevron" aria-hidden="true" />{open ? '收起修订前的初稿' : '查看修订前的初稿'}</button>
    </div>
    {open && <section className="revision-draft" aria-label="修订前的初稿">
      <header><span className="revision-draft-tag">初稿</span><span>修改前版本，仅供对照</span></header>
      <div className="revision-draft-body"><Markdown text={draft} streaming={false} onReadFile={onReadFile} /></div>
    </section>}
  </div>
}

/** 对话里的完整剧本正文：收起时露出开头；整批被本轮后续回复重写的初稿收起时只留一行。 */
function ScriptBody({ sections, collapse, revisedEpisodes = [], onReadFile }: { sections: ScriptSections; collapse: boolean; revisedEpisodes?: number[]; onReadFile?: (file: { path: string; name: string }) => void }) {
  const overlap = revisedEpisodes.filter(number => sections.episodes.includes(number))
  const superseded = overlap.length > 0 && overlap.length === new Set(sections.episodes).size
  const [open, setOpen] = useState(!collapse && !overlap.length)
  const bodyId = useId()
  const range = episodeRange(sections.episodes)
  return <section className={`script-body ${open ? 'is-open' : 'is-collapsed'} ${superseded ? 'is-superseded' : ''}`} aria-label={`剧本正文 ${range}`}>
    <div className="script-body-bar">
      <span className="script-body-title">{superseded ? '初稿' : '正文'} · {range}</span>
      {overlap.length > 0 && <span className="script-body-revised">{superseded ? '本轮后面已整批重写' : `本轮后面重写了${episodeRange(overlap)}`}</span>}
      <button type="button" className="text-button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>{open ? '收起正文' : '展开正文'}</button>
    </div>
    <div id={bodyId} className="script-body-content"><Markdown text={sections.body} streaming={false} onReadFile={onReadFile} chat /></div>
  </section>
}

function AssistantText({ part, collapse, revisedEpisodes, onReadFile }: { part: Entry; collapse: boolean; revisedEpisodes?: number[]; onReadFile?: (file: { path: string; name: string }) => void }) {
  const sections = useMemo(() => part.pending ? null : scriptSections(part.text), [part.pending, part.text])
  if (!sections) return <Markdown text={part.text} streaming={Boolean(part.pending)} onReadFile={onReadFile} chat />
  return <>
    {sections.preamble && <Markdown text={sections.preamble} streaming={false} onReadFile={onReadFile} chat />}
    <ScriptBody sections={sections} collapse={collapse} revisedEpisodes={revisedEpisodes} onReadFile={onReadFile} />
    {sections.notes && <Markdown text={sections.notes} streaming={false} onReadFile={onReadFile} chat />}
  </>
}

function AssistantMessage({ entry, parts, onReadFile, entering, collapseScripts = false, revisedEpisodes, showCopy = false }: TranscriptEntryProps) {
  const [copiedText, setCopiedText] = useState<string>()
  const [copyError, setCopyError] = useState(false)
  const visibleText = entry.text
  const copied = copiedText === visibleText
  const copy = async () => {
    try { await copyTextValue(visibleText); setCopiedText(visibleText); setCopyError(false) }
    catch { setCopyError(true) }
  }
  return <article className={`assistant-message ${entry.pending ? 'is-pending' : ''} ${entering ? 'is-entering' : ''}`}>
    {(parts ?? [entry]).map(part => part.role === 'thinking'
      ? <ThinkingMarker key={part.id} entry={part} entering={false} />
      : <Fragment key={part.id}>
        <AssistantText part={part} collapse={collapseScripts} revisedEpisodes={revisedEpisodes} onReadFile={onReadFile} />
        {part.revision && <RevisionNote draft={part.revision.draft} pending={Boolean(part.pending)} onReadFile={onReadFile} />}
      </Fragment>)}
    {entry.pending && <span className="stream-cursor" aria-hidden="true" />}
    {showCopy && <div className="message-actions" role="group" aria-label="回复操作">
      <span className="message-action-tooltip" data-tooltip={copied ? '已复制' : '复制回复'}><button className={`icon-button ${copied ? 'is-copied' : ''}`} aria-label={copied ? '已复制回复' : '复制回复'} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></span>
      {copyError && <span role="status">复制失败，请手动选择文本。</span>}
    </div>}
  </article>
}

function UserMessage({ entry, entering }: TranscriptEntryProps) {
  return <article data-conversation-anchor={entry.id} tabIndex={-1} className={`user-message ${entering ? 'is-entering' : ''}`}><div><UserMessageContent entry={entry} /></div></article>
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
  const previousBlocks = useRef<{ entries: Entry[]; artifacts: typeof project; blocks: ReturnType<typeof transcriptBlocksIncremental> } | null>(null)
  const blocks = useMemo(() => {
    const previous = previousBlocks.current
    const next = previous && previous.artifacts === project ? transcriptBlocksIncremental(conversation.entries, previous.entries, previous.blocks, project?.artifacts)
      : transcriptBlocksIncremental(conversation.entries, [], [], project?.artifacts)
    previousBlocks.current = { entries: conversation.entries, artifacts: project, blocks: next }
    return next
  }, [conversation.entries, project])
  const documentDownloads = useMemo(() => downloadsByEntry(conversation.entries, project?.artifacts), [conversation.entries, project])
  const manuscripts = useMemo(() => {
    const byPath = new Map(latestDocumentVersions(project?.artifacts ?? []).filter(artifact => artifact.content && artifact.downloadPath && artifact.documentKind !== 'internal')
      .map(artifact => [artifact.downloadPath!, artifact]))
    return new Map([...downloadsByEntry(conversation.entries, project?.artifacts, true)].map(([entryId, files]) =>
      [entryId, latestDocumentVersions(files.flatMap(file => byPath.has(file.path) ? [byPath.get(file.path)!] : []))]))
  }, [conversation.entries, project])
  const manuscriptPaths = useMemo(() => {
    const byPath = new Set((project?.artifacts ?? []).filter(artifact => artifact.content && artifact.downloadPath).map(artifact => artifact.downloadPath!))
    return new Map([...downloadsByEntry(conversation.entries, project?.artifacts, true)].map(([entryId, files]) =>
      [entryId, files.map(file => file.path).filter(path => byPath.has(path))]))
  }, [conversation.entries, project])
  const revised = useMemo(() => revisedLater(blocks.map(({ entry }) => entry)), [blocks])
  const latestTurnId = useMemo(() => blocks.findLast(({ entry }) => entry.role === 'assistant')?.entry.turnId, [blocks])
  const turn = conversation.turn
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const readingFromOutline = useRef(false)
  useEffect(() => { follow.current = true; readingFromOutline.current = false }, [conversation.runtimeId, lastSubmissionId])
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [conversation.runtimeId, lastSubmissionId, conversation.entries, conversation.running, conversation.asyncPending, turn?.status])
  return <div className="transcript-shell"><div className="transcript-scroll" ref={scroll}
    onPointerDown={() => { readingFromOutline.current = false }}
    onWheel={() => { readingFromOutline.current = false }} onTouchStart={() => { readingFromOutline.current = false }}
    onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) readingFromOutline.current = false }}
    onScroll={() => {
    const element = scroll.current
    if (element && !readingFromOutline.current) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140
  }}>
    <div className="transcript-content" key={conversation.runtimeId}>
      <div className="conversation-origin"><span className="small-brand">巨</span>创作对话<span className="origin-line" /></div>
      {blocks.map(({ entry, sourceIds, parts }, index) => {
        const entering = conversation.running && index === blocks.length - 1
        const Component = ENTRY_COMPONENTS[entry.role]
        const nextRoundBoundary = blocks.slice(index + 1).find(next => next.entry.role === 'user' || next.entry.role === 'assistant')
        const showCopy = !conversation.running && entry.role === 'assistant' && !entry.pending
          && nextRoundBoundary?.entry.role !== 'assistant'
        const blockDownloads = sourceIds.flatMap(id => documentDownloads.get(id) ?? [])
        const blockManuscripts = sourceIds.flatMap(id => manuscripts.get(id) ?? [])
        // 具有版本关系的旧稿件已合并进最新卡片，不再重复列出文件入口。
        const supersededPaths = new Set(sourceIds.flatMap(id => manuscriptPaths.get(id) ?? []))
        // 同一稿件可能有不同下载句柄，用文档编号去重；同名的独立稿件各自保留。
        const remainingDownloads = [...new Map(blockDownloads.filter(file => !supersededPaths.has(file.path)
          && !blockManuscripts.some(artifact => artifact.downloadPath === file.path || file.documentId === artifact.id)).map(file => [file.documentId || file.path, file])).values()]
        // 将本轮导出回执放在最终助手正文之后，用户无需展开创作步骤即可下载。
        const body = <Component entry={entry} parts={parts} showCopy={showCopy} entering={entering} onReadFile={entry.role === 'assistant' ? onReadFile : undefined}
          collapseScripts={Boolean(entry.turnId) && entry.turnId !== latestTurnId} revisedEpisodes={revised.get(entry.id)} />
        const versions = roundVersions(blockManuscripts)
        return <Fragment key={entry.id}>{body}
          {remainingDownloads.length > 0 && <div className="message-documents" role="group" aria-label="本轮交付稿件">
            {remainingDownloads.map(file => <FileDownloadLink key={file.path} path={file.path} downloadName={file.name} onRead={onReadFile}>{file.name}</FileDownloadLink>)}
          </div>}
          {blockManuscripts.map(artifact => <ManuscriptDelivery key={artifact.id} artifact={artifact}
            newerVersion={versions.get(artifact.id)?.newerVersion} roundVersions={versions.get(artifact.id)?.versions}
            showDownload={blockDownloads.some(file => file.path === artifact.downloadPath)} onReadFile={onReadFile} />)}
          {suggestions && sourceIds.includes(suggestions.entryId) && <NextStepSuggestions suggestions={suggestions.suggestions}
            disabled={connection !== 'open' || draft.busy || navigation.loading || reasoning.saving}
            hasDraft={Boolean(draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length)}
            onSend={suggestion => { void workspace.sendSuggestedReply(suggestions.entryId, suggestion.prompt) }}
            onEdit={suggestion => {
              if (!workspace.editSuggestedReply(suggestions.entryId, suggestion.prompt)) return
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
  </div><TranscriptOutline key={conversation.runtimeId} blocks={blocks} scroll={scroll}
    onNavigate={() => { follow.current = false; readingFromOutline.current = true }} /></div>
}
