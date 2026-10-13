import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptMessage } from '../../../shared/src/gateway-contract.generated'
import { Workspace, type WorkspaceApi } from './workspace'
import { buildLanguageAwarePrompt } from '../lib/prompt-language'
import { conversationSelection } from '../lib/capabilities'

const legacy = (region: string, language: string, body = '继续当前剧本') => `【本轮语言偏好】\n默认所有回复、进度说明、确认问题、剧本、台词和审稿文案使用简体中文。${language === '中英双语' ? '用户已在创作设置中明确选择中英双语台词，台词按此选择生成；本轮消息中的明确语言要求优先。' : '当前创作设置为仅中文；历史项目或规则包中的默认双语不代表用户本轮要求双语。'}\n创作故事时的地区偏好为${region}，仅在本轮涉及故事创作且用户没有另行指定时使用。\n【本轮创作能力】\n{"agent":"gm3-1","skills":[]}\n【本轮能力操作】\n[]\n\n【用户本轮消息】\n${body}`
function fixture(profile = 'account-a', histories: Record<string, TranscriptMessage[]> = {}, aliases: Record<string, string> = {}) {
  const submitted: Record<string, unknown>[] = []
  const workspace = new Workspace({ profile, materials: async () => ({ project: null, sources: [] }), rpc: (async (method, params) => {
    if (method === 'session.resume') {
      const id = String((params as { session_id: string }).session_id)
      return { session_id: `runtime-${aliases[id] ?? id}`, stored_session_id: aliases[id] ?? id, messages: histories[id] ?? [], message_count: histories[id]?.length ?? 0, running: false,
        info: { model: 'saved-model', provider: 'saved-provider', reasoning_effort: 'high' } }
    }
    if (method === 'prompt.submit') { submitted.push(params as Record<string, unknown>); return { status: 'streaming' } }
    if (method === 'session.create') return { session_id: 'runtime-created', stored_session_id: 'created', messages: [], message_count: 0, info: {} }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'session.events.since') return { events: [], open_requests: [] }
    throw new Error(`偏好恢复不应调用 ${method}`)
  }) as WorkspaceApi['rpc'] })
  return { workspace, submitted }
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it('会话手选偏好跨刷新持续，账号与对话隔离且不重设已有模型思考或Agent', async () => {
  const histories = { A: [{ role: 'user', text: legacy('中国', '仅中文'), timestamp: 10 }] }
  const first = fixture('account-a', histories)
  await first.workspace.open('A')
  first.workspace.editComposer({ region: '欧美', language: '中英双语', imageModel: { model: 'image-a', provider: 'images' } })
  first.workspace.reset()
  const restored = fixture('account-a', histories)
  await restored.workspace.open('A')
  expect(restored.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语', imageModel: { model: 'image-a', provider: 'images' } })
  expect(restored.workspace.session.get().info).toMatchObject({ model: 'saved-model', provider: 'saved-provider', reasoning_effort: 'high' })
  expect(conversationSelection(restored.workspace.conversation.get().entries).agent).toBe('gm3-1')
  restored.workspace.editComposer({ text: '继续下一集' })
  await restored.workspace.send()
  expect(restored.submitted[0]).toMatchObject({ image_model: 'image-a', image_provider: 'images' })
  expect(restored.submitted[0].text).toContain('地区偏好为欧美')
  expect(restored.submitted[0].text).toContain('明确选择中英双语台词')
  await restored.workspace.open('B')
  expect(restored.workspace.composer.get()).toMatchObject({ region: '中国', language: '仅中文', imageModel: undefined })
  await restored.workspace.open('A')
  expect(restored.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语' })
  const otherAccount = fixture('account-b')
  await otherAccount.workspace.open('A')
  expect(otherAccount.workspace.composer.get()).toMatchObject({ region: '中国', language: '仅中文', imageModel: undefined })
  const aliases: Record<string, string> = {}
  const compressed = fixture('compressed-owner', histories, aliases)
  await compressed.workspace.open('A')
  compressed.workspace.editComposer({ region: '欧美', language: '中英双语' })
  aliases.A = 'A2'
  await compressed.workspace.open('A', { background: true })
  const resumedCompression = fixture('compressed-owner', histories, aliases)
  await resumedCompression.workspace.open('A2')
  expect(resumedCompression.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语' })
  resumedCompression.workspace.editComposer({ language: '仅中文' })
  const oldAlias = fixture('compressed-owner', histories, aliases)
  await oldAlias.workspace.open('A')
  expect(oldAlias.workspace.composer.get()).toMatchObject({ region: '欧美', language: '仅中文' })
  const draft = fixture('draft-owner')
  draft.workspace.editComposer({ region: '欧美', language: '中英双语', imageModel: { model: 'image-a', provider: 'images' } })
  const refreshedDraft = fixture('draft-owner')
  expect(refreshedDraft.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语', imageModel: { model: 'image-a', provider: 'images' } })
  refreshedDraft.workspace.editComposer({ text: '开始新故事' })
  await refreshedDraft.workspace.send()
  const created = fixture('draft-owner')
  await created.workspace.open('created')
  expect(created.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语', imageModel: { model: 'image-a', provider: 'images' } })
})

it('仅从本会话真实标准历史恢复偏好，忽略旧压缩副本并明确提示保存失败', async () => {
  const old = legacy('中国', '仅中文')
  const current = legacy('欧美', '中英双语')
  const histories = { A: [
    { role: 'user', text: old, timestamp: 100, row_id: 1 },
    { role: 'user', content: current, timestamp: 200, row_id: 2 },
    { role: 'user', text: old, timestamp: 100, row_id: 100 },
    { role: 'assistant', text: old, timestamp: 300 },
    { role: 'user', text: old, timestamp: 400, _compressed_summary: true },
    { role: 'user', text: '引用：\n' + old, timestamp: 500 },
    { role: 'user', text: old, timestamp: 600, display_kind: 'auto_continue' }
  ] }
  const { workspace, submitted } = fixture('account-a', histories)
  await workspace.open('A')
  expect(workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语' })
  workspace.editComposer({ text: '继续下一集' })
  await workspace.send()
  expect(submitted[0].text).toContain('地区偏好为欧美')
  workspace.editComposer({ language: '仅中文' })
  const restored = fixture('account-a', histories)
  await restored.workspace.open('A')
  expect(restored.workspace.composer.get().language).toBe('仅中文')
  const settingKey = Object.keys(localStorage).find(key => key.includes('preferences'))!
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes('preferences')) throw new DOMException('容量不足', 'QuotaExceededError')
    return setItem.call(this, key, value)
  })
  restored.workspace.editComposer({ language: '中英双语' })
  expect(restored.workspace.composer.get().language).toBe('中英双语')
  expect(restored.workspace.preferenceError.get()).toContain('未保存')
  expect(restored.workspace.canAutoUpdate).toBe(false)
  expect(localStorage.getItem(settingKey)).toContain('仅中文')
  vi.restoreAllMocks()
  const durableDraft = fixture('quota-draft')
  durableDraft.workspace.editComposer({ region: '欧美', language: '中英双语' })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes('preferences') && key.includes('\"session\"')) throw new DOMException('容量不足', 'QuotaExceededError')
    return setItem.call(this, key, value)
  })
  await durableDraft.workspace.ensureSession()
  expect(durableDraft.workspace.preferenceError.get()).toContain('未保存')
  const preservedDraft = fixture('quota-draft')
  expect(preservedDraft.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语' })
  vi.restoreAllMocks()
  const structured = fixture('new-history', { A: [{ role: 'user', text: buildLanguageAwarePrompt('继续', '中英双语', '欧美'), timestamp: 10 }] })
  await structured.workspace.open('A')
  expect(structured.workspace.composer.get()).toMatchObject({ region: '欧美', language: '中英双语' })
})
