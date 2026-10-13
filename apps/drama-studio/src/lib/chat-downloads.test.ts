import { expect, test } from 'vitest'
import { historyEntries, restoreToolReceipts, toolDownloads } from './transcript'
import type { Entry } from './transcript'
import type { Artifact } from './creative'
import { downloadsByEntry } from './chat-downloads'

test('历史回执只恢复当前调用的交付，不把项目旧导出附到当前回复', () => {
  const receipt = { path: '/assets-data/new/正文.docx', name: '第2批正文.docx', format: 'docx' }
  const content = { ok: true, receipt, project: { exports: [{ path: '/assets-data/old/旧稿.docx', format: 'docx' }] } }
  expect(toolDownloads(content)).toEqual([receipt])
  expect(toolDownloads({ project: content.project })).toEqual([])
  const entries = historyEntries([{ role: 'tool', tool_call_id: 'save', name: 'drama_agent_document', content: JSON.stringify(content) }])
  expect(entries[0].calls[0].downloads).toEqual([receipt])
  expect(restoreToolReceipts(entries, [{ id: 'save', content }])[0].calls[0].downloads).toEqual([receipt])
})

test('实时稿件仅归一化排版后匹配完整正文，真实改句与跨回合重复不猜测归属', () => {
  const content = '第04集\n\n4-1场 办公室 日 内\n\n人物：林岚、门卫\n\n△林岚推开门，把账本放在桌上。\n\n林岚：下一步，我们先核对签名。'
  const decorated = '## 第04集\n\n---\n\n**4-1场 办公室 日 内**\n\n人物：林岚、门卫\n\n△林岚推开门，把账本放在桌上。\n\n***\n\n林岚：下一步，我们先核对签名。'
  const artifact: Artifact = { id: 'script-4', name: '第04集正文', kind: 'result', documentKind: 'script', content,
    sourceMessageId: '42', downloadPath: '/assets-data/current/第04集正文.docx', downloadName: '第04集正文.docx', downloadFormat: 'docx' }
  const entries: Entry[] = [
    { id: 'u1', role: 'user', text: '先写旧版', calls: [] },
    { id: 'message-old', role: 'assistant', text: decorated.replace('我们先核对签名', '我们先离开这里'), calls: [] },
    { id: 'u2', role: 'user', text: '修改最后一句后再交付', calls: [] },
    { id: 'message-current', role: 'assistant', text: decorated, calls: [] },
    { id: 'u3', role: 'user', text: '说明人物动机', calls: [] },
    { id: 'message-next', role: 'assistant', text: '她正在追查账本的来源。', calls: [] }
  ]
  expect([...downloadsByEntry(entries, [artifact]).entries()]).toEqual([['message-current', [{
    path: '/assets-data/current/第04集正文.docx', name: '第04集正文.docx', format: 'docx', status: undefined
  }]]])
  expect(downloadsByEntry(entries.filter(entry => entry.id !== 'message-current'), [artifact]).size).toBe(0)
  const repeated: Entry[] = [...entries, { id: 'u4', role: 'user', text: '引用上一版', calls: [] },
    { id: 'message-quoted', role: 'assistant', text: content, calls: [] }]
  expect(downloadsByEntry(repeated, [artifact]).size).toBe(0)
})
