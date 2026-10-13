import { beforeEach, expect, test } from 'vitest'
import { Workspace, type WorkspaceApi } from './workspace'
import { availableSuggestions } from '../lib/suggestions'
import { CAPABILITIES } from '../lib/capabilities'

beforeEach(() => localStorage.clear())

function setup(rpc: WorkspaceApi['rpc']) {
  const local = new Workspace({ profile: 'suggestions', rpc, materials: async () => ({ project: null, sources: [] }) })
  local.session.set({ storedId: 'stored', runtimeId: 'runtime', info: {} })
  local.connection.set('open')
  local.conversation.set({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'user', role: 'user', text: '提供改编方向', calls: [] },
    { id: 'reply', role: 'assistant', text: '请选择方案 A、B 或 C。', calls: [] }
  ] })
  return local
}

test('点击建议经普通消息链路只提交一次，正文保留完整建议且不代答确认', async () => {
  const sent: string[] = []
  let finish!: (value: unknown) => void
  const local = setup(((method, params) => {
    expect(method).toBe('prompt.submit')
    sent.push(String((params as { text: string }).text))
    return new Promise<unknown>(resolve => { finish = resolve })
  }) as WorkspaceApi['rpc'])
  const choice = availableSuggestions(local.conversation.get())!.suggestions[0]
  const pending = local.sendSuggestedReply('reply', choice.prompt)
  await Promise.resolve(); await Promise.resolve()
  expect(await local.sendSuggestedReply('reply', choice.prompt)).toBe(false)
  expect(sent).toHaveLength(1)
  expect(sent[0].endsWith(choice.prompt)).toBe(true)
  expect(local.conversation.get().entries.at(-1)?.text).toBe(choice.prompt)
  finish({ accepted: true })
  await pending
  expect(local.composer.get().text).toBe('')
})

test('填入编辑保留草稿和附件，断线、待确认及过期选项不能快捷发送', async () => {
  const local = setup(() => { throw new Error('编辑建议不得调用后端') })
  const choice = availableSuggestions(local.conversation.get())!.suggestions[1]
  const attachment = { attached: true, name: '原稿.txt', path: '/fixture/source', ref_path: '/fixture/source', ref_text: '@file:/fixture/source', uploaded: true }
  local.editComposer({ text: '这是我自己的修改意见。', attachments: [attachment] })
  expect(await local.sendSuggestedReply('reply', choice.prompt)).toBe(false)
  expect(local.editSuggestedReply('reply', choice.prompt)).toBe(true)
  expect(local.composer.get().text).toBe('这是我自己的修改意见。\n\n' + choice.prompt)
  expect(local.composer.get().attachments).toEqual([attachment])
  local.editComposer({ text: '', attachments: [] })
  local.connection.set('closed')
  expect(await local.sendSuggestedReply('reply', choice.prompt)).toBe(false)
  local.connection.set('open')
  local.requests.set([{ id: 'gate', method: 'approval', params: { session_id: 'runtime' }, respond: () => { throw new Error('不能代答') }, fail: () => {} }])
  expect(await local.sendSuggestedReply('reply', choice.prompt)).toBe(false)
  local.requests.set([])
  local.conversation.set({ runtimeId: 'another', running: false, error: '', entries: [] })
  expect(local.editSuggestedReply('reply', choice.prompt)).toBe(false)
  expect(local.composer.get().text).toBe('')
})

test('待发送的 Agent 操作也算草稿，建议不能绕过能力选择直接提交', async () => {
  const local = setup(() => { throw new Error('能力操作未确认时不应提交建议') })
  const choice = availableSuggestions(local.conversation.get())!.suggestions[0]
  const capability = CAPABILITIES.find(row => row.id === 'gm3-1')!
  local.editComposer({ capabilityCommands: [{ action: '调用', capability }] })

  expect(await local.sendSuggestedReply('reply', choice.prompt)).toBe(false)
  expect(local.composer.get().capabilityCommands).toHaveLength(1)
})
