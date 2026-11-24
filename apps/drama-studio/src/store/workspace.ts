import { randomId } from '../lib/id'
import { atom, computed } from 'nanostores'
import type { ServerRequest } from '../../../shared/src/json-rpc-channel'
import type { SessionLiveInfo, SessionListRow, FileAttachResult, RpcMethods } from '../../../shared/src/gateway-contract.generated'
import type { ConnectionState } from '../../../shared/src/json-rpc-gateway'
import { $currentUser } from '../accounts/api'
import { resolveNewConversationModel } from '../lib/new-conversation-model'
import { gateway } from '../lib/gateway'
import { attachmentBlockReason, attachedFiles, attachedImages } from '../lib/attachments'
import { DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, isImageFile, isSupportedFile } from '../../shared/attachments.mjs'
import { historyProject, historySources, mergeProjectArtifacts, projectFromResult, projectMatchesSelection, type Artifact, type ProjectSummary, type SessionMaterials } from '../lib/creative'
import { historyEntries, reduceEvent, restoreToolReceipts, userDisplayText, type Conversation, type StudioEvent } from '../lib/transcript'
import { beginTurn, restoreTurn } from '../lib/progress'
import { nativeNotice, restoreSubagents } from '../lib/native-activity'
import { availableSuggestions, selectedSuggestion } from '../lib/suggestions'
import { buildLanguageAwarePrompt } from '../lib/prompt-language'
import { capabilitySubmissionError, conversationSelection, selectionAfter, composerCapabilityDraft, capabilityOperations, type CapabilityCommand } from '../lib/capabilities'
import { modelReasoning, type StudioModelOptions } from '../lib/reasoning'
import { SessionActivity } from './session-activity'
import { SessionPreferenceStore, defaultPreferences, type CreativePreferences, type PreferenceScope } from './session-preferences'
import { $selectedSidebarProjectId, loadSidebar, patchSidebarSession, selectSidebarProject, sidebarSessionProjectId } from '../lib/sidebar'

export interface SessionSelection { storedId: string; runtimeId: string; info: SessionLiveInfo }
export interface ComposerState extends CreativePreferences { text: string; attachments: FileAttachResult[]; busy: boolean; capabilityCommands?: CapabilityCommand[] }
export interface ComposerDraftSnapshot { key: string; storedId: string; projectId: string | null; composer: ComposerState }
export interface DraftResumeAlias { from: string; to: string }
export interface WorkspaceDraftSnapshot { selectedKey: string; drafts: ComposerDraftSnapshot[]; aliases: DraftResumeAlias[] }
export interface NavigationState { sessions: SessionListRow[]; loading: boolean; error: string }
export const CONNECTION_LOST_ERROR = '创作连接已断开，重新连接后可恢复已有进度。'
export function clearConnectionErrorOnOpen(state: ConnectionState, navigation: NavigationState): NavigationState {
  return state === 'open' && navigation.error === CONNECTION_LOST_ERROR ? { ...navigation, error: '' } : navigation
}
export interface WorkspaceApi {
  profile: string
  rpc<K extends keyof RpcMethods>(method: K, params: RpcMethods[K]['params']): Promise<RpcMethods[K]['result']>
  materials(storedId: string): Promise<SessionMaterials>
  sessionReplayBarrier?(runtimeId: string): Promise<boolean> | undefined
  observeSelection?(selection: { runtimeId: string; storedId: string }): void
}

export interface WorkspaceProjects {
  load(): Promise<void>
  selected(): string | null
  select(id: string | null): void
  owner(sessionId: string): string | null
  attach(sessionId: string, projectId: string | null): Promise<boolean>
}

const MODEL_REFRESH_ERROR = '模型目录暂未刷新，请稍后新建对话重试。'
const draftHasContent = (draft: ComposerState) => Boolean(draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length)

export class Workspace {
  readonly navigation = atom<NavigationState>({ sessions: [], loading: false, error: '' })
  readonly session = atom<SessionSelection>({ storedId: '', runtimeId: '', info: {} })
  readonly conversation = atom<Conversation>({ runtimeId: '', entries: [], running: false, error: '' })
  readonly activity = new SessionActivity()
  readonly lastSubmissionId = atom('')
  readonly composer = atom<ComposerState>({ text: '', ...defaultPreferences(), attachments: [], busy: false })
  readonly draftChanges = atom(0)
  private readonly preferences = new SessionPreferenceStore()
  readonly preferenceError = this.preferences.error
  readonly project = atom<ProjectSummary | null>(null)
  readonly sources = atom<Artifact[]>([])
  readonly materialError = atom('')
  readonly models = atom<StudioModelOptions>({ providers: [] })
  readonly reasoning = atom({ saving: false, error: '' })
  readonly modelSwitch = atom({ saving: false, error: '' })
  readonly requests = atom<ServerRequest[]>([])
  readonly connection = atom<ConnectionState>('idle')
  readonly startup = atom({ history: false, models: false })
  readonly restoring = atom(false)
  readonly preparing = computed([this.startup, this.restoring], (startup, restoring) => startup.history || startup.models || restoring)
  private generation = 0
  private accountGeneration = 0
  private materialRequest = 0
  private restorePending = ''
  private creationKey = randomId()
  private creating: Promise<SessionSelection> | null = null
  private synchronizing: Promise<void> | null = null
  private queuedSync: { models: boolean; restore: boolean; materials: boolean } | null = null
  /** 合并同一帧内的正文增量，避免整段 Markdown 在每个 token 上重复解析和布局。 */
  private pendingStreamEvents: StudioEvent[] = []
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly drafts = new Map<string, ComposerState>()
  private readonly draftAliases = new Map<string, string>()
  private readonly pendingProjects = new Map<string, string | null>()
  private readonly pendingSessions = new Map<string, SessionListRow>()
  private draftProjectId: string | null

  constructor(readonly api: WorkspaceApi, readonly projects?: WorkspaceProjects, private readonly accountRole: () => string | null | undefined = () => undefined) {
    this.draftProjectId = projects?.selected() ?? null
    this.restoreDraftPreferences()
    this.session.subscribe(({ runtimeId, storedId }) => this.api.observeSelection?.({ runtimeId, storedId }))
  }

  get accountEpoch() { return this.accountGeneration }

  get canAutoUpdate() {
    const current = this.conversation.get()
    return !this.preferenceError.get() && !this.synchronizing && !this.navigation.get().loading && !this.preparing.get()
      && !current.running && !current.asyncPending && !this.requests.get().length && !this.reasoning.get().saving && !this.modelSwitch.get().saving
      && ![this.composer.get(), ...this.drafts.values()].some(draft => draft.busy || draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length)
  }

  reset() {
    this.activity.reset()
    this.cancelStreamEvents()
    this.accountGeneration++
    this.generation++
    this.creationKey = randomId()
    this.creating = null
    this.synchronizing = null
    this.queuedSync = null
    this.restorePending = ''
    this.drafts.clear()
    this.draftAliases.clear()
    this.pendingProjects.clear()
    this.pendingSessions.clear()
    this.draftProjectId = null
    this.navigation.set({ sessions: [], loading: false, error: '' })
    this.session.set({ storedId: '', runtimeId: '', info: {} })
    this.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
    this.lastSubmissionId.set('')
    this.composer.set({ text: '', ...defaultPreferences(), attachments: [], busy: false })
    this.preferences.clearErrors()
    this.project.set(null)
    this.sources.set([])
    this.materialError.set('')
    this.models.set({ providers: [] })
    this.reasoning.set({ saving: false, error: '' })
    this.modelSwitch.set({ saving: false, error: '' })
    this.requests.set([])
    this.connection.set('idle')
    this.startup.set({ history: false, models: false })
    this.restoring.set(false)
  }

  private storageKey() { return `drama-studio:${this.api.profile}:selected` }

  private preferenceScope(): PreferenceScope { return this.session.get().storedId ? ['session', this.session.get().storedId] : ['draft', this.draftProjectId] }

  private savePreferences() {
    const scope = this.preferenceScope()
    return this.preferences.save(this.api.profile, scope, { ...this.composer.get(), ...(scope[0] === 'draft' ? { draftModel: this.session.get().info } : {}) })
  }

  private restoreDraftPreferences() {
    const { draftModel, ...preferences } = this.preferences.read(this.api.profile, ['draft', this.draftProjectId])
    this.composer.set({ ...this.composer.get(), ...preferences })
    this.session.set({ ...this.session.get(), info: draftModel ?? {} })
    this.editComposer({})
  }

  editComposer(patch: Partial<ComposerState>) {
    const draft = { ...this.composer.get(), ...patch }
    if (draft.region === '欧美') draft.region = '北美'
    const commands = composerCapabilityDraft(draft.text, draft.capabilityCommands).commands
    const northAmericaSelected = selectionAfter(conversationSelection(this.conversation.get().entries), draft.text, commands).skills.includes('north-america-comic')
    const changed = draft.northAmericaSelected !== northAmericaSelected && (northAmericaSelected || draft.northAmericaSelected !== undefined)
    // 只在选中、停用及旧会话首次恢复的边界设置默认，后续手选不会被每次输入覆盖。
    if (changed) {
      draft.region = northAmericaSelected ? '北美' : '中国'
      draft.language = '仅中文'
    }
    draft.northAmericaSelected = northAmericaSelected
    if (['text', 'attachments', 'capabilityCommands'].some(key => Object.hasOwn(patch, key))) {
      this.rememberDraft(this.session.get().storedId || this.draftKey(), draft)
    }
    this.composer.set(draft)
    if (changed || ['region', 'language', 'imageModel'].some(key => Object.hasOwn(patch, key))) this.savePreferences()
  }

  private canUseSuggestion(entryId: string, prompt: string): boolean {
    const session = this.session.get(), conversation = this.conversation.get()
    if (!session.runtimeId || conversation.runtimeId !== session.runtimeId || this.connection.get() !== 'open'
      || this.preparing.get()
      || this.composer.get().busy || this.navigation.get().loading || this.reasoning.get().saving || this.modelSwitch.get().saving
      || this.requests.get().some(request => request.params.session_id === session.runtimeId)) return false
    const available = availableSuggestions(conversation)
    return available?.entryId === entryId && available.suggestions.some(suggestion => suggestion.prompt === prompt)
  }

  editSuggestedReply(entryId: string, prompt: string): boolean {
    if (!this.canUseSuggestion(entryId, prompt)) return false
    const draft = this.composer.get()
    if (!draft.text.endsWith(prompt)) this.editComposer({ text: draft.text.trim() ? `${draft.text}\n\n${prompt}` : prompt })
    return true
  }

  async sendSuggestedReply(entryId: string, prompt: string): Promise<boolean> {
    const draft = this.composer.get()
    if (!this.canUseSuggestion(entryId, prompt) || draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length) return false
    this.editComposer({ text: prompt })
    await this.send()
    return true
  }

  modelSelection(): SessionLiveInfo {
    const selected = this.session.get()
    if (selected.info.model_selection_required) throw new Error('历史模型当前不可用，请先选择可用的创作模型后继续；历史内容仍可正常查看。')
    return selected.storedId || selected.runtimeId ? selected.info : resolveNewConversationModel(this.models.get(), this.accountRole(), selected.info)
  }

  async selectModel(model: string, provider: string): Promise<void> {
    const selected = this.session.get()
    if (this.modelSwitch.get().saving || this.reasoning.get().saving || this.composer.get().busy || this.navigation.get().loading || this.preparing.get()
      || this.conversation.get().running || this.conversation.get().turn?.state === 'unknown') return
    const row = this.models.get().providers.find(row => row.slug === provider)
    if (!row?.models?.includes(model)) return
    const same = selected.info.model === model && (selected.info.provider === provider || row.aliases?.includes(selected.info.provider || ''))
    if (same && !selected.info.model_selection_required) { this.editComposer({ imageModel: undefined }); return }
    const info = { ...selected.info, model, provider }
    const { efforts, defaultEffort } = modelReasoning(this.models.get(), info)
    const effort = defaultEffort || efforts.find(value => value === info.reasoning_effort)
    if (!selected.runtimeId) {
      this.session.set({ ...selected, info: { ...info, reasoning_effort: effort, reasoning_effort_wire: undefined } })
      this.editComposer({ imageModel: undefined })
      this.reasoning.set({ saving: false, error: '' }); this.modelSwitch.set({ saving: false, error: '' })
      return
    }
    if (this.connection.get() !== 'open') { this.modelSwitch.set({ saving: false, error: '请等待连接恢复后再切换模型。' }); return }
    const generation = ++this.generation
    this.modelSwitch.set({ saving: true, error: '' })
    this.reasoning.set({ saving: false, error: '' })
    try {
      const result = await this.api.rpc('config.set', { profile: this.api.profile, session_id: selected.runtimeId, key: 'model', scope: 'session',
        value: { model, provider, ...(effort ? { reasoning_effort: effort } : {}) } })
      if (generation !== this.generation || this.session.get().runtimeId !== selected.runtimeId) return
      if (result.key !== 'model' || result.value !== model || result.confirm_required || result.info?.model !== model) throw new Error('服务端尚未确认模型切换，请重新打开对话核对。')
      this.session.set({ ...this.session.get(), info: { ...this.session.get().info, ...result.info } })
      this.editComposer({ imageModel: undefined })
    } catch (error) {
      if (generation === this.generation) this.modelSwitch.set({ saving: false, error: error instanceof Error ? error.message : '模型切换失败，请重试。' })
    } finally {
      if (generation === this.generation) this.modelSwitch.set({ ...this.modelSwitch.get(), saving: false })
    }
  }

  async setReasoningEffort(effort: string): Promise<void> {
    if (this.modelSwitch.get().saving || this.reasoning.get().saving || this.composer.get().busy || this.navigation.get().loading || this.preparing.get() || this.conversation.get().running) return
    const selected = this.session.get()
    let modelInfo: SessionLiveInfo
    try { modelInfo = this.modelSelection() }
    catch (error) { this.reasoning.set({ saving: false, error: error instanceof Error ? error.message : '请选择可用的创作模型。' }); return }
    const { efforts } = modelReasoning(this.models.get(), modelInfo)
    if (!efforts.some(value => value === effort)) return
    if (!selected.runtimeId) {
      this.session.set({ ...selected, info: { ...selected.info, reasoning_effort: effort, reasoning_effort_wire: undefined } })
      this.savePreferences()
      this.reasoning.set({ saving: false, error: '' })
      return
    }
    const generation = this.generation
    this.reasoning.set({ saving: true, error: '' })
    try {
      const result = await this.api.rpc('config.set', { profile: this.api.profile, session_id: selected.runtimeId, key: 'reasoning', value: effort, scope: 'session' })
      if (generation !== this.generation || this.session.get().runtimeId !== selected.runtimeId) return
      if (result.key !== 'reasoning' || typeof result.value !== 'string') throw new Error('服务端尚未确认思考强度，请重新打开会话核对。')
      const current = this.session.get()
      this.session.set({ ...current, info: { ...current.info, ...result.info, reasoning_effort: result.info?.reasoning_effort || result.value,
        reasoning_effort_wire: result.info?.reasoning_effort_wire || (current.info.reasoning_effort === result.value ? current.info.reasoning_effort_wire : undefined) } })
    } catch (error) {
      if (generation === this.generation) this.reasoning.set({ saving: false, error: error instanceof Error ? error.message : '思考强度保存失败，请重试。' })
    } finally {
      if (generation === this.generation) this.reasoning.set({ ...this.reasoning.get(), saving: false })
    }
  }

  selectImageModel(model: string, provider: string) {
    if (this.modelSwitch.get().saving || this.composer.get().busy || this.preparing.get() || this.conversation.get().running) return
    if (!this.models.get().providers.some(row => row.slug === provider && row.image_models?.includes(model))) return
    this.editComposer({ imageModel: { model, provider } })
  }

  async refresh(): Promise<void> {
    const activity = this.refreshActivity()
    const epoch = this.accountGeneration
    const result = await this.api.rpc('session.list', { profile: this.api.profile, include_hidden: true, limit: 100 })
    if (epoch !== this.accountGeneration) return
    for (const row of result.sessions) this.pendingSessions.delete(row.id)
    const pending = [...this.pendingSessions.values()].reverse().filter(row => !this.pendingProjects.has(row.id))
    this.navigation.set({ ...this.navigation.get(), sessions: [...pending, ...result.sessions], error: '' })
    await activity
  }

  private async refreshActivity() {
    this.activity.scope(this.api.profile)
    const ticket = this.activity.ticket()
    try {
      const result = await this.api.rpc('session.active_list', { profile: this.api.profile })
      if (Array.isArray(result.sessions)) this.activity.reconcile(result.sessions, ticket)
    } catch { /* 读取失败保留最近的真实事件，下一次同步再校准。 */ }
  }

  async refreshModels(): Promise<void> {
    const epoch = this.accountGeneration
    // 服务重启等短暂中断时先自动重试一次；成功后清除旧的“目录未刷新”提示，避免提示一直停留在输入框下。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.api.rpc('model.options', { profile: this.api.profile, explicit_only: true, include_unconfigured: false })
        if (epoch !== this.accountGeneration) return
        this.models.set(result as StudioModelOptions)
        if (this.reasoning.get().error === MODEL_REFRESH_ERROR) this.reasoning.set({ ...this.reasoning.get(), error: '' })
        return
      } catch {
        if (epoch !== this.accountGeneration) return
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
    if (epoch === this.accountGeneration) this.reasoning.set({ ...this.reasoning.get(), error: MODEL_REFRESH_ERROR })
  }

  async initialize(restorePrevious = true): Promise<void> {
    const epoch = this.accountGeneration
    const generation = this.generation
    this.startup.set({ history: true, models: true })
    this.navigation.set({ ...this.navigation.get(), error: '' })
    const historyRequests = Promise.allSettled([this.refresh(), this.projects?.load()])
    const models = this.api.rpc('model.options', { profile: this.api.profile, explicit_only: true, include_unconfigured: false })
      .then(result => { if (epoch === this.accountGeneration) this.models.set(result as StudioModelOptions) })
      .finally(() => { if (epoch === this.accountGeneration) this.startup.set({ ...this.startup.get(), models: false }) })
    const history = historyRequests.then(async results => {
      if (epoch !== this.accountGeneration) return
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      // 首页已可编辑；迟到的恢复不能切走用户主动打开的聊天或覆盖新输入。
      if (generation !== this.generation) return
      if (!this.session.get().storedId) {
        this.draftProjectId = this.projects?.selected() ?? null
        this.restoreDraftPreferences()
      }
      const draft = this.composer.get()
      if (draft.text.trim() || draft.attachments.length || draft.busy) return
      const storedId = localStorage.getItem(this.storageKey())
      if (restorePrevious && storedId && this.navigation.get().sessions.some(row => row.id === storedId)) await this.open(storedId)
    }).finally(() => { if (epoch === this.accountGeneration) this.startup.set({ ...this.startup.get(), history: false }) })
    const results = await Promise.allSettled([history, models])
    if (epoch !== this.accountGeneration) return
    const error = results.find(result => result.status === 'rejected')
    if (error?.status === 'rejected') this.navigation.set({ ...this.navigation.get(), error: String(error.reason?.message || '工作区数据加载失败，请重试。') })
  }

  synchronize({ models = false, restore = false, materials = false } = {}): Promise<void> {
    if (this.synchronizing) {
      this.queuedSync = { models: models || Boolean(this.queuedSync?.models), restore: restore || Boolean(this.queuedSync?.restore), materials: materials || Boolean(this.queuedSync?.materials) }
      return this.synchronizing
    }
    const epoch = this.accountGeneration, generation = this.generation, selected = this.session.get()
    const before = this.navigation.get().sessions.find(row => row.id === selected.storedId)?.message_count
    const operation = (async () => {
      const results = await Promise.allSettled([this.refresh(), this.projects?.load(), ...(models ? [this.refreshModels()] : [])])
      if (epoch !== this.accountGeneration || generation !== this.generation) return
      if (results[0].status === 'rejected') this.navigation.set({ ...this.navigation.get(), error: '对话状态暂未同步，恢复连接后会自动重试。' })
      if (!selected.storedId || this.navigation.get().loading || this.modelSwitch.get().saving) return
      const after = this.navigation.get().sessions.find(row => row.id === selected.storedId)?.message_count
      const needsRestore = restore || this.restorePending === selected.storedId || this.conversation.get().turn?.state === 'unknown'
      if (!this.composer.get().busy && (needsRestore || !materials && before !== after && !this.conversation.get().running && !this.conversation.get().asyncPending)) {
        await this.open(selected.storedId, { background: true })
      } else {
        if ((materials || before !== after) && !this.pendingSessions.has(selected.storedId)) await this.loadMaterials(selected)
        if (this.conversation.get().asyncPending) {
          const beforeSubagents = this.conversation.get().entries.filter(row => row.subagent).map(row => row.subagent)
          const snapshot = await this.api.rpc('subagent.list', { profile: this.api.profile, session_id: selected.runtimeId })
          const current = this.conversation.get()
          const currentSubagents = current.entries.filter(row => row.subagent).map(row => row.subagent)
          if (epoch === this.accountGeneration && generation === this.generation && beforeSubagents.length === currentSubagents.length
            && beforeSubagents.every((row, index) => row === currentSubagents[index])) this.conversation.set(restoreSubagents(current, snapshot.subagents ?? [], snapshot.delegations ?? []))
        }
      }
    })().finally(() => {
      if (this.synchronizing !== operation) return
      this.synchronizing = null
      const queued = this.queuedSync
      this.queuedSync = null
      if (queued && epoch === this.accountGeneration) void this.synchronize(queued).catch(() => {})
    })
    this.synchronizing = operation
    return operation
  }

  private draftKey(projectId = this.draftProjectId) { return `new:${projectId ?? 'recent'}` }

  private draftFamily(key: string): Set<string> {
    const family = new Set([key])
    let changed = true
    while (changed) {
      changed = false
      for (const [from, to] of this.draftAliases) if (family.has(from) || family.has(to)) {
        if (!family.has(from)) { family.add(from); changed = true }
        if (!family.has(to)) { family.add(to); changed = true }
      }
    }
    return family
  }

  private rememberDraft(key: string, draft: ComposerState) {
    const filled = draftHasContent(draft)
    for (const other of this.draftFamily(key)) if (other !== key) {
      const previous = this.drafts.get(other)
      if (!filled || previous && !draftHasContent(previous)) this.drafts.delete(other)
    }
    this.drafts.set(key, { ...draft, busy: false })
  }

  restoreComposerDraft(draft: ComposerState) {
    this.rememberDraft(this.session.get().storedId || this.draftKey(), draft)
    this.composer.set(draft)
  }

  private stashDraft() {
    const key = this.session.get().storedId || this.draftKey(), draft = this.composer.get()
    if (this.drafts.has(key) || draftHasContent(draft)) this.rememberDraft(key, draft)
  }

  maintenanceDraftSnapshot(): WorkspaceDraftSnapshot {
    const selected = this.session.get(), selectedKey = selected.storedId || this.draftKey()
    const drafts = new Map(this.drafts), current = this.composer.get()
    if (drafts.has(selectedKey) || current.text.trim() || current.attachments.length || current.capabilityCommands?.length) drafts.set(selectedKey, { ...current })
    return { selectedKey, aliases: [...this.draftAliases].map(([from, to]) => ({ from, to })), drafts: [...drafts].map(([key, composer]) => {
      const project = key.startsWith('new:') ? key.slice(4) : null
      return { key, storedId: key === selectedKey ? selected.storedId : project === null ? key : '',
        projectId: key === selectedKey && !selected.storedId ? this.draftProjectId : project === 'recent' ? null : project, composer }
    }) }
  }

  private clearDraft(key: string) {
    // 空记录表示明确清空或删除；reset 的空 Map 只表示尚未恢复，不能抹掉维护副本。
    this.rememberDraft(key, { text: '', ...defaultPreferences(), attachments: [], capabilityCommands: [], busy: false })
    this.draftChanges.set(this.draftChanges.get() + 1)
  }

  forgetConversation(storedId: string) {
    this.activity.forget(storedId)
    this.cancelStreamEvents()
    this.generation++
    this.restoring.set(false)
    this.clearDraft(storedId)
    this.preferences.remove(this.api.profile, ['session', storedId])
    this.pendingProjects.delete(storedId)
    this.pendingSessions.delete(storedId)
    const selected = this.session.get()
    if (selected.storedId === storedId) {
      this.creationKey = randomId()
      this.draftProjectId = this.projects ? this.projects.selected() : this.draftProjectId
      this.session.set({ storedId: '', runtimeId: '', info: {} })
      this.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
      this.requests.set(this.requests.get().filter(request => request.params.session_id !== selected.runtimeId))
      this.composer.set(this.drafts.get(this.draftKey()) ?? { text: '', capabilityCommands: [], ...defaultPreferences(), attachments: [], busy: false })
      this.restoreDraftPreferences()
      this.reasoning.set({ saving: false, error: '' })
      this.project.set(null)
      this.sources.set([])
      this.materialError.set('')
    }
    if (localStorage.getItem(this.storageKey()) === storedId) localStorage.removeItem(this.storageKey())
    this.navigation.set({ ...this.navigation.get(), sessions: this.navigation.get().sessions.filter(row => row.id !== storedId), loading: false })
  }

  newConversation(projectId: string | null = this.projects?.selected() ?? null) {
    if (this.composer.get().busy) return
    this.cancelStreamEvents()
    this.generation++
    this.restorePending = ''
    this.restoring.set(false)
    this.creationKey = randomId()
    this.stashDraft()
    this.reasoning.set({ saving: false, error: '' })
    this.modelSwitch.set({ saving: false, error: '' })
    this.projects?.select(projectId)
    this.draftProjectId = projectId
    this.session.set({ storedId: '', runtimeId: '', info: {} })
    this.conversation.set({ runtimeId: '', entries: [], running: false, error: '' })
    this.project.set(null)
    this.sources.set([])
    this.materialError.set('')
    this.composer.set(this.drafts.get(this.draftKey(projectId)) ?? { text: '', capabilityCommands: [], ...defaultPreferences(), attachments: [], busy: false })
    this.restoreDraftPreferences()
    this.navigation.set({ ...this.navigation.get(), loading: false, error: '' })
    localStorage.removeItem(this.storageKey())
    if (this.connection.get() === 'open') void this.refreshModels()
  }

  async open(storedId: string, { background = false } = {}): Promise<void> {
    if (this.composer.get().busy) return
    if (background && this.modelSwitch.get().saving) return
    const keepInput = background && this.session.get().storedId === storedId
    // 后台重读当前仍在运行的会话时，保留已经到达但尚未过32ms批处理窗口的正文增量。
    // 切换到其他会话仍需清掉旧会话队列，避免迟到事件污染新视图。
    if (!keepInput) this.cancelStreamEvents()
    const before = this.conversation.get()
    const generation = ++this.generation
    const accountEpoch = this.accountGeneration, profile = this.api.profile
    this.stashDraft()
    this.reasoning.set({ saving: false, error: '' })
    this.modelSwitch.set({ saving: false, error: '' })
    this.restoring.set(keepInput)
    this.navigation.set({ ...this.navigation.get(), loading: !keepInput, error: '' })
    try {
      const resume = () => this.api.rpc('session.resume', {
        // lazy 只用于子代理观察窗口；创作续聊须恢复已保存的模型、供应商与思考配置。
        profile: this.api.profile, session_id: storedId, lazy: false,
        eager_build: false, source: 'web', close_on_disconnect: false
      })
      let result = await resume()
      if (generation !== this.generation) return
      const replay = this.api.sessionReplayBarrier?.(result.session_id)
      if (replay) {
        if (!await replay || generation !== this.generation) return
        // 其他会话也可能仍在重连回放；回放结束后重读，避免旧完成事件覆盖新轮正文。
        result = await resume()
      }
      if (generation !== this.generation) return
      if (keepInput) this.flushStreamEvents()
      // 恢复快照没有事件水位；同会话的新事件已到达时，保留实时结果并交给下一次同步重读。
      if (result.session_id === before.runtimeId && this.conversation.get() !== before) {
        this.restorePending = storedId
        return
      }
      this.restorePending = ''
      const selected = { runtimeId: result.session_id, storedId: result.stored_session_id || storedId, info: result.info }
      const migrateDraft = storedId !== selected.storedId && accountEpoch === this.accountGeneration && profile === this.api.profile
      if (migrateDraft) {
        const previous = this.draftAliases.get(storedId), key = this.drafts.has(storedId) ? storedId : previous
        const draft = key ? this.drafts.get(key) : undefined
        if (draft && !this.drafts.has(selected.storedId)) { this.drafts.set(selected.storedId, draft); this.drafts.delete(key!) }
        for (const [from, to] of this.draftAliases) if (to === storedId || to === previous) this.draftAliases.set(from, selected.storedId)
        if (previous && previous !== selected.storedId) this.draftAliases.set(previous, selected.storedId)
        this.draftAliases.set(storedId, selected.storedId)
      }
      this.session.set(selected)
      this.activity.scope(this.api.profile)
      this.activity.bind(selected.runtimeId, selected.storedId, Boolean(result.running ?? result.info.running))
      if (document.visibilityState !== 'hidden') { this.activity.markRead(storedId); this.activity.markRead(selected.storedId) }
      if (this.projects) this.projects.select(this.projects.owner(selected.storedId))
      const state: Conversation = { runtimeId: result.session_id, entries: historyEntries(result.messages), running: Boolean(result.running ?? result.info.running), error: '', turn: restoreTurn(result) }
      if (result.inflight?.assistant) state.entries.push({ id: 'inflight', role: 'assistant', text: result.inflight.assistant, calls: [], pending: state.running })
      if (result.inflight?.display_kind === 'auto_continue') state.entries.push(nativeNotice('inflight-auto-continue', 'auto_continue', '正在自动恢复上次中断的任务'))
      if (result.inflight?.error) state.error = result.inflight.error
      if (result.auto_continue) state.entries.push(nativeNotice('resume-auto-continue', 'auto_continue', `正在自动恢复上次中断的任务（第 ${result.auto_continue.attempt} 次）`))
      this.conversation.set(state)
      this.project.set(historyProject(result.messages))
      this.sources.set(historySources(result.messages))
      this.materialError.set('')
      this.preferences.migrate(this.api.profile, storedId, selected.storedId)
      if (keepInput) {
        this.drafts.set(selected.storedId, { ...this.composer.get(), busy: false })
        this.savePreferences()
      }
      else this.composer.set({ ...(this.drafts.get(selected.storedId) ?? { text: '', capabilityCommands: [], attachments: [], busy: false }),
        ...this.preferences.read(this.api.profile, ['session', selected.storedId], result.messages) })
      this.editComposer({})
      if (migrateDraft) this.draftChanges.set(this.draftChanges.get() + 1)
      localStorage.setItem(this.storageKey(), selected.storedId)
      if (!this.pendingSessions.has(selected.storedId)) void this.loadMaterials(selected)
      void this.loadNativeActivity(selected, generation)
    } catch (error) {
      if (generation === this.generation) this.navigation.set({ ...this.navigation.get(), error: error instanceof Error ? error.message : '无法打开这段对话。' })
    } finally {
      if (generation === this.generation) {
        this.restoring.set(false)
        this.navigation.set({ ...this.navigation.get(), loading: false })
      }
    }
  }

  private async loadNativeActivity(selected: SessionSelection, generation: number) {
    const matches = () => generation === this.generation && selected.runtimeId === this.session.get().runtimeId
    const before = this.conversation.get().entries.filter(row => row.subagent).map(row => row.subagent)
    const results = await Promise.allSettled([
      this.api.rpc('subagent.list', { profile: this.api.profile, session_id: selected.runtimeId }),
      this.api.rpc('session.events.since', { session_id: selected.runtimeId, last_seen: 0 })
    ])
    if (!matches()) return
    let state = this.conversation.get()
    const current = state.entries.filter(row => row.subagent).map(row => row.subagent)
    const snapshotCurrent = before.length === current.length && before.every((row, index) => row === current[index])
    if (results[1].status === 'fulfilled') {
      // 历史消息已经包含正文与工具；这里只补原生状态，避免重放正文或重新触发任务。
      for (const event of results[1].value.events ?? []) {
        if (typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object') continue
        if (!event.type.startsWith('subagent.') && !['review.summary', 'background.complete'].includes(event.type)) continue
        state = reduceEvent(state, { ...event, replayed: true, replayEpoch: results[1].value.epoch } as StudioEvent)
      }
    }
    if (results[0].status === 'fulfilled' && snapshotCurrent) state = restoreSubagents(state, results[0].value.subagents ?? [], results[0].value.delegations ?? [])
    this.conversation.set(state)
  }

  async loadMaterials(selected = this.session.get()) {
    const epoch = this.accountGeneration
    if (!selected.storedId) return
    const generation = this.generation, request = ++this.materialRequest, project = this.project.get()
    const sources = this.sources.get()
    const matches = () => epoch === this.accountGeneration && generation === this.generation
      && request === this.materialRequest && this.session.get().runtimeId === selected.runtimeId
    try {
      const materials = await this.api.materials(selected.storedId)
      if (!matches()) return
      // 等待期间的新交付与新附件优先于旧资料快照。
      if (materials.project && projectMatchesSelection(materials.project, conversationSelection(this.conversation.get().entries))) {
        const current = this.project.get()
        this.project.set(current === project ? mergeProjectArtifacts(materials.project, current) : mergeProjectArtifacts(current, materials.project))
      }
      if (this.sources.get() === sources) this.sources.set(materials.sources)
      if (materials.receipts?.length) {
        const current = this.conversation.get()
        this.conversation.set({ ...current, entries: restoreToolReceipts(current.entries, materials.receipts) })
      }
      this.materialError.set('')
    } catch {
      if (matches()) this.materialError.set('部分历史资料暂未读取，请刷新资料重试。')
    }
  }

  async ensureSession(): Promise<SessionSelection> {
    if (this.session.get().runtimeId) {
      const selected = this.session.get()
      await this.bindSessionProject(selected)
      return selected
    }
    if (this.creating) return this.creating
    const creating = this.createSession()
    this.creating = creating
    try { return await creating } finally { if (this.creating === creating) this.creating = null }
  }

  private async bindSessionProject(session: SessionSelection) {
    const projectId = this.pendingProjects.get(session.storedId)
    if (this.pendingProjects.has(session.storedId) && this.projects) {
      const epoch = this.accountGeneration
      const assigned = await this.projects.attach(session.storedId, projectId ?? null)
      if (epoch !== this.accountGeneration) throw new Error('账号已切换。')
      if (!assigned) throw new Error('项目归属暂未保存，消息尚未发送。请稍后再次发送以重试。')
      this.pendingProjects.delete(session.storedId)
    }
    const row = this.pendingSessions.get(session.storedId)
    const navigation = this.navigation.get()
    if (row && !navigation.sessions.some(item => item.id === row.id)) this.navigation.set({ ...navigation, sessions: [row, ...navigation.sessions] })
  }

  private async createSession(): Promise<SessionSelection> {
    const epoch = this.accountGeneration
    const projectId = this.draftProjectId
    const { model, provider, reasoning_effort: reasoningEffort } = this.modelSelection()
    const title = this.composer.get().text.trim().slice(0, 35) || '新的剧本创作'
    const result = await this.api.rpc('session.create', {
      profile: this.api.profile, source: 'web', title,
      model, provider, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      close_on_disconnect: false, idempotency_key: this.creationKey
    })
    if (epoch !== this.accountGeneration) throw new Error('账号已切换，请在当前账号中重新开始。')
    const selected = { runtimeId: result.session_id, storedId: result.stored_session_id, info: result.info }
    this.session.set(selected)
    this.activity.scope(this.api.profile)
    this.activity.bind(selected.runtimeId, selected.storedId, false)
    if (this.savePreferences()) this.preferences.remove(this.api.profile, ['draft', projectId])
    this.conversation.set({ runtimeId: selected.runtimeId, entries: historyEntries(result.messages), running: false, error: '' })
    this.clearDraft(this.draftKey(projectId))
    // 新会话在首轮落盘前不会出现在历史列表中；使用真实创建回执立即发布侧栏条目。
    this.pendingSessions.set(selected.storedId, { id: selected.storedId, title, source: 'web', started_at: Date.now() / 1000, message_count: result.message_count })
    if (this.projects) this.pendingProjects.set(selected.storedId, projectId)
    localStorage.setItem(this.storageKey(), selected.storedId)
    await this.bindSessionProject(selected)
    await this.refresh()
    return selected
  }

  async send(): Promise<void> {
    const submittedAt = Date.now()
    const epoch = this.accountGeneration
    const draft = this.composer.get()
    const selectionDraft = composerCapabilityDraft(draft.text, draft.capabilityCommands)
    if (this.preparing.get() || this.navigation.get().loading
      || draft.busy || this.reasoning.get().saving || this.modelSwitch.get().saving || this.conversation.get().running
      || this.session.get().info.model_selection_required
      || this.conversation.get().turn?.state === 'unknown'
      || (!draft.text.trim() && !draft.attachments.length && !selectionDraft.commands.length)) return
    const current = this.conversation.get()
    const selectionError = capabilitySubmissionError(conversationSelection(current.entries), draft.text, Boolean(current.asyncPending), selectionDraft.commands)
    if (selectionError) {
      this.conversation.set({ ...current, error: selectionError })
      return
    }
    this.editComposer({ busy: true })
    try {
      const session = await this.ensureSession()
      if (epoch !== this.accountGeneration) return
      const conversation = this.conversation.get()
      const text = selectionDraft.body.trim() + (draft.attachments.length ? '\n\n' + draft.attachments.map(file => file.ref_text).join('\n') : '')
      const choice = !draft.attachments.length && !selectionDraft.commands.length && !this.requests.get().length
        ? selectedSuggestion(conversation, text) : null
      const capabilities = selectionAfter(conversationSelection(conversation.entries), draft.text, selectionDraft.commands)
      const entryId = randomId()
      const images = attachedImages(text)
      const attachments = attachedFiles(text)
      this.conversation.set({ ...conversation, running: true, error: '', turn: beginTurn(submittedAt), entries: [...conversation.entries, { id: entryId, role: 'user', text: userDisplayText(text), capabilities, capabilityCommands: selectionDraft.commands, calls: [], ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) }] })
      this.activity.bind(session.runtimeId, session.storedId, true)
      this.lastSubmissionId.set(entryId)
      try {
        const projectId = this.pendingProjects.has(session.storedId) ? this.pendingProjects.get(session.storedId) ?? null : sidebarSessionProjectId(session.storedId)
        let prompt = buildLanguageAwarePrompt(text, draft.language, draft.region, capabilities, capabilityOperations(selectionDraft.commands), projectId)
        if (choice) prompt = prompt.replace('\n\n【用户本轮消息】\n',
          `\n\n【本轮选项选择】\n用户本轮回复选择了上一条回复中的「${choice.label}」。本轮具体请求：${choice.prompt}\n\n【用户本轮消息】\n`)
        const params = { profile: this.api.profile, session_id: session.runtimeId, text: prompt, surface: 'web' as const,
          image_model: draft.imageModel?.model || '', image_provider: draft.imageModel?.provider || '' }
        await this.api.rpc('prompt.submit', params)
        if (epoch !== this.accountGeneration) return
        if (capabilities.agent !== conversationSelection(conversation.entries).agent) {
          this.materialRequest++
          const project = this.project.get()
          if (project && !projectMatchesSelection(project, capabilities)) this.project.set(null)
        }
        this.sources.set([...this.sources.get(), ...draft.attachments.map(file => ({ id: file.path, name: file.name, path: file.path, kind: 'source' as const }))])
        this.editComposer({ text: '', attachments: [], capabilityCommands: [] })
      } catch (error) {
        if (epoch !== this.accountGeneration) return
        this.activity.bind(session.runtimeId, session.storedId, false)
        // 提交结果不明时保留输入，让用户恢复会话核实；不自动重发产生重复创作。
        const current = this.conversation.get()
        this.conversation.set({ ...current, running: false, turn: current.turn ? { ...current.turn, state: 'unknown', endedAt: undefined, status: '消息提交状态待核对' } : undefined,
          error: `消息提交未确认：${error instanceof Error ? error.message : '连接中断'}。请重新打开会话核实后继续。` })
      }
    } catch (error) {
      if (epoch !== this.accountGeneration) return
      this.conversation.set({ ...this.conversation.get(), error: error instanceof Error ? error.message : '发送失败，请重试。' })
    } finally { if (epoch === this.accountGeneration) this.editComposer({ busy: false }) }
  }

  async attach(files: File[]): Promise<void> {
    const epoch = this.accountGeneration
    if (!files.length || this.modelSwitch.get().saving) return
    const blocked = attachmentBlockReason({ busy: this.composer.get().busy, running: this.conversation.get().running,
      loading: this.navigation.get().loading, preparing: this.preparing.get(), connection: this.connection.get() })
    if (blocked) { this.conversation.set({ ...this.conversation.get(), error: blocked }); return }
    this.editComposer({ busy: true })
    try {
      // 整批先校验，避免拖入混合文件时只上传了前半批。
      for (const file of files) {
        if (!isSupportedFile(file.name)) throw new Error('支持 TXT、MD、DOCX、XLSX、XLS、XLSM、CSV、PDF，以及 PNG、JPG、WebP 图片。')
        if (!file.size) throw new Error('文件为空，请重新选择。')
        if (file.size > (isImageFile(file.name) ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES)) throw new Error(isImageFile(file.name) ? '单张图片请控制在 4 MB 以内。' : '单个原稿请控制在 20 MB 以内。')
      }
      if ([...this.composer.get().attachments, ...files].filter(file => isImageFile(file.name)).length > IMAGE_MAX_COUNT) throw new Error('每条消息最多添加 4 张图片。')
      for (const file of files) {
        const session = await this.ensureSession()
        if (epoch !== this.accountGeneration) return
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('读取原稿失败。'))
          reader.readAsDataURL(file)
        })
        if (epoch !== this.accountGeneration) return
        const result = await this.api.rpc('file.attach', { profile: this.api.profile, session_id: session.runtimeId, data_url: dataUrl, name: file.name })
        if (epoch !== this.accountGeneration) return
        if (!result.attached) throw new Error('原稿未能添加到工作区。')
        this.editComposer({ attachments: [...this.composer.get().attachments, result] })
      }
      this.conversation.set({ ...this.conversation.get(), error: '' })
    } catch (error) {
      if (epoch !== this.accountGeneration) return
      this.conversation.set({ ...this.conversation.get(), error: error instanceof Error ? error.message : '上传原稿失败。' })
    } finally { if (epoch === this.accountGeneration) this.editComposer({ busy: false }) }
  }

  async interrupt(): Promise<void> {
    const epoch = this.accountGeneration
    const current = this.conversation.get()
    if (current.turn?.state === 'running') this.conversation.set({ ...current, turn: { ...current.turn, stopRequested: true, status: '正在停止当前任务' } })
    try { await this.api.rpc('session.interrupt', { session_id: this.session.get().runtimeId, profile: this.api.profile }) }
    catch { if (epoch === this.accountGeneration) this.conversation.set({ ...this.conversation.get(), error: '停止请求未确认，请检查连接。' }) }
  }

  private cancelStreamEvents() {
    if (this.streamFlushTimer !== null) {
      clearTimeout(this.streamFlushTimer)
      this.streamFlushTimer = null
    }
    this.pendingStreamEvents = []
  }

  private flushStreamEvents() {
    if (this.streamFlushTimer !== null) {
      clearTimeout(this.streamFlushTimer)
      this.streamFlushTimer = null
    }
    if (!this.pendingStreamEvents.length) return
    const events = this.pendingStreamEvents
    this.pendingStreamEvents = []
    let next = this.conversation.get()
    for (const event of events) next = reduceEvent(next, event)
    if (next !== this.conversation.get()) this.conversation.set(next)
  }

  private applyEvent(event: StudioEvent) {
    this.activity.scope(this.api.profile)
    this.activity.observe(event, this.session.get(), document.visibilityState !== 'hidden', this.conversation.get().asyncPending ?? 0)
    this.conversation.set(reduceEvent(this.conversation.get(), event))
    if (event.type === 'request.cancel') this.requests.set(this.requests.get().filter(request => request.id !== event.payload.id))
    if (['message.complete', 'session.title', 'background.complete', 'subagent.complete'].includes(event.type)) {
      void this.synchronize({ materials: event.session_id === this.session.get().runtimeId }).catch(() => {})
    }
    if (event.session_id !== this.session.get().runtimeId) return
    if (event.type === 'session.info') this.session.set({ ...this.session.get(), info: event.payload as SessionLiveInfo })
    if (event.type === 'tool.complete') {
      const project = projectFromResult(event.payload.result ?? event.payload.result_text)
      if (project && projectMatchesSelection(project, conversationSelection(this.conversation.get().entries))) this.project.set(mergeProjectArtifacts(project, this.project.get()))
    }
    if (event.type === 'session.title') {
      const id = this.session.get().storedId, title = String(event.payload.title)
      const pending = this.pendingSessions.get(id)
      if (pending) this.pendingSessions.set(id, { ...pending, title })
      this.navigation.set({ ...this.navigation.get(), sessions: this.navigation.get().sessions.map(row => row.id === id ? { ...row, title } : row) })
    }
  }

  receive(event: StudioEvent) {
    if (event.type === 'message.delta') {
      this.pendingStreamEvents.push(event)
      if (this.streamFlushTimer === null) this.streamFlushTimer = setTimeout(() => this.flushStreamEvents(), 32)
      return
    }
    // 完成、工具和错误事件必须先消费所有已排队正文，保持原有事件顺序。
    this.flushStreamEvents()
    this.applyEvent(event)
  }

  receiveRequest(request: ServerRequest): boolean {
    if (!['approval', 'clarify'].includes(request.method)) return false
    const key = request.params.pattern_key
    // 旧连接仍可能重放未经展示投影的管理员请求；这些技术权限不交给编剧确认。
    const rawApproval = request.method === 'approval' && (key !== undefined || request.params.command !== undefined)
    if (rawApproval && (typeof key !== 'string' || !/^plugin_rule:jubao-drama:[a-f0-9]{32}$/.test(key)
      || Array.isArray(request.params.pattern_keys) && request.params.pattern_keys.some(value => value !== key))) {
      request.respond({ choice: 'deny' })
      return true
    }
    this.requests.set([...this.requests.get().filter(item => item.id !== request.id), request])
    return true
  }

  answer(request: ServerRequest, result: Record<string, unknown>) {
    if (!this.requests.get().includes(request) || request.params.session_id !== this.session.get().runtimeId) return
    request.respond(result)
    this.requests.set(this.requests.get().filter(item => item.id !== request.id))
  }
}

export const workspace = new Workspace(gateway, {
  load: loadSidebar,
  selected: () => $selectedSidebarProjectId.get(),
  select: selectSidebarProject,
  owner: sidebarSessionProjectId,
  attach: (sessionId, projectId) => patchSidebarSession(sessionId, { projectId })
}, () => $currentUser.get()?.role)
gateway.onAny(event => workspace.receive(event as StudioEvent))
gateway.onState(state => {
  const previous = workspace.connection.get()
  workspace.connection.set(state)
  if (state === 'open') {
    const navigation = workspace.navigation.get()
    workspace.navigation.set(clearConnectionErrorOnOpen(state, navigation))
  }
  if (previous === 'open' && (state === 'closed' || state === 'error')) {
    const current = workspace.conversation.get()
    if (current.turn?.state === 'running') workspace.conversation.set({ ...current, turn: { ...current.turn, transportInterrupted: true } })
    workspace.navigation.set({ ...workspace.navigation.get(), error: CONNECTION_LOST_ERROR })
  }
})
gateway.onRequest(request => workspace.receiveRequest(request))

let connectingWorkspace: Promise<void> | null = null

export function connectWorkspace(): Promise<void> {
  if (connectingWorkspace) return connectingWorkspace
  const operation = restoreWorkspaceConnection().finally(() => { if (connectingWorkspace === operation) connectingWorkspace = null })
  connectingWorkspace = operation
  return operation
}

async function restoreWorkspaceConnection() {
  const epoch = workspace.accountEpoch
  const selected = workspace.session.get()
  workspace.startup.set({ history: true, models: true })
  try {
    if (await gateway.start() && epoch === workspace.accountEpoch) {
      await gateway.sessionReplayBarrier(selected.runtimeId)
      await workspace.initialize(!selected.storedId)
      if (selected.storedId && epoch === workspace.accountEpoch && workspace.session.get().storedId === selected.storedId) await workspace.open(selected.storedId, { background: true })
    }
  }
  catch (error) {
    if (epoch === workspace.accountEpoch) {
      workspace.startup.set({ history: false, models: false })
      workspace.navigation.set({ ...workspace.navigation.get(), loading: false, error: error instanceof Error ? error.message : '连接失败，请重试。' })
    }
  }
}

export function disconnectWorkspace() {
  connectingWorkspace = null
  gateway.stop()
  workspace.reset()
}
