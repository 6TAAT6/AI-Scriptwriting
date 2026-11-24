import catalog from '../../../../extensions/jubao-drama/capabilities.json'

export interface Capability { id: string; kind: string; skill: string; display_name: string; label: string; aliases: string; description: string; legacy_names?: string[]; environment_badge?: string; hidden?: boolean; own_protocol?: boolean; host_tools?: string[]; protocol_rule?: string; default_script_length?: { minimum: number; maximum: number }; length_report?: string; length_revision?: boolean }
export interface CapabilityCommand { action: string; capability: Capability }
export interface CapabilityOperation { id: string; action: 'enable' | 'disable' }
export interface CapabilitySelection { agent?: string; skills: string[] }
export const CAPABILITIES: Capability[] = catalog
export const SELECTABLE_CAPABILITIES = CAPABILITIES.filter(row => !row.hidden)
export const SCRIPT_AGENTS = CAPABILITIES.filter(row => row.kind === 'agent')

function commandAtStart(text: string): { command: CapabilityCommand; length: number } | undefined {
  const prefix = text.match(/^\s*(?:请\s*)?(调用|启用|使用|停用|确认切换为)\s*/)
  if (!prefix) return
  const remainder = text.slice(prefix[0].length)
  for (const capability of CAPABILITIES) {
    for (const name of [capability.display_name, ...(capability.legacy_names ?? [])]) {
      if (!remainder.startsWith(name)) continue
      const tail = remainder.slice(name.length)
      if (!/^(?:$|[\s。.!！;；,，:：])/.test(tail)) continue
      const clause = tail.split(/[。.!！;；\n]/, 1)[0].replace(/^[\s,，:：]+/, '')
      if (/^(?:[?？]|吗|么|呢|是否|能否|可否|可以吗|要不要|是不是|好不好|怎么样|如何|怎么|是什么|示例|例子|(?:只是|仅为)(?:一个)?(?:示例|例子)|(?:请\s*)?(?:不要|不用|不必|别)(?:真的|实际|再)?(?:启用|调用|使用|切换))/.test(clause)) continue
      const action = prefix[1] === '使用' ? '调用' : prefix[1]
      return { command: { action, capability }, length: prefix[0].length + name.length }
    }
  }
}

export function splitCapabilityDraft(text: string) {
  const commands: CapabilityCommand[] = []
  let body = text
  for (let found = commandAtStart(body); found; found = commandAtStart(body)) {
    commands.push(found.command)
    body = body.slice(found.length).trimStart()
  }
  return { commands, body }
}

export function composerCapabilityDraft(text: string, selected: CapabilityCommand[] = []) {
  const draft = splitCapabilityDraft(text)
  const commands = new Map(selected.map(command => [command.capability.id, command]))
  for (const command of draft.commands) commands.set(command.capability.id, command)
  return { body: draft.body, commands: [...commands.values()] }
}

export function capabilityOperations(commands: CapabilityCommand[]): CapabilityOperation[] {
  return commands.map(({ action, capability }) => ({ id: capability.id, action: action === '停用' ? 'disable' : 'enable' }))
}

function capabilityMessageBody(text: string): string {
  const marker = '\n\n【用户本轮消息】\n'
  const body = text.startsWith('【本轮语言偏好】\n') && text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text
  return body.split(/\n\n--- (?:Attached Context|Context Warnings) ---/, 1)[0]
}

export function savedCapabilityCommands(text: string): CapabilityCommand[] | undefined {
  if (!text.startsWith('【本轮语言偏好】\n')) return
  const prefix = text.split('\n\n【用户本轮消息】\n')[0]
  const match = prefix.match(/\n【本轮能力操作】\n([^\n]+)(?:\n|$)/)
  if (!match) return
  try {
    const values = JSON.parse(match[1])
    if (!Array.isArray(values) || values.length > CAPABILITIES.length || values.some(value => !value ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'action') ||
      !['enable', 'disable'].includes(value.action) || !CAPABILITIES.some(row => row.id === value.id))) return []
    // 旧客户端将未识别的明确调用保存为空操作，恢复时仍只读取原始用户正文。
    return values.length ? values.map(value => ({ action: value.action === 'disable' ? '停用' : '调用', capability: CAPABILITIES.find(row => row.id === value.id)! }))
      : splitCapabilityDraft(capabilityMessageBody(text)).commands
  } catch { return [] }
}

export function capabilityCommands(text: string): CapabilityCommand[] {
  const saved = savedCapabilityCommands(text)
  if (saved) return saved
  return splitCapabilityDraft(capabilityMessageBody(text)).commands
}

export function selectionAfter(current: CapabilitySelection, text: string, explicitCommands?: CapabilityCommand[]): CapabilitySelection {
  const commands = explicitCommands ?? capabilityCommands(text)
  const mains = commands.filter(row => row.capability.kind === 'agent' && row.action !== '停用')
  if (new Set(mains.map(row => row.capability.id)).size > 1) return current
  let agent = current.agent
  for (const command of commands) if (command.action === '停用' && command.capability.id === agent) agent = undefined
  const next = mains.at(-1)
  if (next) agent = next.capability.id
  const skills = new Set(current.skills)
  for (const { action, capability } of commands.filter(row => row.capability.kind === 'skill')) {
    if (action === '停用') skills.delete(capability.id)
    else skills.add(capability.id)
  }
  return { ...(agent ? { agent } : {}), skills: [...skills] }
}

export function conversationSelection(entries: { role: string; text: string; capabilities?: CapabilitySelection }[]): CapabilitySelection {
  return entries.reduce<CapabilitySelection | undefined>((current, entry) => entry.role === 'user'
    ? entry.capabilities ?? savedCapabilitySelection(entry.text, current) ?? selectionAfter(current ?? { skills: [] }, entry.text)
    : current, undefined) ?? { skills: [] }
}

export function savedCapabilitySelection(raw: string, current?: CapabilitySelection): CapabilitySelection | undefined {
  if (!raw.startsWith('【本轮语言偏好】\n')) return
  const commands = savedCapabilityCommands(raw)
  // 已知的停用状态也是有效基线，后续旧显示快照不能重新启用能力。
  if (current !== undefined) return selectionAfter(current, raw, commands)
  const prefix = raw.split('\n\n【用户本轮消息】\n')[0]
  const saved = prefix.match(/\n【本轮创作能力】\n([^\n]+)(?:\n|$)/)
  if (!saved) return
  try {
    const value = JSON.parse(saved[1])
    if (!value || !Array.isArray(value.skills) || value.skills.some((id: unknown) => !CAPABILITIES.some(row => row.kind === 'skill' && row.id === id))
      || value.agent != null && !SCRIPT_AGENTS.some(row => row.id === value.agent)) return
    const selection = { ...(value.agent ? { agent: value.agent } : {}), skills: [...new Set<string>(value.skills)] }
    // 裁剪历史的首条消息可能只有显示快照；这不作为服务端工具授权。
    return commands === undefined ? selection : selectionAfter(selection, raw, commands)
  } catch { return }
}

export function capabilitySubmissionError(current: CapabilitySelection, text: string, backgroundWork = false, commands?: CapabilityCommand[]): string {
  const mains = (commands ?? capabilityCommands(text)).filter(row => row.capability.kind === 'agent' && row.action !== '停用')
  if (new Set(mains.map(row => row.capability.id)).size > 1) return '一条消息只能选择一个主 Agent；独立技能可以叠加。'
  const next = mains.at(-1)
  if (next && current.agent && next.capability.id !== current.agent && backgroundWork) return '后台创作尚未结束，请完成后再替换主 Agent。'
  return ''
}
