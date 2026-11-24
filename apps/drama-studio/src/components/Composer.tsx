import { useStore } from '@nanostores/react'
import { ArrowUp, BrainCircuit, Check, Layers, LoaderCircle, Paperclip, SlidersHorizontal, Square, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { DIALOGUE_LANGUAGES } from '../lib/creative'
import { attachmentBlockReason } from '../lib/attachments'
import { modelReasoning, reasoningLabel } from '../lib/reasoning'
import { workspace } from '../store/workspace'
import { SelectMenu } from './SelectMenu'
import { ATTACHMENT_ACCEPT, isImageFile } from '../../shared/attachments.mjs'
import { SourceImage } from './SourceImage'
import { creationModelOptions, modelDisplayName } from '../lib/model-options'
import { AttachmentLabel } from './AttachmentLabel'
import { CapabilityTag } from './CapabilityTag'
import { publicError } from '../../shared/public-errors.mjs'
import { CAPABILITIES, SELECTABLE_CAPABILITIES, conversationSelection, selectionAfter, composerCapabilityDraft, type Capability } from '../lib/capabilities'

const capabilityEnvironments = [...new Set(CAPABILITIES.flatMap(row => row.environment_badge ? [row.environment_badge] : []))]
const capabilityGroups = [
  { kind: 'agent', title: '巨豹 Agent', hint: '同一对话建议固定使用。' },
  { kind: 'skill', title: '巨豹 skill', hint: '可单独使用或叠加，持续生效。' },
]

/** 欢迎页发出第一条消息时记下输入框位置；对话出现后底部输入区从该位置滑下，给对话让出位置。 */
let welcomeLaunch: { top: number; at: number } | null = null

export function Composer() {
  const draft = useStore(workspace.composer)
  const conversation = useStore(workspace.conversation)
  const connection = useStore(workspace.connection)
  const session = useStore(workspace.session)
  const catalog = useStore(workspace.models)
  const reasoning = useStore(workspace.reasoning)
  const modelSwitch = useStore(workspace.modelSwitch)
  const preferenceError = useStore(workspace.preferenceError)
  const navigation = useStore(workspace.navigation)
  const startup = useStore(workspace.startup)
  const preparing = useStore(workspace.preparing)
  const fileInput = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const agentMenuId = useId()
  const [settings, setSettings] = useState(false)
  const [slashActive, setSlashActive] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [sentAt, setSentAt] = useState(0)
  const region = useRef<HTMLDivElement>(null)
  const markLaunch = () => {
    const element = region.current
    if (element?.closest('.welcome')) welcomeLaunch = { top: element.getBoundingClientRect().top, at: Date.now() }
  }
  useLayoutEffect(() => {
    const dock = region.current?.closest<HTMLElement>('.conversation-dock'), launch = welcomeLaunch
    if (!dock || !region.current || !launch || Date.now() - launch.at > 6000) return
    welcomeLaunch = null
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const distance = launch.top - region.current.getBoundingClientRect().top
    if (Math.abs(distance) < 4) return
    dock.animate?.([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], { duration: 700, easing: 'cubic-bezier(.22, 1.12, .36, 1)' })
  }, [])
  const [slashPosition, setSlashPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; ready: boolean }>({ left: 0, bottom: 0, maxHeight: 330, ready: false })
  // 技能选择独立于正文，旧草稿中的调用前缀在读取时兼容。
  const draftParts = composerCapabilityDraft(draft.text, draft.capabilityCommands)
  const inputText = draftParts.body
  const activeSelection = conversationSelection(conversation.entries)
  const nextSelection = selectionAfter(activeSelection, draft.text, draftParts.commands)
  const isSelected = (row: Capability) => row.id === nextSelection.agent || nextSelection.skills.includes(row.id)
  const selectedCapabilities = CAPABILITIES.filter(isSelected)
  const selectionLocked = conversation.running || Boolean(conversation.asyncPending) || draft.busy || navigation.loading || preparing
  useEffect(() => { setAgentMenuOpen(false) }, [session.runtimeId])
  useLayoutEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = `${Math.min(220, Math.max(72, input.current.scrollHeight))}px`
  }, [draft.text, selectedCapabilities.length])
  let modelInfo = session.info, modelSelectionError = ''
  try { modelInfo = workspace.modelSelection() }
  catch (error) { modelSelectionError = error instanceof Error ? error.message : '请选择可用的创作模型。' }
  const currentModel = modelInfo.model || ''
  const requestedProvider = modelInfo.provider
  const currentProvider = catalog.providers.find(provider => provider.slug === requestedProvider || provider.aliases?.includes(requestedProvider || ''))?.slug || requestedProvider
  const modelOptions = creationModelOptions(catalog)
  const selectedModel = modelOptions.find(option => draft.imageModel ? option.kind === 'image' && option.model === draft.imageModel.model && option.provider === draft.imageModel.provider : option.kind === 'text' && option.model === currentModel && (!currentProvider || option.provider === currentProvider))
  const modelPlaceholder = selectedModel?.label || (currentModel ? (modelInfo as typeof modelInfo & { model_display_name?: string }).model_display_name || modelDisplayName(currentModel, draft.imageModel ? 'image' : 'text', catalog) : '等待模型连接')
  const reasoningOptions = modelReasoning(catalog, modelInfo)
  const actualEffort = session.info.reasoning_effort_wire
  const requestedEffort = modelInfo.reasoning_effort || reasoningOptions.defaultEffort || ''
  const reasoningHint = !reasoningOptions.options.length ? (reasoningOptions.supported === false ? '当前模型不支持调节思考强度。' : '当前模型尚未声明可调节的思考档位。') :
    conversation.running ? '本轮完成后可调整，下一轮生效。' : '只影响本段对话，下一轮创作生效。'
  const preparation = startup.history ? '正在连接创作服务，可以先输入创作需求。' : startup.models ? '正在加载可用模型，可以先输入创作需求。' : preparing ? '正在同步最新进度，可以继续输入。' : ''
  const needsVerification = conversation.turn?.state === 'unknown'
  const composerHint = preparation || (needsVerification ? '本轮状态待核对，请重新打开这段对话后继续。' : conversation.running ? '正在创作，你可以随时停止' : '')
  const modelDisabledReason = !modelOptions.length ? (startup.models ? '正在加载可用模型，请稍后。' : '当前没有可用的创作模型。') :
    conversation.running ? '本轮结束或停止后可切换模型。' :
      needsVerification ? '本轮状态待核对，请重新打开这段对话后继续。' :
        preparing ? '正在同步创作服务，请稍后。' : navigation.loading ? '正在切换对话，请稍后。' :
          draft.busy ? '当前创作正在处理，请稍后。' : modelSwitch.saving ? '正在切换模型，请稍后。' :
            reasoning.saving ? '正在保存思考强度，请稍后。' :
              Boolean(session.runtimeId) && connection !== 'open' ? '连接创作服务后才能切换模型。' : '选择当前对话使用的模型，切换后下一轮生效。'
  const reasoningDisabledReason = modelSelectionError ? '请先选择可用的创作模型，再调整思考强度。' : !reasoningOptions.options.length ? reasoningHint :
    conversation.running ? '本轮完成后可调整，下一轮生效。' :
      preparing ? '正在同步创作服务，请稍后。' : navigation.loading ? '正在切换对话，请稍后。' :
        draft.busy ? '当前创作正在处理，请稍后。' : modelSwitch.saving ? '正在切换模型，请稍后。' :
          reasoning.saving ? '正在保存思考强度，请稍后。' :
            Boolean(session.runtimeId) && connection !== 'open' ? '连接创作服务后才能调整思考强度。' : `思考强度：${reasoningHint}`
  const capabilityDisabledReason = selectionLocked ? (conversation.running ? '本轮创作完成或停止后可选择 Agent 或独立技能。' : draft.busy ? '当前创作正在处理，请稍后。' : navigation.loading ? '正在切换对话，请稍后。' : preparing ? '正在同步创作服务，请稍后。' : '连接创作服务后才能选择 Agent 或独立技能。') : '选择 Agent 或独立技能'
  const slashQuery = !agentMenuOpen && inputText.startsWith('/') && !inputText.includes('\n') ? inputText.slice(1).trim().replace(/^调用\s*/, '').toLocaleLowerCase() : ''
  const slashOpen = (agentMenuOpen || inputText.startsWith('/') && !slashDismissed) && !conversation.running && !draft.busy && !navigation.loading
  const slashOptions = SELECTABLE_CAPABILITIES.filter(agent => !slashQuery || `${agent.display_name} ${agent.aliases} ${(agent.legacy_names ?? []).join(' ')}`.toLocaleLowerCase().includes(slashQuery))
  const setCapability = (capability: Capability, action = '调用') => {
    const commands = draftParts.commands.filter(row => capability.kind === 'agent' ? row.capability.kind !== 'agent' : row.capability.id !== capability.id)
    const body = inputText.startsWith('/') && !inputText.includes('\n') ? '' : inputText
    commands.push({ capability, action })
    workspace.editComposer({ text: body, capabilityCommands: commands })
    setAgentMenuOpen(false)
    setSlashDismissed(true)
    input.current?.focus()
  }
  const chooseAgent = (index: number) => {
    const agent = slashOptions[index]
    if (!agent || selectionLocked) return
    setCapability(agent)
  }
  const removeCapability = (capability: Capability) => {
    const pending = draftParts.commands.find(row => row.capability.id === capability.id)
    if ((activeSelection.agent === capability.id || activeSelection.skills.includes(capability.id)) && pending?.action !== '停用') {
      setCapability(capability, '停用')
      return
    }
    workspace.editComposer({ text: inputText, capabilityCommands: draftParts.commands.filter(row => row.capability.id !== capability.id) })
    setAgentMenuOpen(false)
    setSlashDismissed(true)
    input.current?.focus()
  }
  useEffect(() => {
    if (!slashOpen) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.agent-slash-menu, .composer-input, .capability-add')) return
      setAgentMenuOpen(false)
      setSlashDismissed(true)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [slashOpen])
  useLayoutEffect(() => {
    if (!slashOpen || !input.current) { setSlashPosition(current => current.ready ? { ...current, ready: false } : current); return }
    const place = () => {
      const rect = input.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const visibleTop = viewport?.offsetTop ?? 0
      const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight)
      const above = rect.top - visibleTop - 20, below = visibleBottom - rect.bottom - 20
      const openAbove = above >= Math.min(330, below)
      setSlashPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(440, window.innerWidth - 24) - 12)),
        ...(openAbove ? { bottom: Math.max(12, window.innerHeight - rect.top + 8) } : { top: rect.bottom + 8 }),
        maxHeight: Math.max(100, openAbove ? above : below), ready: true })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [slashOpen, draft.text, selectedCapabilities.length])
  useEffect(() => {
    if (slashOpen && slashPosition.ready) document.getElementById(`${agentMenuId}-option-${slashActive}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [slashOpen, slashPosition.ready, slashActive, agentMenuId])
  const canSend = !modelSelectionError && connection === 'open' && !preparing && !draft.busy && !reasoning.saving && !modelSwitch.saving && !navigation.loading && !needsVerification && (inputText.trim() || draft.attachments.length || draftParts.commands.length)
  const uploadBlocked = modelSwitch.saving ? '正在切换模型，请稍后添加附件。' : attachmentBlockReason({ busy: draft.busy, running: conversation.running, loading: navigation.loading, preparing, connection })
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (draftParts.commands.length && event.key === 'Backspace' && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault()
      removeCapability(draftParts.commands.at(-1)!.capability)
      return
    }
    if (slashOpen && slashOptions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setSlashActive(current => event.key === 'ArrowDown' ? Math.min(current + 1, slashOptions.length - 1) : Math.max(current - 1, 0))
      return
    }
    if (slashOpen && slashOptions.length && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      chooseAgent(slashActive)
      return
    }
    if (slashOpen && event.key === 'Escape') {
      event.preventDefault()
      setAgentMenuOpen(false)
      setSlashDismissed(true)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      if (canSend && !conversation.running) { markLaunch(); void workspace.send() }
    }
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // 同一截图通常同时存在于 files 和 items，只从一个入口读取。
    const files = Array.from(event.clipboardData.files)
    if (!files.length) for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
    }
    if (!files.length) return
    event.preventDefault()
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
    void workspace.attach(files.map((file, index) => extensions[file.type] && !isImageFile(file.name)
      ? new File([file], `截图-${Date.now()}-${index + 1}.${extensions[file.type]}`, { type: file.type }) : file))
  }
  return <div className="composer-region" ref={region}>
    <div className={`composer-box ${conversation.running ? 'is-running' : ''}`}>
      {draft.attachments.length > 0 && <div className="attachment-chips">{draft.attachments.map((file, index) =>
        <div className="attachment-chip" key={file.path}>{isImageFile(file.name) ? <><SourceImage path={file.path} name={file.name} compact /><span>{file.name}</span></> : <AttachmentLabel name={file.name} />}
          <button disabled={draft.busy} aria-label={`移除附件 ${file.name}`} onClick={() => workspace.editComposer({ attachments: draft.attachments.filter((_, i) => i !== index) })}><X size={13} /></button>
        </div>)}</div>}
      <div className="composer-input">
      {selectedCapabilities.length > 0 && <div className="composer-capability-tokens" role="group" aria-label="已选择的创作能力">
        {selectedCapabilities.map(capability => {
          const pending = draftParts.commands.find(row => row.capability.id === capability.id)
          return <CapabilityTag key={capability.id} capability={capability}
            disabled={selectionLocked} expanded={slashOpen}
            title={`${capability.display_name} · ${pending ? '下条消息生效' : '当前对话持续启用'}`}
            onChoose={() => { setAgentMenuOpen(!agentMenuOpen); setSlashActive(Math.max(0, SELECTABLE_CAPABILITIES.indexOf(capability))); input.current?.focus() }}
            removeLabel={capability.kind === 'agent' ? `移除剧本 Agent：${capability.display_name}` : `停用${capability.display_name}`}
            onRemove={() => removeCapability(capability)} />
        })}
      </div>}
      <textarea ref={input} aria-label="给巨豹智能体发送消息" aria-controls={slashOpen ? agentMenuId : undefined} aria-activedescendant={slashOpen && slashOptions.length ? `${agentMenuId}-option-${slashActive}` : undefined} lang="zh-CN" translate="no" className="notranslate" spellCheck={false} autoCorrect="off" autoCapitalize="off" data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false"
        placeholder={conversation.entries.length ? '继续聊天，或提出新的需求…' : '输入问题、创作需求，或描述想生成的图片…'}
        rows={2} value={inputText} onChange={event => { setAgentMenuOpen(false); setSlashDismissed(false); setSlashActive(0); workspace.editComposer({ text: event.target.value, capabilityCommands: draftParts.commands }) }} onKeyDown={onKeyDown} onPaste={onPaste} disabled={draft.busy || navigation.loading} />
      </div>
      {slashOpen && slashPosition.ready && createPortal(<div id={agentMenuId} className="agent-slash-menu" role="listbox" aria-label="剧本 Agent" aria-multiselectable="true"
        style={{ left: slashPosition.left, top: slashPosition.top, bottom: slashPosition.bottom, maxHeight: slashPosition.maxHeight, overflowY: 'auto' }}>
        {capabilityGroups.map(group => {
          const options = slashOptions.filter(row => row.kind === group.kind)
          if (!options.length) return null
          return <div className={`agent-slash-group is-${group.kind}`} key={group.kind} role="group" aria-labelledby={`${agentMenuId}-${group.kind}`}>
            <div className="agent-slash-heading"><h3 id={`${agentMenuId}-${group.kind}`}>{group.title}</h3><p>{group.hint}</p></div>
            {options.map(agent => {
              const index = slashOptions.indexOf(agent), selected = isSelected(agent)
              // 已选（当前 Agent 与已启用 skill）和键盘光标分开显示：前者强调，后者只是悬停底色。
              return <button key={agent.id} id={`${agentMenuId}-option-${index}`} type="button" role="option" aria-label={agent.display_name} aria-selected={selected}
                className={[selected && 'is-selected', index === slashActive && 'is-active'].filter(Boolean).join(' ')} onMouseDown={event => event.preventDefault()} onClick={() => chooseAgent(index)}>
                <span className="capability-option-title"><strong>{agent.display_name.replace(/^巨豹 /, '')}</strong>{agent.environment_badge && <span className="capability-environment-badge">{agent.environment_badge}</span>}{selected && <Check className="capability-option-check" size={15} aria-hidden="true" />}</span>
                {agent.description && <small className="capability-option-description">{agent.description}</small>}
              </button>
            })}
          </div>
        })}
        {!slashOptions.length && <div className="agent-slash-empty">没有匹配的 Agent 或技能</div>}
      </div>, document.body)}
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button className="icon-button" aria-label="上传原稿或图片" title={uploadBlocked || '添加文档或图片 · 支持直接粘贴截图；图片每张 4 MB，文档每个 20 MB'} disabled={Boolean(uploadBlocked)} onClick={() => fileInput.current?.click()}>
            {draft.busy ? <LoaderCircle className="spin" size={18} /> : <Paperclip size={18} />}
          </button>
          <input hidden ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label="选择原稿或图片文件" onChange={event => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void workspace.attach(files)
          }} />
          <button type="button" className="capability-add" aria-label="选择 Agent 或独立技能" aria-haspopup="listbox" aria-expanded={slashOpen} aria-controls={slashOpen ? agentMenuId : undefined} title={capabilityDisabledReason} disabled={selectionLocked}
            aria-description={capabilityEnvironments.join(' · ') || undefined}
            onClick={() => { setAgentMenuOpen(!agentMenuOpen); setSlashActive(Math.max(0, SELECTABLE_CAPABILITIES.findIndex(row => row.id === nextSelection.agent))); input.current?.focus() }}><Layers size={14} /><span>调用</span>{capabilityEnvironments.map(label => <small className="capability-environment-badge" key={label}>{label}</small>)}</button>
          <span className="toolbar-divider" />
          <SelectMenu className="model-select" label="创作模型" value={selectedModel?.value || ''}
            placeholder={modelPlaceholder} options={modelOptions} leading={modelSwitch.saving ? <LoaderCircle className="spin" size={15} /> : <span className="status-dot" />}
            disabled={!modelOptions.length || draft.busy || modelSwitch.saving || reasoning.saving || navigation.loading || preparing || conversation.running || needsVerification || (Boolean(session.runtimeId) && connection !== 'open')}
            title={modelDisabledReason}
            onChange={value => {
              const choice = modelOptions.find(option => option.value === value)!
              if (choice.kind === 'image') workspace.selectImageModel(choice.model, choice.provider)
              else void workspace.selectModel(choice.model, choice.provider)
            }} />
          <SelectMenu className="reasoning-select" label="思考强度" value={requestedEffort} options={reasoningOptions.options}
            leading={reasoning.saving ? <LoaderCircle className="spin" size={15} /> : <BrainCircuit size={15} />}
            placeholder={requestedEffort ? reasoningLabel(requestedEffort) : '默认'}
            disabled={Boolean(modelSelectionError) || !reasoningOptions.options.length || reasoning.saving || modelSwitch.saving || draft.busy || navigation.loading || preparing || conversation.running || (Boolean(session.runtimeId) && connection !== 'open')}
            title={`${reasoningDisabledReason}${actualEffort && actualEffort !== requestedEffort ? `当前模型实际使用${reasoningLabel(actualEffort)}。` : ''}`}
            onChange={value => void workspace.setReasoningEffort(value)} />
          <button className={`text-button composer-settings ${settings ? 'selected' : ''}`} aria-label="创作设置" aria-expanded={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal size={15} /><span>创作偏好</span></button>
        </div>
        {conversation.running ? <button className="send-button stop" aria-label="停止创作" onClick={() => void workspace.interrupt()}><Square size={15} fill="currentColor" /></button> :
          <button className="send-button" aria-label="发送消息" disabled={!canSend} onClick={() => { setSentAt(Date.now()); markLaunch(); void workspace.send() }}>{sentAt > 0 && <span key={sentAt} className="send-ripple" aria-hidden="true" />}<ArrowUp size={19} /></button>}
      </div>
      <div className="composer-options-fold" data-expanded={settings} inert={!settings} aria-hidden={!settings}><div className="composer-options-clip"><div className="composer-options">
        <div className="composer-option"><span>故事地区</span><SelectMenu label="故事地区" value={draft.region} options={['中国', '北美'].map(value => ({ value, label: value }))} disabled={navigation.loading || preparing || draft.busy}
          onChange={value => workspace.editComposer({ region: value })} /></div>
        <div className="composer-option"><span>台词语言</span><SelectMenu label="台词语言" value={draft.language} options={DIALOGUE_LANGUAGES.map(value => ({ value, label: value }))} disabled={navigation.loading || preparing || draft.busy}
          onChange={value => workspace.editComposer({ language: value })} /></div>
      </div></div></div>
    </div>
    {modelSelectionError && !startup.models && <p className="inline-error" role="alert">{modelSelectionError}</p>}
    {preferenceError && <p className="inline-error" role="alert">{preferenceError}</p>}
    {modelSwitch.error && <p className="inline-error" role="alert">模型切换未确认：{publicError(modelSwitch.error)}</p>}
    {reasoning.error && <p className="inline-error" role="alert">思考强度未确认：{publicError(reasoning.error)}</p>}
    {composerHint && <div className="composer-hint"><span role={preparing || needsVerification ? 'status' : undefined}>{composerHint}</span></div>}
  </div>
}
