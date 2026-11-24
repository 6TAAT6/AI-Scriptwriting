import { $currentUser, type StudioUser } from '../accounts/api'
import { CAPABILITIES, type CapabilityCommand } from '../lib/capabilities'
import { $selectedSidebarProjectId } from '../lib/sidebar'
import { workspace, type ComposerState } from '../store/workspace'

interface SavedCommand { id: string; action: string }
interface SavedComposer extends Omit<ComposerState, 'busy' | 'capabilityCommands'> { capabilityCommands: SavedCommand[] }
export interface MaintenanceDraft {
  schema: 1
  userId: string
  profile: string
  savedAt: number
  storedId: string
  projectId: string | null
  submitting: boolean
  resumeAliases?: string[]
  composer: SavedComposer
}
export type DraftCaptureStatus = 'saved' | 'memory' | 'unconfirmed'
interface DraftCollection { schema: 2; userId: string; profile: string; selectedKey: string; drafts: MaintenanceDraft[] }
interface DraftCopy { data: DraftCollection | null; status: DraftCaptureStatus }

const memory = new Map<string, DraftCopy>()
const consumed = new Set<string>()
const keyFor = (user: StudioUser) => `drama-studio:maintenance-draft:v1:${JSON.stringify([user.id, user.profile])}`
const sameUser = (user: StudioUser) => $currentUser.get()?.id === user.id && $currentUser.get()?.profile === user.profile
const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum
const commands = new Set(['调用', '启用', '使用', '停用', '确认切换为'])
const recordKey = (record: MaintenanceDraft) => record.storedId || `new:${record.projectId ?? 'recent'}`
const consumedKey = (user: StudioUser, key: string) => JSON.stringify([user.id, user.profile, workspace.accountEpoch, key])
const hasContent = (draft: Pick<ComposerState, 'text' | 'attachments' | 'capabilityCommands'>) => Boolean(draft.text.trim() || draft.attachments.length || draft.capabilityCommands?.length)

function parse(value: unknown, user: StudioUser): MaintenanceDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as MaintenanceDraft, draft = row.composer
  if (row.schema !== 1 || row.userId !== user.id || row.profile !== user.profile
    || !Number.isFinite(row.savedAt) || row.savedAt < 0
    || !boundedText(row.storedId, 512) || !(row.projectId === null || boundedText(row.projectId, 512))
    || typeof row.submitting !== 'boolean' || !draft || typeof draft !== 'object'
    || row.resumeAliases !== undefined && (!Array.isArray(row.resumeAliases) || row.resumeAliases.some(id => !boundedText(id, 512)))
    || !boundedText(draft.text, 1_000_000) || !['中国', '北美', '欧美'].includes(draft.region) || !['仅中文', '中英双语'].includes(draft.language)
    || !Array.isArray(draft.attachments) || draft.attachments.length > 100
    || draft.attachments.some(file => !file || typeof file.attached !== 'boolean' || typeof file.uploaded !== 'boolean'
      || !boundedText(file.name, 240) || !boundedText(file.path, 4096) || !boundedText(file.ref_path, 4096) || !boundedText(file.ref_text, 8192))
    || !Array.isArray(draft.capabilityCommands) || draft.capabilityCommands.length > 30
    || draft.capabilityCommands.some(command => !command || !boundedText(command.id, 256) || !commands.has(command.action))
    || draft.imageModel && (!boundedText(draft.imageModel.model, 256) || !boundedText(draft.imageModel.provider, 256))
    || draft.northAmericaSelected !== undefined && typeof draft.northAmericaSelected !== 'boolean') return null
  return { schema: 1, userId: row.userId, profile: row.profile, savedAt: row.savedAt,
    storedId: row.storedId, projectId: row.projectId, submitting: row.submitting,
    ...(row.resumeAliases ? { resumeAliases: [...row.resumeAliases] } : {}),
    composer: { text: draft.text, region: draft.region, language: draft.language,
      attachments: draft.attachments.map(file => ({ attached: file.attached, uploaded: file.uploaded,
        name: file.name, path: file.path, ref_path: file.ref_path, ref_text: file.ref_text })),
      capabilityCommands: draft.capabilityCommands.map(command => ({ id: command.id, action: command.action })),
      ...(draft.imageModel ? { imageModel: { model: draft.imageModel.model, provider: draft.imageModel.provider } } : {}),
      ...(draft.northAmericaSelected !== undefined ? { northAmericaSelected: draft.northAmericaSelected } : {}) } }
}

function decode(value: unknown, user: StudioUser): DraftCollection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as DraftCollection
  if ((value as { schema?: number }).schema === 1) {
    const record = parse(value, user)
    return record ? { schema: 2, userId: user.id, profile: user.profile, selectedKey: recordKey(record), drafts: [record] } : null
  }
  if (row.schema !== 2 || row.userId !== user.id || row.profile !== user.profile || !boundedText(row.selectedKey, 1024)
    || !Array.isArray(row.drafts)) return null
  const records = row.drafts.map(record => parse(record, user))
  if (records.some(record => !record)) return null
  const drafts = records as MaintenanceDraft[]
  if (new Set(drafts.map(recordKey)).size !== drafts.length) return null
  return { schema: 2, userId: user.id, profile: user.profile, selectedKey: row.selectedKey, drafts }
}

function collection(user: StudioUser): DraftCopy {
  const key = keyFor(user), cached = memory.get(key)
  if (cached) return cached
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return { data: null, status: 'saved' }
    const data = decode(JSON.parse(raw), user)
    return { data, status: data ? 'saved' : 'unconfirmed' }
  } catch { return { data: null, status: 'unconfirmed' } }
}

export function hasMaintenanceDrafts(user: StudioUser): boolean {
  return sameUser(user) && Boolean(collection(user).data?.drafts.some(record => parse(record, user)))
}

function saveCollection(user: StudioUser, data: DraftCollection, canPersist: boolean): DraftCaptureStatus {
  const key = keyFor(user), copy: DraftCopy = { data, status: canPersist ? 'memory' : 'unconfirmed' }
  memory.set(key, copy)
  if (!canPersist) return copy.status
  try { sessionStorage.setItem(key, JSON.stringify(data)); copy.status = 'saved' }
  catch { copy.status = 'memory' }
  return copy.status
}

/** 只保存本账号的输入和已上传文件引用，不复制凭据、附件正文或正在执行的状态。 */
export function captureMaintenanceDraft(user: StudioUser): DraftCaptureStatus {
  if (!sameUser(user) || workspace.api.profile && workspace.api.profile !== user.profile) return 'unconfirmed'
  if (!workspace.api.profile && (workspace.session.get().storedId || workspace.session.get().runtimeId)) return 'unconfirmed'
  const previous = collection(user), snapshot = workspace.maintenanceDraftSnapshot()
  if (!snapshot.drafts.length && !snapshot.aliases.length) return previous.status
  const records = new Map((previous.data?.drafts || []).filter(record => parse(record, user)).map(record => [recordKey(record), record]))
  const cleared = new Set(snapshot.drafts.filter(row => !hasContent(row.composer)).map(row => row.key))
  const aliases = [...snapshot.aliases, ...[...records.values()].flatMap(record => (record.resumeAliases || []).map(from => ({ from, to: record.storedId })))]
  let expanded = true
  while (expanded) {
    expanded = false
    for (const alias of aliases) if (cleared.has(alias.from) || cleared.has(alias.to)) {
      if (!cleared.has(alias.from)) { cleared.add(alias.from); expanded = true }
      if (!cleared.has(alias.to)) { cleared.add(alias.to); expanded = true }
    }
  }
  for (const key of cleared) { records.delete(key); consumed.delete(consumedKey(user, key)) }
  for (const alias of snapshot.aliases) {
    const matches = [...records.entries()].filter(([, record]) => record.storedId === alias.from || record.resumeAliases?.includes(alias.from))
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    for (const [key, record] of matches) {
      if (key === alias.to || records.has(alias.to)) continue
      records.set(alias.to, { ...record, storedId: alias.to, resumeAliases: [...new Set([...(record.resumeAliases || []), record.storedId, alias.from])] })
      records.delete(key)
    }
  }
  for (const row of snapshot.drafts) {
    consumed.delete(consumedKey(user, row.key))
    const current = row.composer
    if (cleared.has(row.key)) continue
    const resumeAliases = [...new Set([...(records.get(row.key)?.resumeAliases || []), ...snapshot.aliases.filter(alias => alias.to === row.key).map(alias => alias.from)])]
    const record: MaintenanceDraft = {
      schema: 1, userId: user.id, profile: user.profile, savedAt: Date.now(), storedId: row.storedId, projectId: row.projectId, submitting: current.busy,
      ...(resumeAliases.length ? { resumeAliases } : {}),
      composer: { text: current.text, region: current.region, language: current.language,
        attachments: current.attachments.map(file => ({ attached: file.attached, uploaded: file.uploaded, name: file.name,
          path: file.path, ref_path: file.ref_path, ref_text: `@file:\`${file.ref_path || file.path}\`` })),
        capabilityCommands: (current.capabilityCommands || []).map(command => ({ id: command.capability.id, action: command.action })),
        ...(current.imageModel ? { imageModel: { model: current.imageModel.model, provider: current.imageModel.provider } } : {}),
        ...(current.northAmericaSelected !== undefined ? { northAmericaSelected: current.northAmericaSelected } : {}) }
    }
    if (!parse(record, user)) return 'unconfirmed'
    records.set(row.key, record)
  }
  const data: DraftCollection = { schema: 2, userId: user.id, profile: user.profile,
    selectedKey: records.has(snapshot.selectedKey) ? snapshot.selectedKey : previous.data?.selectedKey || snapshot.selectedKey, drafts: [...records.values()] }
  return saveCollection(user, data, previous.status !== 'unconfirmed')
}

export function readMaintenanceDraft(user: StudioUser): MaintenanceDraft | null {
  if (!sameUser(user)) return null
  const data = collection(user).data
  if (!data) return null
  const records = data.drafts.filter(record => parse(record, user) && !consumed.has(consumedKey(user, recordKey(record))))
  const selected = workspace.maintenanceDraftSnapshot().selectedKey
  return records.find(record => recordKey(record) === selected) || records.find(record => recordKey(record) === data.selectedKey) || records[0] || null
}

/** 员工明确不要这份维护前草稿：只删这一条，提示随之消失；其他对话保留的草稿不受影响。 */
export function discardMaintenanceDraft(user: StudioUser, record: MaintenanceDraft): boolean {
  if (!sameUser(user)) return false
  const previous = collection(user)
  if (!previous.data) return false
  const key = recordKey(record)
  const drafts = previous.data.drafts.filter(row => recordKey(row) !== key)
  if (drafts.length === previous.data.drafts.length) return false
  consumed.delete(consumedKey(user, key))
  if (drafts.length) {
    const selectedKey = drafts.some(row => recordKey(row) === previous.data!.selectedKey) ? previous.data.selectedKey : recordKey(drafts[0])
    saveCollection(user, { ...previous.data, selectedKey, drafts }, previous.status !== 'unconfirmed')
    return true
  }
  const storageKey = keyFor(user)
  try { sessionStorage.removeItem(storageKey); memory.set(storageKey, { data: null, status: 'saved' }) }
  catch { memory.set(storageKey, { data: null, status: 'memory' }) }
  return true
}

/** 恢复只写输入框；原对话必须已经选中，不会发请求或重放上一次提交。 */
export function matchesMaintenanceDraft(record: MaintenanceDraft): boolean {
  const selected = workspace.session.get().storedId
  return selected === record.storedId && (Boolean(selected) || $selectedSidebarProjectId.get() === record.projectId)
}

export function restoreMaintenanceDraft(user: StudioUser): boolean {
  const record = readMaintenanceDraft(user)
  if (!record || workspace.api.profile !== user.profile || !matchesMaintenanceDraft(record)) return false
  const current = workspace.composer.get()
  if (current.busy || current.text.trim() || current.attachments.length || current.capabilityCommands?.length) return false
  const capabilityCommands = record.composer.capabilityCommands.flatMap(command => {
    const capability = CAPABILITIES.find(row => row.id === command.id)
    return capability ? [{ action: command.action, capability } satisfies CapabilityCommand] : []
  })
  workspace.restoreComposerDraft({ ...record.composer, capabilityCommands, busy: false })
  // 恢复不删除持久副本；只有明确清空、删除或提交确认才撤掉对应记录，刷新仍可找回未发内容。
  consumed.add(consumedKey(user, recordKey(record)))
  return true
}
