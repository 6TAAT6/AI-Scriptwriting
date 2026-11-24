import { expect, it } from 'vitest'
import { transcriptBlocks, transcriptBlocksIncremental } from './transcript-blocks'
import type { Entry } from './transcript'

function entry(id: string, role: Entry['role'], text: string, pending = false): Entry {
  return { id, role, text, calls: [], ...(pending ? { pending: true } : {}) }
}

it('流式更新只重算当前用户轮次，结果与完整历史分组一致', () => {
  const initial: Entry[] = [
    entry('u1', 'user', '第一轮'), entry('a1', 'assistant', '第一轮回复'),
    entry('u2', 'user', '第二轮'), entry('a2', 'assistant', '正在写', true)
  ]
  const previous = transcriptBlocks(initial)
  const updated = [...initial.slice(0, -1), entry('a2', 'assistant', '正在写完整正文', true)]
  const incremental = transcriptBlocksIncremental(updated, initial, previous)
  expect(incremental).toEqual(transcriptBlocks(updated))
})
