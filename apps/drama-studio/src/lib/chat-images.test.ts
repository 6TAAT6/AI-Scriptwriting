import { expect, test } from 'vitest'
import { Workspace, type WorkspaceApi } from '../store/workspace'
import { historyEntries, reduceEvent, restoreToolReceipts, type Conversation } from './transcript'
import { historySources } from './creative'

test('每轮依据当前问题判断任务，聊天和生图请求不会被旧任务模式改写', async () => {
  let prompt = ''
  const workspace = new Workspace({ profile: 'chat', materials: async () => ({ project: null, sources: [] }), rpc: (async (method, params) => {
    if (method === 'session.create') return { session_id: 'live', stored_session_id: 'stored', info: {}, messages: [] }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'prompt.submit') { prompt = String((params as { text: string }).text); return { accepted: true } }
    return {}
  }) as WorkspaceApi['rpc'] })
  workspace.editComposer({ text: '你好，请解释一下什么是景别。', ...{ mode: 'full' } })
  await workspace.send()
  expect(prompt).toContain('普通问答、闲聊')
  expect(prompt).not.toContain('本次任务：完整改编')
  expect(prompt.endsWith('你好，请解释一下什么是景别。')).toBe(true)
  workspace.conversation.set({ ...workspace.conversation.get(), running: false })
  workspace.editComposer({ text: '请生成一张海边日落的图片。' })
  await workspace.send()
  expect(prompt.endsWith('请生成一张海边日落的图片。')).toBe(true)
  expect(prompt).not.toContain('本次任务：')
  expect(prompt).not.toContain('本轮请求生成图片。请使用生图工具')
})

test('图片回执实时与历史均生成相同可下载资料，外部地址不进入图片组件', () => {
  let state: Conversation = { runtimeId: 'live', entries: [], running: true, error: '' }
  const receipt = { success: true, image: '/assets-data/fixture/生成图.png' }
  state = reduceEvent(state, { session_id: 'live', type: 'tool.complete', payload: { name: 'image_generate', tool_id: 'image', result: receipt } })
  expect(state.entries[0].calls[0].image).toBe(receipt.image)
  expect(historyEntries([{ role: 'tool', name: 'image_generate', tool_call_id: 'image', content: JSON.stringify(receipt) }])[0].calls[0].image).toBe(receipt.image)
  expect(historyEntries([{ role: 'tool', name: 'image_generate', content: JSON.stringify({ success: true, image: 'https://external.invalid/a.png' }) }])[0].calls[0].image).toBeUndefined()
  const compact = historyEntries([{ role: 'tool', name: 'image_generate', tool_call_id: 'image', content: JSON.stringify({ ok: false, error: '回执未包含图片' }) }])
  expect(restoreToolReceipts(compact, [{ id: 'image', content: receipt }])[0].calls[0]).toMatchObject({ image: receipt.image, state: 'complete' })
})

test('多轮生图通过原生桥接恢复后，每张图片仍属于原来那一轮且重复同步不会丢失', () => {
  const paths = ['/assets-data/fixture/写实.png', '/assets-data/fixture/油画.png', '/assets-data/fixture/插画.jpg']
  const messages = paths.flatMap((_path, index) => [
    { role: 'user', text: `第 ${index + 1} 轮生图` },
    { role: 'tool', name: index === 1 ? 'tool' : 'tool_call', tool_call_id: `image-${index}` },
    { role: 'assistant', text: `第 ${index + 1} 张已生成` }
  ])
  const receipts = paths.map((image, index) => ({ id: `image-${index}`, content: JSON.stringify({ success: true, image }) }))
  const restored = restoreToolReceipts(historyEntries(messages), receipts)
  for (const entries of [restored, restoreToolReceipts(restored, receipts), restoreToolReceipts(historyEntries(messages), receipts)]) {
    expect(entries.flatMap(entry => entry.calls.map(call => call.image))).toEqual(paths)
    paths.forEach((image, index) => expect(entries[index * 3 + 1].calls[0]).toMatchObject({ id: `image-${index}`, image, state: 'complete' }))
  }
})

test('重新打开含截图的聊天仍可预览附件，原生多模态内容不泄漏编码数据', () => {
  const path = '/assets-data/fixture/截图.png'
  const messages = [{ role: 'user' as const, content: [
    { type: 'text', text: '请识别截图\n@file:`' + path + '`' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE_IMAGE' } }
  ] }]
  const entries = historyEntries(messages)
  expect(entries[0].text).toBe('请识别截图')
  expect(entries[0].images).toEqual([{ path, name: '截图.png' }])
  expect(historySources(messages)).toEqual([{ id: path, name: '截图.png', path, kind: 'source' }])
  expect(JSON.stringify(entries)).not.toContain('PRIVATE_IMAGE')
  expect(historyEntries([{ role: 'user', content: '请识别截图\n@file:`' + path + '`\n[screenshot]' }])[0].text).toBe(entries[0].text)
  expect(historyEntries([{ role: 'user', content: '@file:`' + path + '`\n[screenshot]' }])[0]).toMatchObject({ text: '', images: [{ path, name: '截图.png' }] })
})
