import { expect, test } from 'vitest'
import { projectFromResult } from './creative'

test('把批次正文绑定到同一批次的 Word 下载回执', () => {
  const project = projectFromResult({ project: {
    id: 'project', title: '测试项目', stage: 'M3', agent_id: 'gm3-1',
    script_batches: [{ id: 'script-1', content: '第1集\n\n△她推门。', status: 'draft' }],
    exports: [{ artifact_id: 'script-1', path: '/assets-data/abc/第1批正文.docx', format: 'docx', source_kind: 'script', status: 'draft' }],
  } })

  expect(project?.artifacts).toContainEqual(expect.objectContaining({
    id: 'script-1', name: '剧本正文 · 第 1 批', content: '第1集\n\n△她推门。',
    downloadPath: '/assets-data/abc/第1批正文.docx', downloadName: '第1批正文.docx', downloadFormat: 'docx', downloadStatus: 'draft',
  }))
})
