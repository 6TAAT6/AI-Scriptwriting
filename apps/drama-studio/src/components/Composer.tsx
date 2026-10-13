import { useStore } from '@nanostores/react'
import { ArrowUp, BrainCircuit, Layers, LoaderCircle, Paperclip, SlidersHorizontal, Square, X } from 'lucide-react'
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
import { CAPABILITIES, conversationSelection, selectionAfter, composerCapabilityDraft, type Capability } from '../lib/capabilities'

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
  const [slashPosition, setSlashPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; ready: boolean }>({ left: 0, bottom: 0, maxHeight: 330, ready: false })
  // 技能选择独立于正文，旧草稿中的调用前缀在读取时兼容。
  const draftParts = composerCapabilityDraft(draft.text, draft.capabilityCommands)
  const inputText = draftParts.body
  const activeSelection = conversationSelection(conversation.entries)
  const nextSelection = selectionAfter(activeSelection, draft.text, draftParts.commands)
  const selectedCapabilities = CAPABILITIES.filter(row => row.id === nextSelection.agent || nextSelection.skills.includes(row.id))
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
  const currentModel = modelInfo.model || (session.runtimeId ? catalog.model : '') || ''
  const requestedProvider = modelInfo.provider === 'custom' ? catalog.provider : modelInfo.provider || catalog.provider
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
  const modelDisabledReason = !modelOptions.length ? (startup.models ? '正在加载可用模型，请稍后。' : '当前没有可用的创作模型。') :
    conversation.running ? '本轮结束或停止后可切换模型。' :
      needsVerification ? '本轮状态待核对，请重新打开这段对话后继续。' :
        preparing ? '正在同步创作服务，请稍后。' : navigation.loading ? '正在切换对话，请稍后。' :
          draft.busy ? '当前创作正在处理，请稍后。' : modelSwitch.saving ? '正在切换模型，请稍后。' :
            reasoning.saving ? '正在保存思考强度，请稍后。' :
              Boolean(session.runtimeId) && connection !== 'open' ? '连接创作服务后才能切换模型。' : '选择当前对话使用的模型，切换后下一轮生效。'
  const reasoningDisabledReason = !reasoningOptions.options.length ? reasoningHint :
    conversation.running ? '本轮完成后可调整，下一轮生效。' :
      preparing ? '正在同步创作服务，请稍后。' : navigation.loading ? '正在切换对话，请稍后。' :
        draft.busy ? '当前创作正在处理，请稍后。' : modelSwitch.saving ? '正在切换模型，请稍后。' :
          reasoning.saving ? '正在保存思考强度，请稍后。' :
            Boolean(session.runtimeId) && connection !== 'open' ? '连接创作服务后才能调整思考强度。' : `思考强度：${reasoningHint}`
  const capabilityDisabledReason = selectionLocked ? (conversation.running ? '本轮创作完成或停止后可选择 Agent 或独立技能。' : draft.busy ? '当前创作正在处理，请稍后。' : navigation.loading ? '正在切换对话，请稍后。' : preparing ? '正在同步创作服务，请稍后。' : '连接创作服务后才能选择 Agent 或独立技能。') : '选择 Agent 或独立技能'
  const slashQuery = !agentMenuOpen && inputText.startsWith('/') && !inputText.includes('\n') ? inputText.slice(1).trim().replace(/^调用\s*/, '').toLocaleLowerCase() : ''
  const slashOpen = (agentMenuOpen || inputText.startsWith('/') && !slashDismissed) && !conversation.running && !draft.busy && !navigation.loading
  const slashOptions = CAPABILITIES.filter(agent => !slashQuery || `${agent.display_name} ${agent.aliases} ${(agent.legacy_names ?? []).join(' ')}`.toLocaleLowerCase().includes(slashQuery))
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
      const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20
      const openAbove = above >= Math.min(330, below)
      setSlashPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(440, window.innerWidth - 24) - 12)),
        ...(openAbove ? { bottom: Math.max(12, window.innerHeight - rect.top + 8) } : { top: rect.bottom + 8 }),
        maxHeight: Math.max(100, openAbove ? above : below), ready: true })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [slashOpen, draft.text, selectedCapabilities.length])
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
      if (canSend && !conversation.running) void workspace.send()
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
  return <div className="composer-region">
    <div className="composer-box">
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
            onChoose={() => { setAgentMenuOpen(!agentMenuOpen); setSlashActive(CAPABILITIES.indexOf(capability)); input.current?.focus() }}
            removeLabel={capability.kind === 'agent' ? `移除剧本 Agent：${capability.display_name}` : `停用${capability.display_name}`}
            onRemove={() => removeCapability(capability)} />
        })}
      </div>}
      <textarea ref={input} aria-label="给巨豹智能体发送消息" aria-controls={slashOpen ? agentMenuId : undefined} aria-activedescendant={slashOpen && slashOptions.length ? `${agentMenuId}-option-${slashActive}` : undefined} lang="zh-CN" translate="no" className="notranslate" spellCheck={false} autoCorrect="off" autoCapitalize="off" data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false"
        placeholder={conversation.entries.length ? '继续聊天，或提出新的需求…' : '输入问题、创作需求，或描述想生成的图片…'}
        rows={2} value={inputText} onChange={event => { setAgentMenuOpen(false); setSlashDismissed(false); setSlashActive(0); workspace.editComposer({ text: event.target.value, capabilityCommands: draftParts.commands }) }} onKeyDown={onKeyDown} onPaste={onPaste} disabled={draft.busy || navigation.loading} />
      </div>
      {slashOpen && slashPosition.ready && createPortal(<div id={agentMenuId} className="agent-slash-menu" role="listbox" aria-label="剧本 Agent"
        style={{ left: slashPosition.left, top: slashPosition.top, bottom: slashPosition.bottom, maxHeight: slashPosition.maxHeight, overflowY: 'auto' }}>
        <div className="agent-slash-heading">主 Agent 单选 · 独立技能可叠加 <span>↑ ↓ 选择 · Enter 确认</span></div>
        {slashOptions.map((agent, index) => <button key={agent.id} id={`${agentMenuId}-option-${index}`} type="button" role="option" aria-selected={index === slashActive}
          className={index === slashActive ? 'is-active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => chooseAgent(index)}>
          <strong>{agent.display_name}</strong><small>{agent.kind === 'agent' ? '主 Agent · 同一对话请固定使用，避免中途切换' : '独立技能 · 可单独使用或叠加，持续生效'}</small>
        </button>)}
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
            onClick={() => { setAgentMenuOpen(!agentMenuOpen); setSlashActive(0); input.current?.focus() }}><Layers size={14} /><span>调用</span></button>
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
            disabled={!reasoningOptions.options.length || reasoning.saving || modelSwitch.saving || draft.busy || navigation.loading || preparing || conversation.running || (Boolean(session.runtimeId) && connection !== 'open')}
            title={`${reasoningDisabledReason}${actualEffort && actualEffort !== requestedEffort ? `当前模型实际使用${reasoningLabel(actualEffort)}。` : ''}`}
            onChange={value => void workspace.setReasoningEffort(value)} />
          <button className={`text-button composer-settings ${settings ? 'selected' : ''}`} aria-label="创作设置" aria-expanded={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal size={15} /><span>创作偏好</span></button>
        </div>
        {conversation.running ? <button className="send-button stop" aria-label="停止创作" onClick={() => void workspace.interrupt()}><Square size={15} fill="currentColor" /></button> :
          <button className="send-button" aria-label="发送消息" disabled={!canSend} onClick={() => void workspace.send()}><ArrowUp size={19} /></button>}
      </div>
      <div className="composer-options-fold" data-expanded={settings} inert={!settings} aria-hidden={!settings}><div className="composer-options-clip"><div className="composer-options">
        <div className="composer-option"><span>故事地区</span><SelectMenu label="故事地区" value={draft.region} options={['中国', '欧美'].map(value => ({ value, label: value }))} disabled={navigation.loading || preparing || draft.busy}
          onChange={value => workspace.editComposer({ region: value })} /></div>
        <div className="composer-option"><span>台词语言</span><SelectMenu label="台词语言" value={draft.language} options={DIALOGUE_LANGUAGES.map(value => ({ value, label: value }))} disabled={navigation.loading || preparing || draft.busy}
          onChange={value => workspace.editComposer({ language: value })} /></div>
        <p>地区、台词语言和模型选择在当前对话持续生效，可随时手动调整；刷新后保留此浏览器中已保存的选择。本轮消息中的明确要求优先。</p>
      </div></div></div>
    </div>
    {modelSelectionError && !startup.models && <p className="inline-error" role="alert">{modelSelectionError}</p>}
    {preferenceError && <p className="inline-error" role="alert">{preferenceError}</p>}
    {modelSwitch.error && <p className="inline-error" role="alert">模型切换未确认：{publicError(modelSwitch.error)}</p>}
    {reasoning.error && <p className="inline-error" role="alert">思考强度未确认：{publicError(reasoning.error)}</p>}
    <div className="composer-hint"><span role={preparing || needsVerification ? 'status' : undefined}>{preparation || (needsVerification ? '本轮状态待核对，请重新打开这段对话后继续。' : conversation.running ? '正在创作，你可以随时停止' : 'Enter 发送 · Shift + Enter 换行')}</span><span>可粘贴截图或拖入文件</span></div>
  </div>
}
